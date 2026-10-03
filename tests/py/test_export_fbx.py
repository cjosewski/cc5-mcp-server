from __future__ import annotations

import os
import re
import tempfile
import unittest
from unittest import mock

import _support


class ExportFbxTest(unittest.TestCase):
    """cc5_api.export_fbx: RStatus checks, the flags-overload fallback, and the texture-size enum."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        # export_fbx ORs RLPy flag enums together; give every one it names a real int.
        with open(os.path.join(_support.PLUGIN_DIR, "cc5_api.py"), encoding="utf-8") as f:
            names = sorted(set(re.findall(r"EExportFbxOptions\w+", f.read())))
        for i, name in enumerate(names):
            setattr(self.rl, name, 1 << (i % 30))
        self.api = _support.fresh_import("cc5_api")
        self.setting = self.rl.RExportFbxSetting.return_value
        self.export = self.rl.RFileIO.ExportFbxFile
        self.fbx = os.path.join(tempfile.mkdtemp(), "P.fbx")
        self.avatar = mock.MagicMock()
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_texture_size_is_passed_as_the_enum(self):
        self.rl.EExportTextureSize_Size_2048 = 4
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", texture_size=2048)
        self.setting.SetTextureSize.assert_called_once_with(self.rl.EExportTextureSize_Size_2048)
        self.assertEqual(r["texture_size"], 2048)

    def test_texture_size_zero_means_original(self):
        self.rl.EExportTextureSize_Original = 0
        self.api.export_fbx(self.fbx, 0, texture_size=0)
        self.setting.SetTextureSize.assert_called_once_with(self.rl.EExportTextureSize_Original)

    def test_unknown_texture_size_is_a_warning_not_a_raw_pixel_count(self):
        r = self.api.export_fbx(self.fbx, 0, texture_size=300)
        self.setting.SetTextureSize.assert_not_called()
        self.assertNotIn("texture_size", r)
        self.assertTrue(any(n.startswith("WARNING") and "300px" in n for n in r["notes"]))

    def test_error_status_from_the_settings_export_fails_without_a_2_arg_retry(self):
        self.export.return_value.IsError.return_value = True
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity")
        self.assertFalse(r["success"])
        self.assertIn("ExportFbxFile reported an error status", r["error"])
        self.assertEqual(self.export.call_count, 1)

    def test_without_fallback_a_settings_failure_fails_the_export(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertIn("requested FBX settings", r["error"])
        self.export.assert_not_called()

    def test_by_default_a_settings_failure_falls_back_to_the_flags_overload(self):
        # Live CC5 5.13 has no 2-argument ExportFbxFile(obj, path) (TypeError). Its other overload is
        # ExportFbxFile(obj, path, EExportFbxOptions, EExportFbxOptions2, EExportFbxOptions3).
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", texture_size=1024)
        self.assertTrue(r["success"])
        self.assertTrue(r["flags_applied"])
        self.export.assert_called_once()
        avatar, path, flags, flags2, flags3 = self.export.call_args.args
        self.assertEqual((path, flags, flags2, flags3), (self.fbx, r["flags"], r["flags2"], r["flags3"]))
        self.assertNotEqual(flags2, 0)  # the Unity preset bits reach CC5
        self.assertFalse(any(n.startswith("WARNING: option flags") for n in r["notes"]))
        self.assertTrue(any(n.startswith("WARNING") and "texture" in n for n in r["notes"]))
        self.assertNotIn("texture_size", r)

    def test_flags_fallback_keeps_flag_based_texture_options(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, embed_textures=True)
        self.assertTrue(r["embed_textures"])
        flags = self.export.call_args.args[2]
        self.assertTrue(flags & self.rl.EExportFbxOptions_EmbedTexture)

    def test_convert_image_format_is_refused_before_any_export(self):
        # Live CC5 5.13 (Task 18): every scripted export with Convert Image Format, with the Unity or the default
        # preset, wrote an ASCII FBX with a .json sidecar and PBR-split textures, then crashed CC5 (7 of 7).
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", convert_image_format=True)
        self.assertFalse(r["success"])
        self.assertIn("Convert Image Format", r["error"])
        self.assertIn("crash", r["error"])
        self.rl.RExportFbxSetting.assert_not_called()
        self.export.assert_not_called()

    def test_keeping_the_current_pose_clears_the_t_pose_bit(self):
        # export_for_unity's posed export (one frame of motion) depends on this to carry the pose.
        tpose = self.rl.EExportFbxOptions_TPoseOnMotionFirstFrame
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=True)
        self.assertTrue(self.setting.SetOption.call_args.args[0] & tpose)
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=True, include_current_pose=True,
                                motion_range=[0, 0])
        self.assertFalse(self.setting.SetOption.call_args.args[0] & tpose)
        self.assertEqual(r["motion_range"], [0, 0])

    def test_sub_d_level_above_the_characters_highest_level_is_refused(self):
        # Live CC5 5.13: the neutral CC3_Base_Plus reports GetMaxSubdivMeshLevel() == 0.
        self.avatar.GetMaxSubdivMeshLevel.return_value = 0
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", sub_d_level=1)
        self.assertFalse(r["success"])
        self.assertIn("highest subdivision level (0)", r["error"])
        self.export.assert_not_called()

    def test_sub_d_level_within_the_characters_levels_is_set(self):
        self.avatar.GetMaxSubdivMeshLevel.return_value = 2
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", sub_d_level=1)
        self.assertTrue(r["success"])
        self.setting.SetExportLevel.assert_called_once_with(1)
        self.assertEqual(r["export_level"], 1)

    def test_error_status_from_the_flags_fallback_fails(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        self.export.return_value.IsError.return_value = True
        r = self.api.export_fbx(self.fbx, 0)
        self.assertFalse(r["success"])
        self.assertIn("ExportFbxFile reported an error status", r["error"])


if __name__ == "__main__":
    unittest.main()

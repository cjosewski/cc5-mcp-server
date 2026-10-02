from __future__ import annotations

import os
import re
import tempfile
import unittest
from unittest import mock

import _support


class ExportFbxTest(unittest.TestCase):
    """cc5_api.export_fbx: RStatus checks, the 2-arg fallback, and the texture-size enum."""

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
        p = mock.patch.object(self.api, "get_first_avatar", return_value=mock.MagicMock())
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

    def test_by_default_a_settings_failure_falls_back_with_warnings(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity")
        self.assertTrue(r["success"])
        self.assertFalse(r["flags_applied"])
        self.export.assert_called_once_with(mock.ANY, self.fbx)
        self.assertTrue(any(n.startswith("WARNING: option flags") for n in r["notes"]))

    def test_error_status_from_the_2_arg_fallback_fails(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        self.export.return_value.IsError.return_value = True
        r = self.api.export_fbx(self.fbx, 0)
        self.assertFalse(r["success"])
        self.assertIn("ExportFbxFile reported an error status", r["error"])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class ExportForUnityTest(unittest.TestCase):
    def setUp(self):
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.root = tempfile.mkdtemp()
        self.assets = os.path.join(self.root, "MyGame", "Assets", "Characters")

    def test_rejects_folder_outside_assets(self):
        r = self.pipe.export_for_unity(os.path.join(self.root, "Elsewhere"), "Patient_01")
        self.assertFalse(r["success"])
        self.assertIn("Assets", r["error"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "Elsewhere")))

    def test_rejects_network_path(self):
        r = self.pipe.export_for_unity("//fileserver/share/Game/Assets/Characters", "P")
        self.assertFalse(r["success"])
        self.assertIn("UNC", r["error"])

    def test_rejects_unsafe_name(self):
        for name in ("Patient 01!", "Patient 01", "Пациент_01", "Patiënt", "", "Patient_01\n", "A" * 65):
            with self.subTest(name=name):
                r = self.pipe.export_for_unity(self.assets, name)
                self.assertFalse(r["success"])
                self.assertIn("letters, digits", r["error"])
                self.assertFalse(os.path.exists(self.assets))

    def test_rejects_traversal(self):
        r = self.pipe.export_for_unity(self.assets + "\\..\\..", "P")
        self.assertFalse(r["success"])

    def test_no_avatar_leaves_no_folder(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=None):
            r = self.pipe.export_for_unity(self.assets, "Patient_01")
        self.assertFalse(r["success"])
        self.assertFalse(os.path.exists(os.path.join(self.assets, "Patient_01")))

    def test_rejects_out_of_range_sub_d_level(self):
        for level in (3, -1, 99):
            with self.subTest(level=level):
                with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                        mock.patch.object(self.pipe.cc5_api, "export_fbx") as exp:
                    r = self.pipe.export_for_unity(self.assets, "Patient_01", sub_d_level=level)
                self.assertFalse(r["success"])
                self.assertIn("sub_d_level", r["error"])
                exp.assert_not_called()
                self.assertFalse(os.path.exists(os.path.join(self.assets, "Patient_01")))

    def test_rejects_unsupported_texture_size(self):
        for size in (7, 0, 300, 8192):
            with self.subTest(size=size):
                with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                        mock.patch.object(self.pipe.cc5_api, "export_fbx") as exp:
                    r = self.pipe.export_for_unity(self.assets, "Patient_01", texture_size=size)
                self.assertFalse(r["success"])
                self.assertIn("texture_size", r["error"])
                exp.assert_not_called()
                self.assertFalse(os.path.exists(os.path.join(self.assets, "Patient_01")))

    def test_exports_into_named_subfolder_with_unity_preset(self):
        def fake_export(path, flags, **kw):
            with open(path, "wb") as f:
                f.write(b"fbx")
            return {"success": True, "path": path, "flags_applied": True, "export_level": 0, "texture_size": 2048,
                    "notes": ["target_tool=Unity preset applied"]}

        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            r = self.pipe.export_for_unity(self.assets, "Patient_01", sub_d_level=0, texture_size=2048)
        self.assertTrue(r["success"])
        self.assertEqual(r["fbx"], os.path.join(self.assets, "Patient_01", "Patient_01.fbx"))
        kwargs = exp.call_args.kwargs
        self.assertEqual(kwargs["target_tool"], "Unity")
        self.assertFalse(kwargs["embed_textures"])
        self.assertFalse(kwargs["export_motion"])
        self.assertEqual(kwargs["texture_size"], 2048)
        self.assertTrue(kwargs["convert_image_format"])
        self.assertFalse(kwargs["allow_fallback"])
        self.assertEqual(r["files"][0]["bytes"], 3)
        self.assertEqual((r["export_level"], r["texture_size"]), (0, 2048))
        self.assertEqual(r["notes"], ["target_tool=Unity preset applied"])

    def _export_with(self, fake_export):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export):
            return self.pipe.export_for_unity(self.assets, "Patient_01", texture_size=2048)

    def test_fails_when_cc5_reports_success_but_writes_no_fbx(self):
        r = self._export_with(lambda path, flags, **kw: {"success": True, "flags_applied": True, "notes": []})
        self.assertFalse(r["success"])
        self.assertIn("did not write", r["error"])

    def test_fails_when_only_an_old_fbx_is_there(self):
        fbx = os.path.join(self.assets, "Patient_01", "Patient_01.fbx")
        os.makedirs(os.path.dirname(fbx))
        with open(fbx, "wb") as f:
            f.write(b"from an earlier run")
        os.utime(fbx, (1_000_000_000, 1_000_000_000))
        r = self._export_with(lambda path, flags, **kw: {"success": True, "flags_applied": True, "notes": []})
        self.assertFalse(r["success"])
        self.assertIn("did not write", r["error"])

    def test_fails_when_the_fbx_settings_were_not_applied(self):
        def fallback_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": False,
                    "notes": ["WARNING: option flags (target-tool preset / axis / etc.) were NOT applied"]}
        r = self._export_with(fallback_export)
        self.assertFalse(r["success"])
        self.assertIn("without the requested FBX settings", r["error"])
        self.assertTrue(r["notes"][0].startswith("WARNING"))

    def test_passes_export_fbx_failure_and_notes_through(self):
        r = self._export_with(lambda path, flags, **kw: {
            "success": False, "error": "ExportFbxFile reported an error status", "notes": ["n"]})
        self.assertEqual(r, {"success": False, "error": "ExportFbxFile reported an error status", "notes": ["n"]})

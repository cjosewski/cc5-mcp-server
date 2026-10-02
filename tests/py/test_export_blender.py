from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class BlenderPresetTest(unittest.TestCase):
    JSON_BIT = 1 << 30

    def setUp(self):
        import re
        self.rl = _support.install_fake_rlpy()
        # export_fbx ORs RLPy flag enums together; give every one it names a real int.
        with open(os.path.join(_support.PLUGIN_DIR, "cc5_api.py"), encoding="utf-8") as f:
            names = sorted(set(re.findall(r"EExportFbxOptions\w+", f.read())))
        for i, name in enumerate(names):
            setattr(self.rl, name, 1 << (i % 30))
        self.rl.EExportFbxOptions3_ExportJson = self.JSON_BIT
        self.api = _support.fresh_import("cc5_api")

    def test_blender_preset_note_and_json_flag(self):
        with mock.patch.object(self.api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.api.export_fbx(os.path.join(tempfile.mkdtemp(), "b.fbx"), 0, target_tool="Blender")
        self.assertIn("target_tool=Blender preset applied", r.get("notes", []))
        if r.get("flags_applied"):
            self.assertEqual(r["flags3"] & self.JSON_BIT, self.JSON_BIT)
            root_motion = self.rl.EExportFbxOptions_ExportRootMotion
            self.assertEqual(r["flags"] & root_motion, root_motion)


class ExportObjTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")

    def test_requires_obj_extension(self):
        self.assertFalse(self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.fbx"))["success"])

    def test_reports_signature_used(self):
        self.rl.RFileIO.ExportObjFile.side_effect = lambda avatar, path, *rest: open(path, "wb").close()
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.obj"))
        self.assertTrue(r["success"])
        self.assertTrue(r["signature"])

    def test_reports_failure_when_file_not_written(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.obj"))
        self.assertFalse(r["success"])

    def test_error_status_falls_back(self):
        def export(avatar, path, *rest):
            status = mock.MagicMock()
            if rest:
                status.IsError.return_value = True
                return status
            open(path, "wb").close()
            status.IsError.return_value = False
            return status
        self.rl.RFileIO.ExportObjFile.side_effect = export
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.obj"))
        self.assertTrue(r["success"])
        self.assertEqual(r["signature"], "(avatar, path)")

    def test_try_signatures_falls_through(self):
        def boom():
            raise TypeError("bad args")
        label, err = self.pipe.try_signatures([("a", boom), ("b", lambda: None)])
        self.assertEqual(label, "b")
        self.assertIsNone(err)

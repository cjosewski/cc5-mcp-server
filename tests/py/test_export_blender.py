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

    def test_error_status_fails_without_retrying_a_weaker_form(self):
        # CC5 ran the export and reported failure: re-exporting without the options would hide that.
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
        self.assertFalse(r["success"])
        self.assertIn("reported an error status", r["error"])
        self.assertEqual(self.rl.RFileIO.ExportObjFile.call_count, 1)

    def test_rejected_arguments_fall_back_with_a_warning(self):
        def export(avatar, path, *rest):
            if rest:
                raise TypeError("Wrong number or type of arguments for overloaded function 'RFileIO_ExportObjFile'.")
            open(path, "wb").close()
        self.rl.RFileIO.ExportObjFile.side_effect = export
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.obj"))
        self.assertTrue(r["success"])
        self.assertEqual(r["signature"], "(avatar, path)")
        self.assertEqual(len(r["notes"]), 1)
        self.assertTrue(r["notes"][0].startswith("WARNING: CC5 rejected (avatar, path, option)"))
        self.assertIn("NOT applied", r["notes"][0])

    def test_try_signatures_falls_through(self):
        def boom():
            raise TypeError("bad args")
        label, err = self.pipe.try_signatures([("a", boom), ("b", lambda: None)])
        self.assertEqual(label, "b")
        self.assertIsNone(err)

    def test_try_signatures_falls_through_on_old_swig_not_implemented(self):
        def boom():
            raise NotImplementedError("Wrong number or type of arguments")
        self.assertEqual(self.pipe.try_signatures([("a", boom), ("b", lambda: None)]), ("b", None))

    def test_try_signatures_stops_when_the_call_ran_and_failed(self):
        second = mock.MagicMock()

        def ran_and_failed():
            raise RuntimeError("ExportObjFile reported an error status")
        label, err = self.pipe.try_signatures([("a", ran_and_failed), ("b", second)])
        self.assertIsNone(label)
        self.assertIn("a: ExportObjFile reported an error status", err)
        second.assert_not_called()

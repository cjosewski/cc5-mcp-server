from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()
        self.avatar = mock.MagicMock()
        self.avatar.GetMeshNames.return_value = ["CC_Base_Body", "CC_Base_Eye"]

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_import_fbx_rejects_unknown_kind(self):
        self.assertFalse(self.pipe.import_fbx(self._file("a.fbx"), "vehicle")["success"])

    def test_import_clothing_uses_load_clothe(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.import_fbx(self._file("jacket.fbx"), "clothing")
        self.assertTrue(r["success"])
        self.assertTrue(self.rl.RFileIO.LoadClotheFromFbx.called)

    def test_import_prop_uses_load_fbx(self):
        r = self.pipe.import_fbx(self._file("stretcher.fbx"), "prop")
        self.assertTrue(r["success"])
        self.assertTrue(self.rl.RFileIO.LoadFbxFile.called)

    def test_import_fbx_reports_error_status(self):
        # CC5 ran the import and failed: importing again with the default option could double-import.
        self.rl.RFileIO.LoadFbxFile.return_value.IsError.return_value = True
        r = self.pipe.import_fbx(self._file("stretcher.fbx"), "prop")
        self.assertFalse(r["success"])
        self.assertEqual(self.rl.RFileIO.LoadFbxFile.call_count, 1)
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_import_prop_falls_back_with_a_warning_only_when_swig_rejects_the_option(self):
        def load(path, *rest):
            if rest:
                raise TypeError("Wrong number or type of arguments for overloaded function 'RFileIO_LoadFbxFile'.")
        self.rl.RFileIO.LoadFbxFile.side_effect = load
        r = self.pipe.import_fbx(self._file("stretcher.fbx"), "prop")
        self.assertTrue(r["success"])
        self.assertEqual(r["signature"], "LoadFbxFile(path)")
        self.assertIn("default import option", r["notes"][0])
        self.assertTrue(r["notes"][0].startswith("WARNING"))

    def test_import_clothing_error_status_does_not_load_twice(self):
        self.rl.RFileIO.LoadClotheFromFbx.return_value.IsError.return_value = True
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.import_fbx(self._file("jacket.fbx"), "clothing")
        self.assertFalse(r["success"])
        self.assertEqual(self.rl.RFileIO.LoadClotheFromFbx.call_count, 1)

    def test_import_clothing_reports_meshes_that_failed(self):
        self.rl.WStringVector.return_value = ["Jacket_Hood", "Jacket_Zip"]
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.import_fbx(self._file("jacket.fbx"), "clothing")
        self.assertTrue(r["success"])
        self.assertEqual(r["failed_meshes"], ["Jacket_Hood", "Jacket_Zip"])
        self.assertEqual(r["notes"], ["WARNING: 2 clothing mesh(es) did not import: Jacket_Hood, Jacket_Zip"])
        self.assertIs(self.rl.RFileIO.LoadClotheFromFbx.call_args.args[2], self.rl.WStringVector.return_value)

    def test_import_clothing_clean_import_has_no_warning(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.import_fbx(self._file("jacket.fbx"), "clothing")
        self.assertEqual((r["failed_meshes"], r["notes"]), ([], []))

    def test_replace_mesh_unknown_mesh(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.replace_mesh_from_obj("Nope", self._file("a.obj"))
        self.assertFalse(r["success"])
        self.assertIn("CC_Base_Body", r["error"])

    def test_replace_mesh_calls_avatar(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.replace_mesh_from_obj("CC_Base_Body", self._file("a.obj"))
        self.assertTrue(r["success"])
        self.avatar.ReplaceMesh.assert_called_once()


if __name__ == "__main__":
    unittest.main()

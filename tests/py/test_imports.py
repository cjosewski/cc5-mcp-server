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
        # Like live CC5 5.13: a clothing import that works puts the garment on the avatar (GetClothes).
        self.worn: list[str] = []
        self.avatar.GetClothes.side_effect = lambda: [mock.Mock(**{"GetName.return_value": n}) for n in self.worn]
        self.avatar.GetAccessories.return_value = []
        self.rl.RFileIO.LoadClotheFromFbx.side_effect = self._wear

    def _wear(self, avatar, path, failed):
        self.worn.append("Jacket")
        return self.rl.RFileIO.LoadClotheFromFbx.return_value

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_import_fbx_rejects_unknown_kind(self):
        self.assertFalse(self.pipe.import_fbx(self._file("a.fbx"), "vehicle")["success"])

    # Chad's ruling (2026-10-03): live, a whole-character import drove CC5 5.13 into its import dialogs and crashed
    # it, so kind 'character' is switched off. It must fail at once with a plain "do it by hand in CC5" message.
    def test_import_character_is_switched_off_and_never_touches_cc5(self):
        fbx = self._file("Patient.fbx")
        self.rl.reset_mock()
        r = self.pipe.import_fbx(fbx, "character")
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], self.pipe.IMPORT_CHARACTER_DISABLED)
        self.assertIn("File > Import in Character Creator 5", r["error"])
        self.assertEqual(self.rl.mock_calls, [])

    def test_import_character_is_refused_even_for_a_missing_file(self):
        self.rl.reset_mock()
        r = self.pipe.ACTIONS["import_fbx"]({"file_path": "C:/no/such.fbx", "kind": "character"})
        self.assertEqual(r, {"success": False, "error": self.pipe.IMPORT_CHARACTER_DISABLED})
        self.assertEqual(self.rl.mock_calls, [])

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
        self.assertEqual(r["added"], ["Jacket"])

    def test_import_clothing_fails_when_nothing_new_is_worn(self):
        # Live CC5 5.13: LoadClotheFromFbx returned success for an unskinned Blender mesh and added nothing.
        self.rl.RFileIO.LoadClotheFromFbx.side_effect = None
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.import_fbx(self._file("tube.fbx"), "clothing")
        self.assertFalse(r["success"])
        self.assertIn("no clothing was added", r["error"])
        self.assertIn("skinned", r["error"])

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

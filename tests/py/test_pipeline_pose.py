from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class PoseTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.avatar = mock.MagicMock()
        self.dir = tempfile.mkdtemp()

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_rejects_wrong_extension(self):
        self.assertFalse(self.pipe.apply_pose(self._file("x.png"))["success"])

    def test_missing_file(self):
        self.assertFalse(self.pipe.apply_pose(os.path.join(self.dir, "nope.rlMotion"))["success"])

    def test_selects_avatar_then_loads(self):
        pose = self._file("lying.rlMotion")
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(pose)
        self.assertTrue(r["success"])
        self.rl.RScene.SelectObject.assert_called_with(self.avatar)
        self.assertEqual(r["method"], "LoadFile")
        # Live signature LoadFile(path, bRecordStep, spObject, ...): aim the pose at the avatar, not the selection.
        self.rl.RFileIO.LoadFile.assert_called_once_with(pose, True, self.avatar)

    def test_falls_back_to_load_motion(self):
        self.rl.RFileIO.LoadFile.side_effect = RuntimeError("not applicable")
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(self._file("lying.rlMotion"))
        self.assertEqual(r["method"], "LoadMotion")

    def test_error_status_falls_back_to_load_motion(self):
        # RLPy reports failure via RStatus, not an exception
        self.rl.RFileIO.LoadFile.return_value.IsError.return_value = True
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(self._file("lying.rlMotion"))
        self.assertTrue(r["success"])
        self.assertEqual(r["method"], "LoadMotion")

    def test_save_character_requires_ccavatar(self):
        self.assertFalse(self.pipe.save_character(os.path.join(self.dir, "a.fbx"))["success"])

    def test_save_character_saves_as_character(self):
        out = os.path.join(self.dir, "bases", "Male.ccAvatar")
        # save_character checks that the file exists afterwards, so the fake SaveFile writes it.
        self.rl.RFileIO.SaveFile.side_effect = lambda obj, setting, path: open(path, "wb").close()
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.save_character(out)
        self.assertEqual(r, {"success": True, "path": out, "expression_not_saved": []})
        setting = self.rl.RSaveFileSetting.return_value
        setting.SetSaveType.assert_called_once_with(self.rl.ESaveFileType_Character)
        self.rl.RFileIO.SaveFile.assert_called_once_with(self.avatar, setting, out)

    def test_save_character_fails_when_nothing_written(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.save_character(os.path.join(self.dir, "base.ccAvatar"))
        self.assertFalse(r["success"])

    def test_accepts_cc_native_pose_extension(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            self.assertTrue(self.pipe.apply_pose(self._file("lying.ccPose"))["success"])


class BrowsePoseTest(unittest.TestCase):
    """browse_content('pose'/'motion') must list the .rl* files apply_pose accepts."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.rl.RApplication.GetDefaultContentFolder.return_value = "$/Template"
        self.rl.RApplication.GetCustomContentFolder.return_value = ""
        self.rl.RApplication.GetContentFilesInFolder.return_value = [
            "C:/c/Lying.rlMotion", "C:/c/Supine.rlPose", "C:/c/Old.iMotion", "C:/c/New.ccPose", "C:/c/Lying.png"]

    def test_pose_lists_rl_files(self):
        self.assertEqual(self.api.browse_content("pose"),
                         ["C:/c/Lying.rlMotion", "C:/c/Supine.rlPose", "C:/c/Old.iMotion", "C:/c/New.ccPose"])

    def test_other_folders_keep_cc_i_filter(self):
        self.assertEqual(self.api.browse_content("shoes"), ["C:/c/Old.iMotion", "C:/c/New.ccPose"])


class SaveExpressionTest(unittest.TestCase):
    """F-77: a .ccAvatar keeps neither the facial expression nor the pose, so the save says which sliders it lost."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.avatar = mock.MagicMock()
        self.dir = tempfile.mkdtemp()

    def _face(self, weights):
        face = self.avatar.GetFaceComponent.return_value
        face.GetExpressionGroups.return_value = ["Brow", "Mouth"]
        face.GetExpressionNames.side_effect = lambda group: {"Brow": ["C", "A"], "Mouth": ["B"]}[group]
        face.GetExpressionWeights.side_effect = weights
        return face

    def _save(self):
        out = os.path.join(self.dir, "bases", "Posed.ccAvatar")
        self.rl.RFileIO.SaveFile.side_effect = lambda obj, setting, path: open(path, "wb").close()
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            return self.pipe.save_character(out), out

    def test_save_character_lists_the_expression_it_did_not_keep(self):
        # CC5 keeps float32 weights (0.6 reads back as 0.6000000238); B is at 0. Names are read sorted: A, B, C.
        face = self._face(lambda time, names: [0.6000000238, 0.0, 0.4])
        self.rl.RGlobal.GetTime.return_value = "now"
        r, out = self._save()
        self.assertEqual(r, {"success": True, "path": out,
                             "expression_not_saved": [{"name": "A", "weight": 0.6}, {"name": "C", "weight": 0.4}]})
        face.GetExpressionWeights.assert_called_once_with("now", ["A", "B", "C"])
        self.rl.RFileIO.SaveFile.assert_called_once()
        self.rl.RGlobal.BeginAction.assert_not_called()  # read only: no undo step

    def test_save_character_still_saves_when_the_expression_cannot_be_read(self):
        def unreadable(time, names):
            raise RuntimeError("no weights")
        self._face(unreadable)
        r, out = self._save()
        self.assertEqual(r, {"success": True, "path": out, "notes": [
            "Could not read the facial expression; a .ccAvatar keeps neither the facial expression nor the pose in any "
            "case."]})
        self.assertTrue(os.path.isfile(out))

    def test_save_character_without_a_face_component_adds_the_note(self):
        self.avatar.GetFaceComponent.return_value = None
        r, _out = self._save()
        self.assertNotIn("expression_not_saved", r)
        self.assertEqual(r["notes"], [self.pipe.EXPRESSION_NOT_READ])

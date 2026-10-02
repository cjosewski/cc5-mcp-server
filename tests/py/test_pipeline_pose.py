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
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(self._file("lying.rlMotion"))
        self.assertTrue(r["success"])
        self.rl.RScene.SelectObject.assert_called_with(self.avatar)
        self.assertEqual(r["method"], "LoadFile")

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
        self.assertEqual(r, {"success": True, "path": out})
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

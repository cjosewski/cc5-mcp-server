"""frame_camera frames a character, not whatever load_asset selected last (live, F-45)."""
from __future__ import annotations

import unittest
from unittest import mock

import _support


def _obj(name, oid):
    o = mock.MagicMock(name=name)
    o.GetName.return_value = name
    o.GetID.return_value = oid
    return o


class FrameCameraTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.kevin = _obj("Kevin", 1)
        self.camila = _obj("Camila", 2)
        self.afro = _obj("Oval Afro", 11)
        self.avatars = [self.kevin, self.camila]
        self.selection = [self.afro]
        self.framed_with = None
        scene = self.rl.RScene
        scene.GetAvatars.side_effect = lambda: list(self.avatars)
        scene.GetSelectedObjects.side_effect = lambda: list(self.selection)
        scene.ClearSelectObjects.side_effect = lambda: self.selection.clear()
        scene.SelectObject.side_effect = lambda o: self.selection.__setitem__(slice(None), [o])
        scene.SelectObjects.side_effect = lambda objs: self.selection.extend(objs)
        self.cam = scene.GetCurrentCamera.return_value
        self.cam.SetCameraLocation.side_effect = lambda loc: setattr(self, "framed_with", list(self.selection))

    def test_frames_the_first_character_and_restores_the_selection(self):
        # Live: with the just-loaded Oval Afro selected, "home" framed the head instead of Kevin.
        r = self.api.frame_camera("home")
        self.assertTrue(r["success"], r)
        self.assertEqual(r["framed"], "Kevin")
        self.assertEqual(self.framed_with, [self.kevin])
        self.assertEqual(self.selection, [self.afro])

    def test_target_picks_the_character(self):
        r = self.api.frame_camera("face", "Camila")
        self.assertEqual(self.framed_with, [self.camila])
        self.assertEqual(r["framed"], "Camila")

    def test_a_selected_character_is_framed(self):
        self.selection[:] = [self.camila]
        self.api.frame_camera("home")
        self.assertEqual(self.framed_with, [self.camila])
        self.assertEqual(self.selection, [self.camila])

    def test_two_selected_characters_frame_the_first(self):
        self.selection[:] = [self.camila, self.kevin]
        r = self.api.frame_camera("home")
        self.assertTrue(r["success"], r)
        self.assertEqual(self.framed_with, [self.kevin])
        self.assertEqual(self.selection, [self.camila, self.kevin])

    def test_all_frames_the_scene_and_leaves_the_selection_alone(self):
        r = self.api.frame_camera("all")
        self.assertTrue(r["success"], r)
        self.assertEqual(self.framed_with, [self.afro])
        self.assertNotIn("framed", r)
        self.rl.RScene.ClearSelectObjects.assert_not_called()

    def test_unknown_target_moves_nothing(self):
        r = self.api.frame_camera("home", "Nobody")
        self.assertFalse(r["success"])
        self.assertIn("Avatar not found: Nobody", r["error"])
        self.cam.SetCameraLocation.assert_not_called()

    def test_empty_scene_frames_as_before(self):
        self.avatars.clear()
        r = self.api.frame_camera("home")
        self.assertTrue(r["success"], r)
        self.assertNotIn("framed", r)
        self.assertEqual(self.framed_with, [self.afro])

    def test_selection_is_restored_when_the_move_fails(self):
        self.cam.SetCameraLocation.side_effect = RuntimeError("boom")
        r = self.api.frame_camera("home")
        self.assertFalse(r["success"])
        self.assertEqual(self.selection, [self.afro])


if __name__ == "__main__":
    unittest.main()

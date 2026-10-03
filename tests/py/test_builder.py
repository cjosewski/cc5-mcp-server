from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class BuilderTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.b = _support.fresh_import("cc5_builder")
        self.dir = tempfile.mkdtemp()

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    # Chad's ruling (2026-10-03): live, CreateHeadFromPhoto crashed CC5 5.13 in both Headshot modes, so the tool
    # is switched off. It must fail at once with a plain "do it by hand in CC5" message and never touch CC5.
    def test_headshot_is_switched_off_and_never_touches_cc5(self):
        photo = self._file("face.jpg")
        self.rl.reset_mock()
        r = self.b.headshot_from_photo(photo)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], self.b.HEADSHOT_DISABLED)
        self.assertIn("Headshot plugin inside Character Creator 5", r["error"])
        self.assertEqual(self.rl.mock_calls, [])

    def test_headshot_action_fails_with_the_same_message_whatever_the_params(self):
        self.rl.reset_mock()
        for params in ({"photo_path": self._file("face.jpg")}, {"photo_path": "C:/no/such.gif"}, {}):
            r = self.b.ACTIONS["headshot_from_photo"](params)
            self.assertEqual(r, {"success": False, "error": self.b.HEADSHOT_DISABLED})
        self.assertNotIn("headshot_from_photo", self.b.REQUIRED_PARAMS)
        self.assertEqual(self.rl.mock_calls, [])

    def test_facial_profile_loads(self):
        avatar = mock.MagicMock()
        with mock.patch.object(self.b.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.b.load_facial_profile(self._file("ext.ccFacialProfile"))
        self.assertTrue(r["success"])
        avatar.GetFacialProfileComponent.return_value.LoadProfile.assert_called_once()

    def test_facial_profile_error_status(self):
        avatar = mock.MagicMock()
        avatar.GetFacialProfileComponent.return_value.LoadProfile.return_value.IsError.return_value = True
        with mock.patch.object(self.b.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.b.load_facial_profile(self._file("ext.ccFacialProfile"))
        self.assertFalse(r["success"])

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

    def test_headshot_rejects_non_image(self):
        self.assertFalse(self.b.headshot_from_photo(self._file("a.txt"))["success"])

    def test_headshot_picks_pro_mode(self):
        with mock.patch.object(self.b, "_headshot_modes", return_value=["EHSMode_Auto", "EHSMode_Pro"]):
            r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertTrue(r["success"])
        self.assertEqual(r["mode"], "EHSMode_Pro")

    def test_headshot_licence_message(self):
        self.rl.RHeadshot.CreateHeadFromPhoto.side_effect = RuntimeError("no licence")
        with mock.patch.object(self.b, "_headshot_modes", return_value=["EHSMode_Pro"]):
            r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertFalse(r["success"])
        self.assertIn("Headshot", r["error"])

    def test_headshot_finds_rlpy_mode_enum(self):
        # Unpatched: real RLPy exposes the mode enum as EHSMode_Pro / EHSMode_Auto.
        self.rl.EHSMode_Auto = 1
        self.rl.EHSMode_Pro = 0
        r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertTrue(r["success"])
        self.assertEqual(r["mode"], "EHSMode_Pro")
        self.assertEqual(self.rl.RHeadshot.CreateHeadFromPhoto.call_args[0][1], 0)

    def test_headshot_tells_cc5_the_avatar_changed(self):
        avatar = mock.MagicMock()
        with mock.patch.object(self.b, "_headshot_modes", return_value=["EHSMode_Pro"]), \
                mock.patch.object(self.b.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertTrue(r["success"])
        self.rl.RGlobal.ObjectModified.assert_called_once_with(avatar, self.rl.EObjectModifiedType_Attribute)

    def test_facial_profile_loads(self):
        avatar = mock.MagicMock()
        with mock.patch.object(self.b.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.b.load_facial_profile(self._file("ext.ccFacialProfile"))
        self.assertTrue(r["success"])
        avatar.GetFacialProfileComponent.return_value.LoadProfile.assert_called_once()

    def test_headshot_error_status(self):
        self.rl.RHeadshot.CreateHeadFromPhoto.return_value.IsError.return_value = True
        with mock.patch.object(self.b, "_headshot_modes", return_value=["EHSMode_Pro"]):
            r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertFalse(r["success"])
        self.assertIn("Headshot", r["error"])
        self.rl.RGlobal.EndAction.assert_called()

    def test_facial_profile_error_status(self):
        avatar = mock.MagicMock()
        avatar.GetFacialProfileComponent.return_value.LoadProfile.return_value.IsError.return_value = True
        with mock.patch.object(self.b.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.b.load_facial_profile(self._file("ext.ccFacialProfile"))
        self.assertFalse(r["success"])

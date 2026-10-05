"""set_item_visible reads back where CC5 can; get_visual_settings reports the IBL image the bridge loaded (F-24)."""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class VisibilityReadbackTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")

    def test_an_item_cc5_can_read_is_verified(self):
        prop = mock.MagicMock()
        prop.IsVisible.return_value = False
        r = self.api._visibility_result(prop, "Box_001", False)
        self.assertEqual((r["success"], r["verified"]), (True, True))
        self.assertNotIn("notes", r)

    def test_a_disagreeing_read_back_is_a_warning(self):
        prop = mock.MagicMock()
        prop.IsVisible.return_value = True
        r = self.api._visibility_result(prop, "Box_001", False)
        self.assertFalse(r["verified"])
        self.assertIn("WARNING", r["notes"][0])

    def test_a_worn_item_says_it_cannot_be_read(self):
        cloth = mock.Mock(spec=["GetName"])
        r = self.api._visibility_result(cloth, "Boxers", False)
        self.assertIsNone(r["verified"])
        self.assertIn("cannot report", r["notes"][0])

    def test_visual_settings_report_the_ibl_image_this_bridge_loaded(self):
        image = os.path.join(tempfile.mkdtemp(), "studio.hdr")
        open(image, "wb").close()
        self.assertIsNone(self.api.get_visual_settings()["ibl_image_loaded_by_bridge"])
        with mock.patch.object(self.api, "_validate_path", return_value=None):
            self.assertTrue(self.api.set_ibl(image, True)["success"])
        self.assertEqual(self.api.get_visual_settings()["ibl_image_loaded_by_bridge"], image)


if __name__ == "__main__":
    unittest.main()

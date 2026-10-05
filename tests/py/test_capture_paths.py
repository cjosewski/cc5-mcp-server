"""Captures without a path get their own file instead of overwriting one (F-22)."""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class CapturePathTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.object(self.api.tempfile, "gettempdir", return_value=self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def test_each_capture_gets_its_own_file(self):
        a = self.api._new_capture_path()
        open(a, "wb").close()
        b = self.api._new_capture_path()
        self.assertNotEqual(a, b)
        self.assertEqual(os.path.dirname(a), os.path.join(self.tmp, "cc5_captures"))
        self.assertTrue(os.path.basename(b).startswith("cc5_viewport_"))

    def test_only_the_newest_captures_are_kept(self):
        folder = os.path.join(self.tmp, "cc5_captures")
        os.makedirs(folder)
        for i in range(60):
            open(os.path.join(folder, f"cc5_viewport_2026{i:04d}.png"), "wb").close()
        open(os.path.join(folder, "notes.txt"), "wb").close()
        self.api._new_capture_path()
        left = sorted(f for f in os.listdir(folder) if f.startswith("cc5_viewport_"))
        self.assertEqual(len(left), self.api.MAX_KEPT_CAPTURES - 1)
        self.assertEqual(left[-1], "cc5_viewport_20260059.png")
        self.assertTrue(os.path.exists(os.path.join(folder, "notes.txt")))


if __name__ == "__main__":
    unittest.main()

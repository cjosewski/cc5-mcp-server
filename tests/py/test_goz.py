from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class GoZTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()

    def test_rejects_unknown_pose(self):
        self.assertFalse(self.pipe.export_goz(self.dir, "sitting")["success"])

    def test_sets_pose_on_option_and_exports(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_goz(self.dir, "apose")
        self.assertTrue(r["success"])
        self.assertEqual(r["folder"], self.dir)
        self.assertTrue(self.rl.RFileIO.ExportGoZFile.called)
        self.rl.RExportGoZMeshOption.return_value.SetPose.assert_called_once_with(self.rl.EExportGoZPose_APose)
        self.assertTrue(r["pose_applied"])

    def test_reports_pose_not_applied_when_option_has_no_setter(self):
        self.rl.RExportGoZMeshOption.return_value = mock.MagicMock(spec=[])
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_goz(self.dir, "tpose")
        self.assertTrue(r["success"])
        self.assertFalse(r["pose_applied"])
        self.assertIn("NOT applied", r["notes"][0])

    def test_current_pose_needs_no_setter(self):
        self.rl.RExportGoZMeshOption.return_value = mock.MagicMock(spec=[])
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_goz(self.dir, "current")
        self.assertTrue(r["success"])
        self.assertTrue(r["pose_applied"])
        self.assertEqual(r["notes"], [])

    def test_fails_when_every_signature_returns_an_error_status(self):
        self.rl.RFileIO.ExportGoZFile.return_value.IsError.return_value = True
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_goz(self.dir, "tpose")
        self.assertFalse(r["success"])
        self.assertIn("ExportGoZFile failed", r["error"])
        self.assertEqual(self.rl.RFileIO.ExportGoZFile.call_count, 2)

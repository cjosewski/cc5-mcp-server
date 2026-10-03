from __future__ import annotations

import os
import tempfile
import types
import unittest
from unittest import mock

import _support


def _live_option():
    """What dir(RLPy.RExportGoZMeshOption()) shows on live CC5: attributes, no setter methods."""
    return types.SimpleNamespace(bDoScale=True, bIsCreate=False, ePose=None, strPoseFilePath="")


class GoZTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()
        self.avatar = mock.MagicMock()
        p = mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)
        self.rl.RFileIO.ExportGoZFile.side_effect = self._live_goz_export

    def _live_goz_export(self, objects, folder, option):
        """Like live CC5 5.13: each file name is appended straight onto the folder string it was given."""
        with open(folder + "CC_Base_Body.GoZ", "wb") as f:
            f.write(b"GoZb")
        return self.rl.RFileIO.ExportGoZFile.return_value

    def test_rejects_unknown_pose(self):
        self.assertFalse(self.pipe.export_goz(self.dir, "sitting")["success"])

    def test_sets_the_pose_attribute_and_exports(self):
        option = _live_option()
        self.rl.RExportGoZMeshOption.return_value = option
        r = self.pipe.export_goz(self.dir, "apose")
        self.assertTrue(r["success"])
        self.assertEqual(r["folder"], self.dir)
        self.assertEqual(option.ePose, self.rl.EExportGoZPose_APose)
        self.assertTrue(r["pose_applied"])
        self.assertEqual(r["notes"], [])

    def test_passes_the_avatar_in_an_object_vector_first(self):
        self.rl.RExportGoZMeshOption.return_value = _live_option()
        r = self.pipe.export_goz(self.dir, "tpose")
        objects = self.rl.ObjectVector.return_value
        objects.append.assert_called_once_with(self.avatar)
        self.assertIs(self.rl.RFileIO.ExportGoZFile.call_args.args[0], objects)
        self.assertEqual(r["signature"], "(ObjectVector[avatar], folder, option)")

    def test_falls_back_to_a_list_when_swig_rejects_the_object_vector(self):
        self.rl.RExportGoZMeshOption.return_value = _live_option()
        self.rl.ObjectVector.return_value.append.side_effect = TypeError("in method 'ObjectVector_append'")
        r = self.pipe.export_goz(self.dir, "tpose")
        self.assertTrue(r["success"])
        self.assertEqual(r["signature"], "([avatar], folder, option)")
        self.assertEqual(self.rl.RFileIO.ExportGoZFile.call_args.args[0], [self.avatar])

    def test_uses_a_pose_setter_when_there_is_no_pose_attribute(self):
        self.rl.RExportGoZMeshOption.return_value = mock.MagicMock(spec=["SetPose"])
        r = self.pipe.export_goz(self.dir, "apose")
        self.rl.RExportGoZMeshOption.return_value.SetPose.assert_called_once_with(self.rl.EExportGoZPose_APose)
        self.assertTrue(r["pose_applied"])

    def test_reports_pose_not_applied_when_option_has_no_pose_attribute_or_setter(self):
        self.rl.RExportGoZMeshOption.return_value = mock.MagicMock(spec=[])
        r = self.pipe.export_goz(self.dir, "tpose")
        self.assertTrue(r["success"])
        self.assertFalse(r["pose_applied"])
        self.assertIn("NOT applied", r["notes"][0])

    def test_current_pose_needs_no_setter(self):
        self.rl.RExportGoZMeshOption.return_value = mock.MagicMock(spec=[])
        r = self.pipe.export_goz(self.dir, "current")
        self.assertTrue(r["success"])
        self.assertTrue(r["pose_applied"])
        self.assertEqual(r["notes"], [])

    def test_passes_the_folder_with_a_trailing_separator(self):
        # Live CC5 5.13 wrote "<parent>\gozCC_Base_Body.GoZ" next to a folder passed as "<parent>\goz".
        self.rl.RExportGoZMeshOption.return_value = _live_option()
        r = self.pipe.export_goz(self.dir, "tpose")
        self.assertTrue(r["success"])
        self.assertTrue(self.rl.RFileIO.ExportGoZFile.call_args.args[1].endswith(os.sep))
        self.assertEqual([os.path.basename(f["path"]) for f in r["files"]], ["CC_Base_Body.GoZ"])

    def test_fails_when_cc5_writes_no_goz_file_into_the_folder(self):
        self.rl.RExportGoZMeshOption.return_value = _live_option()
        self.rl.RFileIO.ExportGoZFile.side_effect = lambda objects, folder, option:             self.rl.RFileIO.ExportGoZFile.return_value
        r = self.pipe.export_goz(self.dir, "tpose")
        self.assertFalse(r["success"])
        self.assertIn("no GoZ file", r["error"])

    def test_error_status_fails_without_retrying_a_weaker_form(self):
        self.rl.RFileIO.ExportGoZFile.return_value.IsError.return_value = True
        r = self.pipe.export_goz(self.dir, "tpose")
        self.assertFalse(r["success"])
        self.assertIn("ExportGoZFile failed", r["error"])
        self.assertEqual(self.rl.RFileIO.ExportGoZFile.call_count, 1)


if __name__ == "__main__":
    unittest.main()

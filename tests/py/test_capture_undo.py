"""capture_viewport must not add an undo step: CC5 records SetRenderExportParameter (live, F-53)."""
from __future__ import annotations

import unittest
from unittest import mock

import _support


class RenderResolutionTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.param = mock.MagicMock()
        self.rl.RGlobal.GetRenderExportImageParameter.return_value = self.param

    def test_same_size_sets_nothing(self):
        # Live: every capture re-set the size, so `undo` after a capture reversed the capture, not the change.
        self.param.kCommon.nOutputSizeWidth = 1280
        self.param.kCommon.nOutputSizeHeight = 720
        self.api._set_render_resolution(1280, 720)
        self.rl.RGlobal.SetRenderExportParameter.assert_not_called()

    def test_new_size_is_set_once(self):
        self.param.kCommon.nOutputSizeWidth = 100
        self.param.kCommon.nOutputSizeHeight = 32
        self.api._set_render_resolution(640, 360)
        self.rl.RGlobal.SetRenderExportParameter.assert_called_once_with(self.param)
        self.assertEqual((self.param.kCommon.nOutputSizeWidth, self.param.kCommon.nOutputSizeHeight), (640, 360))

    def test_minimum_size_is_compared_after_clamping(self):
        self.param.kCommon.nOutputSizeWidth = 16
        self.param.kCommon.nOutputSizeHeight = 16
        self.api._set_render_resolution(1, 2)
        self.rl.RGlobal.SetRenderExportParameter.assert_not_called()


if __name__ == "__main__":
    unittest.main()

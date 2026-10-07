"""capture_viewport must not leave an undo step: CC5 records RenderImage and SetRenderExportParameter (live, F-53)."""
from __future__ import annotations

import os
import sys
import tempfile
import types
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
        self.assertFalse(self.api._set_render_resolution(1280, 720))
        self.rl.RGlobal.SetRenderExportParameter.assert_not_called()

    def test_new_size_is_set_once(self):
        self.param.kCommon.nOutputSizeWidth = 100
        self.param.kCommon.nOutputSizeHeight = 32
        self.assertTrue(self.api._set_render_resolution(640, 360))
        self.rl.RGlobal.SetRenderExportParameter.assert_called_once_with(self.param)
        self.assertEqual((self.param.kCommon.nOutputSizeWidth, self.param.kCommon.nOutputSizeHeight), (640, 360))

    def test_minimum_size_is_compared_after_clamping(self):
        self.param.kCommon.nOutputSizeWidth = 16
        self.param.kCommon.nOutputSizeHeight = 16
        self.api._set_render_resolution(1, 2)
        self.rl.RGlobal.SetRenderExportParameter.assert_not_called()


class CaptureUndoTest(unittest.TestCase):
    """The capture undoes exactly the steps it recorded, never more."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.param = mock.MagicMock()
        self.param.kCommon.nOutputSizeWidth = 1280
        self.param.kCommon.nOutputSizeHeight = 720
        self.rl.RGlobal.GetRenderExportImageParameter.return_value = self.param
        self.dir = tempfile.mkdtemp()
        self.out = os.path.join(self.dir, "shot.png")

    def _renders(self, writes):
        attempts = iter(writes)

        def render(path):
            if next(attempts, False):
                with open(path, "wb") as f:
                    f.write(b"png")
        self.rl.RGlobal.RenderImage.side_effect = render

    def test_a_render_is_undone_once(self):
        # Live: remove -> RenderImage -> Undo left the item removed; the next undo brought it back.
        self._renders([True])
        r = self.api.capture_viewport(self.out, 1280, 720)
        self.assertTrue(r["success"], r)
        self.assertEqual(self.rl.RGlobal.Undo.call_count, 1)

    def test_a_new_size_and_a_render_are_one_step_together(self):
        # Live: undoing two steps there also undid the user's removal; size + render is one step.
        self._renders([True])
        self.api.capture_viewport(self.out, 640, 360)
        self.assertEqual(self.rl.RGlobal.Undo.call_count, 1)

    def test_a_new_size_without_a_render_is_one_step(self):
        self._renders([False, False])
        with mock.patch.object(self.api, "_capture_window_screenshot"):
            self.api.capture_viewport(self.out, 640, 360)
        self.assertEqual(self.rl.RGlobal.Undo.call_count, 1)

    def test_a_retried_render_counts_only_the_attempt_that_wrote_the_file(self):
        self._renders([False, True])
        self.api.capture_viewport(self.out, 1280, 720)
        self.assertEqual(self.rl.RGlobal.Undo.call_count, 1)

    def test_nothing_is_undone_when_no_render_worked(self):
        # Undoing too much would undo the user's change: a render that wrote nothing is not counted.
        self._renders([False, False])
        with mock.patch.object(self.api, "_capture_window_screenshot"):
            self.api.capture_viewport(self.out, 1280, 720)
        self.rl.RGlobal.Undo.assert_not_called()


class UndoMarksOverlayRecordsStaleTest(unittest.TestCase):
    """P-1: after an undo or a redo, the bridge's overlay records (cc5_pipeline.BLEND_SOURCES) may no longer match what
    CC5 shows, so both mark them stale (cc5_pipeline.mark_blend_sources_stale). cc5_pipeline is found in sys.modules
    when they run: it imports cc5_api, so cc5_api never imports it."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        p = mock.patch.object(self.api, "get_first_avatar", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        self.events: list = []
        self.rl.RGlobal.Undo.side_effect = lambda: self.events.append("Undo")
        self.rl.RGlobal.Redo.side_effect = lambda: self.events.append("Redo")
        self.pipe = types.ModuleType("cc5_pipeline")
        self.pipe.mark_blend_sources_stale = lambda: self.events.append("stale")
        m = mock.patch.dict(sys.modules, {"cc5_pipeline": self.pipe})
        m.start()
        self.addCleanup(m.stop)

    def test_undo_and_redo_mark_the_records_stale_after_the_rlpy_call(self):
        self.assertTrue(self.api.undo()["success"])
        self.assertTrue(self.api.redo()["success"])
        self.assertEqual(self.events, ["Undo", "stale", "Redo", "stale"])

    def test_a_capture_and_a_refused_redo_mark_nothing(self):
        # A capture undoes only its own step; a redo refused for it calls nothing in CC5 (F-55).
        self.api._drop_capture_undo_steps(1)
        self.assertFalse(self.api.redo()["success"])
        self.assertEqual(self.events, ["Undo"])

    def test_a_failed_undo_marks_nothing(self):
        self.rl.RGlobal.Undo.side_effect = RuntimeError("SWIG")
        self.assertFalse(self.api.undo()["success"])
        self.assertEqual(self.events, [])

    def test_undo_and_redo_never_fail_because_of_the_records(self):
        def broken():
            raise RuntimeError("records")

        self.pipe.mark_blend_sources_stale = broken
        self.assertTrue(self.api.undo()["success"])
        self.assertTrue(self.api.redo()["success"])
        self.assertEqual(self.events, ["Undo", "Redo"])

    def test_without_the_module_or_the_function_nothing_is_marked(self):
        # An older plugin copy: cc5_pipeline without mark_blend_sources_stale, or not loaded at all.
        del self.pipe.mark_blend_sources_stale
        self.assertTrue(self.api.undo()["success"])
        del sys.modules["cc5_pipeline"]
        self.assertTrue(self.api.redo()["success"])
        self.assertEqual(self.events, ["Undo", "Redo"])


if __name__ == "__main__":
    unittest.main()

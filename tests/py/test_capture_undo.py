"""capture_viewport must not leave an undo step: CC5 records RenderImage and SetRenderExportParameter (live, F-53)."""
from __future__ import annotations

import itertools
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
            r = self.api.capture_viewport(self.out, 640, 360)
        self.assertEqual(self.rl.RGlobal.Undo.call_count, 1)
        # No note: the error is CC5's alone (batch F review #5 adds notes to it).
        self.assertEqual(r, {"success": False, "error": f"RenderImage did not create file at {self.out}"})

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


def _object(name, oid):
    o = mock.MagicMock(name=name)
    o.GetName.return_value = name
    o.GetID.return_value = oid
    return o


class _Character:
    """A character proxy whose worn items are lists a test can change."""

    def __init__(self, name, oid):
        self.clothes, self.accessories, self.hairs = [], [], []
        self.proxy = _object(name, oid)
        self.proxy.GetClothes.side_effect = lambda: list(self.clothes)
        self.proxy.GetAccessories.side_effect = lambda *all_items: list(self.accessories)
        self.proxy.GetHairs.side_effect = lambda: list(self.hairs)


class CaptureTakesBackTest(unittest.TestCase):
    """F-104 (live 2026-10-07): CC5 had not finished a load when the capture queued behind it rendered, so the render got
    no undo step of its own and the capture's own undo took the load back (Box_001 gone in 6 of 7 runs). Behind the
    queue's gate (server.py), the capture compares the scene before its render with the scene after its undo, and
    redoes once when something came or went."""

    REDONE = ("WARNING: CC5 had not finished the change before this capture (a load still running), so the capture's own "
              "undo took that change back; it was put back with a redo (F-104). Check the scene.")
    LOST = ("WARNING: CC5 had not finished the change before this capture (a load still running), so the capture's own "
            "undo took that change back, and a redo did not bring it back (F-104): check the scene; the change may need "
            "to be made again.")
    REDO_FAILED = ("WARNING: CC5 had not finished the change before this capture (a load still running), so the "
                   "capture's own undo took that change back, and the redo after it failed (F-104): redo (or Edit > "
                   "Redo in CC5) can bring it back; check the scene.")
    NOT_CHECKED = ("WARNING: CC5 had not finished the change before this capture (a load still running), so the "
                   "capture's own undo took that change back; a redo ran to put it back, but the scene could not be "
                   "read after it (F-104): check the scene.")
    SKIPPED = ("WARNING: CC5 was still loading images when this capture rendered, so the capture did not undo its own "
               "render step (F-104): the next undo may take back only that step; check with a capture after an undo.")

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        param = mock.MagicMock()
        param.kCommon.nOutputSizeWidth = 1280
        param.kCommon.nOutputSizeHeight = 720
        self.rl.RGlobal.GetRenderExportImageParameter.return_value = param
        for kind in ("Prop", "SpotLight", "PointLight", "DirectionalLight", "Camera"):
            setattr(self.rl, f"EObjectType_{kind}", kind)
        self.kevin = _Character("Kevin", 1)
        self.kevin.clothes.append(_object("Shirt", 11))
        self.kevin.hairs.append(_object("Buzz_Cut", 12))
        self.kevin.accessories.append(_object("Glasses", 13))
        self.amy = _Character("Amy", 2)
        self.box = _object("Box_001", 41)  # the load CC5 had not finished (live)
        self.avatars = [self.kevin.proxy, self.amy.proxy]
        self.by_type = {"Prop": [self.box], "SpotLight": [_object("Key", 21)], "PointLight": [],
                        "DirectionalLight": [_object("Sun", 22)], "Camera": [_object("Preview Camera", 31)]}
        self.rl.RScene.GetAvatars.side_effect = lambda: list(self.avatars)
        self.rl.RScene.FindObjects.side_effect = lambda kind: list(self.by_type[kind])
        self.selection: list = []
        self.rl.RScene.GetSelectedObjects.side_effect = lambda: list(self.selection)
        self.events: list = []
        self.out = os.path.join(tempfile.mkdtemp(), "shot.png")

        def render(path):
            with open(path, "wb") as f:
                f.write(b"png")
        self.rl.RGlobal.RenderImage.side_effect = render

    def takes_back(self, items, item, redo_brings_it_back=True):
        """The capture's own undo takes `item` out of `items`; a redo puts it back unless told otherwise."""
        def undo():
            self.events.append("Undo")
            items.remove(item)

        def redo():
            self.events.append("Redo")
            if redo_brings_it_back:
                items.append(item)
        self.rl.RGlobal.Undo.side_effect = undo
        self.rl.RGlobal.Redo.side_effect = redo

    def capture(self):
        return self.api.capture_viewport(self.out, 1280, 720)

    def test_an_undo_that_took_back_a_load_is_redone_once_and_said(self):
        self.takes_back(self.by_type["Prop"], self.box)
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertEqual(self.events, ["Undo", "Redo"])
        self.assertIn(self.box, self.by_type["Prop"])
        self.assertEqual(r["notes"], [self.REDONE])
        self.assertEqual(self.api.CAPTURE_UNDO_REDONE, self.REDONE)
        self.assertIn("base64", r)  # the capture itself is unchanged
        # The capture replaced CC5's redo history either way: nothing of the user's is left to redo.
        self.assertEqual(self.api._redo_slots, ["capture"])
        self.assertFalse(self.api.redo()["success"])

    def test_every_character_worn_item_prop_light_and_camera_counts(self):
        cases = (("a character", self.avatars, self.amy.proxy),
                 ("clothing", self.kevin.clothes, self.kevin.clothes[0]),
                 ("hair", self.kevin.hairs, self.kevin.hairs[0]),
                 ("an accessory", self.kevin.accessories, self.kevin.accessories[0]),
                 ("a spot light", self.by_type["SpotLight"], self.by_type["SpotLight"][0]),
                 ("a directional light", self.by_type["DirectionalLight"], self.by_type["DirectionalLight"][0]),
                 ("a camera", self.by_type["Camera"], self.by_type["Camera"][0]))
        for what, items, item in cases:
            with self.subTest(what):
                self.events.clear()
                self.takes_back(items, item)
                r = self.capture()
                self.assertEqual(self.events, ["Undo", "Redo"])
                self.assertEqual(r["notes"], [self.REDONE])
                self.assertIn(item, items)

    def test_a_redo_that_does_not_bring_it_back_says_so(self):
        self.takes_back(self.by_type["Prop"], self.box, redo_brings_it_back=False)
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertEqual(self.events, ["Undo", "Redo"])  # one redo, never more
        self.assertEqual(r["notes"], [self.LOST])
        self.assertEqual(self.api.CAPTURE_UNDO_LOST, self.LOST)

    def test_a_redo_that_raised_leaves_the_change_to_the_redo_tool(self):
        # Batch F review #4: the change the capture's own undo took back waits in CC5's redo slot, so the note says redo
        # can bring it back, and the redo tool no longer refuses it as a capture's step (it said "Edit > Redo would
        # replay the capture's own step").
        self.takes_back(self.by_type["Prop"], self.box)
        self.rl.RGlobal.Redo.side_effect = RuntimeError("SWIG")
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertEqual(r["notes"], [self.REDO_FAILED])
        self.assertEqual(self.api.CAPTURE_UNDO_REDO_FAILED, self.REDO_FAILED)
        self.assertNotIn(self.box, self.by_type["Prop"])
        self.assertEqual(self.api._redo_slots, ["user"])
        self.rl.RGlobal.Redo.side_effect = lambda: self.by_type["Prop"].append(self.box)  # CC5's redo slot holds it
        self.assertTrue(self.api.redo()["success"])
        self.assertIn(self.box, self.by_type["Prop"])

    def test_a_redo_that_raised_but_brought_the_change_back_says_it_was_put_back(self):
        self.takes_back(self.by_type["Prop"], self.box)

        def redo():
            self.by_type["Prop"].append(self.box)
            raise RuntimeError("SWIG")
        self.rl.RGlobal.Redo.side_effect = redo
        r = self.capture()
        self.assertEqual(r["notes"], [self.REDONE])
        self.assertEqual(self.api._redo_slots, ["capture"])

    def test_a_scene_that_cannot_be_read_after_the_redo_is_said_to_be_unchecked(self):
        # Batch F review #4: the redo ran, so the change may well be back. LOST ("the change may need to be made
        # again") would have the agent load the box a second time.
        self.takes_back(self.by_type["Prop"], self.box)
        reads = itertools.count()

        def avatars():
            if next(reads) == 2:  # the reads: before the render, after the undo, after the redo
                raise RuntimeError("SWIG")
            return list(self.avatars)
        self.rl.RScene.GetAvatars.side_effect = avatars
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertEqual(self.events, ["Undo", "Redo"])
        self.assertEqual(r["notes"], [self.NOT_CHECKED])
        self.assertEqual(self.api.CAPTURE_UNDO_NOT_CHECKED, self.NOT_CHECKED)
        self.assertEqual(self.api._redo_slots, ["capture"])  # the redo ran: nothing is left in CC5's redo slot

    def test_an_unchanged_scene_is_not_redone_and_adds_no_note(self):
        # The capture's own undo fires CC5's selection-changed event even when nothing else changed (F-104 probes):
        # the selection is no part of what is compared.
        self.selection.append(self.box)

        def undo():
            self.events.append("Undo")
            self.selection.clear()
        self.rl.RGlobal.Undo.side_effect = undo
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertEqual(self.events, ["Undo"])
        self.rl.RGlobal.Redo.assert_not_called()
        self.assertNotIn("notes", r)

    def test_a_scene_that_cannot_be_read_is_not_checked(self):
        for when in ("before the render", "after the undo"):
            with self.subTest(when):
                self.events.clear()
                self.by_type["Prop"][:] = [self.box]
                reads = itertools.count()

                def avatars(first_fails=(when == "before the render")):
                    if (next(reads) == 0) == first_fails:
                        raise RuntimeError("SWIG")
                    return list(self.avatars)
                self.rl.RScene.GetAvatars.side_effect = avatars
                self.takes_back(self.by_type["Prop"], self.box)
                r = self.capture()
                self.assertTrue(r["success"], r)
                self.assertEqual(self.events, ["Undo"])  # no redo: nothing is known to have gone
                self.assertNotIn("notes", r)

    # Without an undo of the capture's own, a change between the two reads is not the capture's to put back.

    def test_a_capture_that_recorded_no_step_checks_nothing(self):
        # No render wrote the file and the size did not change, so no step is recorded and nothing is undone; the box
        # goes inside the failed render, between the read before it and the check (batch F review #30: the box went in
        # the window screenshot, after the check, so the test passed with a check run on every capture).
        def render(path):
            if self.box in self.by_type["Prop"]:
                self.by_type["Prop"].remove(self.box)
            raise RuntimeError("RenderImage failed")

        def screenshot(path):
            open(path, "wb").close()
        self.rl.RGlobal.RenderImage.side_effect = render
        with mock.patch.object(self.api, "_capture_window_screenshot", side_effect=screenshot):
            r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertNotIn(self.box, self.by_type["Prop"])
        self.rl.RGlobal.Undo.assert_not_called()
        self.rl.RGlobal.Redo.assert_not_called()
        self.assertNotIn("notes", r)

    def test_a_capture_whose_own_undo_failed_checks_nothing(self):
        def render(path):
            open(path, "wb").close()
            self.by_type["Prop"].remove(self.box)
        self.rl.RGlobal.RenderImage.side_effect = render
        self.rl.RGlobal.Undo.side_effect = RuntimeError("SWIG")
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.rl.RGlobal.Redo.assert_not_called()
        self.assertNotIn("notes", r)

    # Batch F review #2: the queue's gate lets a capture run after 20 s while CC5 still loads images (CC5 slow, F-105).
    # A render then gets no undo step of its own, so the capture's own undo would take the load back, and a skin preset,
    # an eye preset or a texture changes nothing the scene check sees: no redo, no note, and a picture of a preset CC5 no
    # longer has. The capture reads the server's image-load flag and leaves its step alone then.

    def images_loading(self, loading):
        """server._images_loading, as the bridge's image-load watch sets it (F-104); the server module itself."""
        srv = types.ModuleType("server")
        srv._images_loading = loading
        p = mock.patch.dict(sys.modules, {"server": srv})
        p.start()
        self.addCleanup(p.stop)
        return srv

    def test_a_capture_while_cc5_still_loads_images_leaves_its_own_step_alone(self):
        self.images_loading(True)
        self.takes_back(self.by_type["Prop"], self.box)  # what an undo now would do
        r = self.capture()
        self.assertTrue(r["success"], r)
        self.assertIn("base64", r)  # the capture itself is unchanged
        self.assertEqual(self.events, [])  # no undo, so no check and no redo
        self.assertIn(self.box, self.by_type["Prop"])
        self.assertEqual(r["notes"], [self.SKIPPED])
        self.assertEqual(self.api.CAPTURE_UNDO_SKIPPED, self.SKIPPED)
        # As after an undo of the capture's step: a step recorded now cleared CC5's redo history.
        self.assertEqual(self.api._redo_slots, ["capture"])
        self.assertFalse(self.api.redo()["success"])
        self.assertEqual(self.events, [])

    def test_the_image_load_flag_is_read_before_the_render(self):
        # CC5's OnImageAsyncLoadAllDone came while it rendered: the render still started while CC5 loaded images.
        srv = self.images_loading(True)

        def render(path):
            srv._images_loading = False
            with open(path, "wb") as f:
                f.write(b"png")
        self.rl.RGlobal.RenderImage.side_effect = render
        r = self.capture()
        self.rl.RGlobal.Undo.assert_not_called()
        self.assertEqual(r["notes"], [self.SKIPPED])

    def test_with_the_images_loaded_the_capture_undoes_its_step_as_before(self):
        self.images_loading(False)
        r = self.capture()
        self.assertEqual(self.rl.RGlobal.Undo.call_count, 1)
        self.assertNotIn("notes", r)

    def test_while_images_load_a_capture_that_recorded_no_step_adds_no_note(self):
        self.images_loading(True)
        self.rl.RGlobal.RenderImage.side_effect = None  # no render wrote the file, and the size did not change

        def screenshot(path):
            open(path, "wb").close()
        with mock.patch.object(self.api, "_capture_window_screenshot", side_effect=screenshot):
            r = self.capture()
        self.assertTrue(r["success"], r)
        self.rl.RGlobal.Undo.assert_not_called()
        self.assertNotIn("notes", r)

    # Batch F review #5: the bridge answers {success: False} with HTTP 400, and the MCP server keeps only `error`, so a
    # failed capture's notes are in `error` too, one line each after it.

    def test_a_failed_capture_has_its_notes_in_its_error_too(self):
        # The size change is the capture's one step. Its undo took the box back, the redo put it back, and then the
        # window screenshot failed too.
        self.takes_back(self.by_type["Prop"], self.box)
        self.rl.RGlobal.RenderImage.side_effect = None  # writes nothing
        with mock.patch.object(self.api, "_capture_window_screenshot", side_effect=RuntimeError("no window")):
            r = self.api.capture_viewport(self.out, 640, 360)
        self.assertEqual(self.events, ["Undo", "Redo"])
        self.assertEqual(r, {"success": False, "error": f"RenderImage did not create file at {self.out}\n{self.REDONE}",
                             "notes": [self.REDONE]})

    def test_a_capture_that_raised_after_its_undo_has_its_notes_in_its_error_too(self):
        self.takes_back(self.by_type["Prop"], self.box, redo_brings_it_back=False)
        self.rl.RGlobal.RenderImage.side_effect = None  # writes nothing, so the retry runs
        self.rl.RGlobal.ForceViewportUpdate.side_effect = RuntimeError("viewport gone")
        r = self.api.capture_viewport(self.out, 640, 360)
        self.assertEqual(self.events, ["Undo", "Redo"])
        self.assertEqual(r, {"success": False, "error": f"viewport gone\n{self.LOST}", "notes": [self.LOST]})


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

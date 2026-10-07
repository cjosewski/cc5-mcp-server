"""F-104: the queue holds capture_viewport and replace_mesh_from_obj until CC5 has settled after the previous command.

Live CC5 5.13 (2026-10-07): a capture queued right behind a load job undid the load with its own undo step (Box_001 gone
in 6 of 7 runs), and a replace started right after load_texture misread the OBJ by 95.44 cm (F-101). Held until 0.3 s
after the previous command ended and until CC5's background image load was done, neither happened (5 of 5, 2 of 2).
A test clock stands in for time.monotonic(), and each process_command_queue() call is one tick of CC5's queue timer.
"""
from __future__ import annotations

import contextlib
import io
import sys
import time
import unittest
from unittest import mock

import _support


class _Clock:
    """server.py's `time` module in these tests: monotonic() is the test's clock, everything else the real module."""

    def __init__(self, now: float = 1000.0):
        self.now = now

    def monotonic(self) -> float:
        return self.now

    def __getattr__(self, name):
        return getattr(time, name)


class _EventCallback:
    """RLPy.REventCallback: CC5 calls the On... methods of an instance registered with REventHandler."""

    def __init__(self):
        self.base_initialised = True


class _QueueTestCase(unittest.TestCase):
    PARAMS = {"load_asset": {"file_path": "C:/Props/Box_001.iProp"}, "set_skin_color": {"r": 1, "g": 1, "b": 1},
              "replace_mesh_from_obj": {"mesh_name": "CC_Base_Body", "obj_path": "C:/obj/live.obj"}}

    def setUp(self):
        self.srv = _support.fresh_import("server")
        self.clock = _Clock()
        self.described = None  # the modal dialog CC5 shows, as _describe_modal gives it
        for name, value in (("time", self.clock), ("_describe_modal", lambda: self.described)):
            p = mock.patch.object(self.srv, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.ran: list[str] = []
        for action in ("load_asset", "load_texture", "set_skin_color", "capture_viewport", "replace_mesh_from_obj"):
            self.srv.ACTION_MAP[action] = lambda p, a=action: self.ran.append(a) or {"success": True}

    def queue(self, *actions: str) -> list[str]:
        """Queue each action as a job (as the MCP server's load and capture jobs do); their ids."""
        ids = []
        for action in actions:
            status, body = self.srv._start_job(action, dict(self.PARAMS.get(action, {})))
            self.assertEqual(status, 200, body)
            ids.append(body["result"]["job_id"])
        return ids

    def status(self, job_id: str) -> str:
        return self.srv._job_status(job_id)[1]["result"]["status"]


class SettleGateTest(_QueueTestCase):
    def test_the_held_actions_and_the_waits(self):
        self.assertEqual(self.srv.SETTLE_ACTIONS, frozenset({"capture_viewport", "replace_mesh_from_obj"}))
        self.assertEqual((self.srv.SETTLE_SECONDS, self.srv.IMAGE_LOAD_WAIT_SECONDS), (0.3, 20.0))

    def test_a_capture_right_after_a_command_waits_until_0_3_s_have_passed(self):
        load, capture = self.queue("load_asset", "capture_viewport")
        self.srv.process_command_queue()  # live, one drain of the queue ran both, and the capture undid the load
        self.assertEqual(self.ran, ["load_asset"])
        self.assertEqual((self.status(load), self.status(capture)), ("done", "queued"))
        self.clock.now += 0.25
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset"])
        self.clock.now += 0.1  # 0.35 s after the load ended
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset", "capture_viewport"])
        self.assertEqual(self.status(capture), "done")

    def test_a_replace_right_after_a_texture_load_waits_the_same_way(self):
        # F-101: replace_mesh_from_obj started right after load_texture misread the OBJ by 95.44 cm.
        self.queue("load_texture", "replace_mesh_from_obj")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_texture"])
        self.clock.now += 0.35
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_texture", "replace_mesh_from_obj"])

    def test_a_command_that_failed_starts_the_wait_too(self):
        def raises(p):
            raise RuntimeError("SWIG")

        self.srv.ACTION_MAP["fails"] = lambda p: {"success": False, "error": "nope"}
        self.srv.ACTION_MAP["raises"] = raises
        for action in ("fails", "raises"):
            with self.subTest(action=action):
                self.ran.clear()
                self.clock.now += 10
                self.queue(action, "capture_viewport")
                with mock.patch("builtins.print"):  # the bridge prints a raising action's traceback
                    self.srv.process_command_queue()
                self.assertEqual(self.ran, [])
                self.clock.now += 0.35
                self.srv.process_command_queue()
                self.assertEqual(self.ran, ["capture_viewport"])

    def test_a_capture_with_no_command_before_it_runs_at_once(self):
        self.queue("capture_viewport")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["capture_viewport"])

    def test_other_actions_are_never_held(self):
        # Two ordinary loads queued together stay separate undo steps (live), so only the two actions above wait.
        self.srv._note_image_load_start()
        self.queue("load_asset", "set_skin_color", "load_asset")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset", "set_skin_color", "load_asset"])

    def test_commands_behind_a_held_capture_keep_their_order(self):
        load, capture, later = self.queue("load_asset", "capture_viewport", "set_skin_color")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset"])
        self.assertEqual((self.status(capture), self.status(later)), ("queued", "queued"))
        self.clock.now += 0.35
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset", "capture_viewport", "set_skin_color"])

    def test_a_capture_waits_while_cc5_loads_images_until_all_done(self):
        self.srv._note_image_load_start()  # OnImageAsyncLoadStart: CC5 still loads the load's images
        self.queue("capture_viewport")
        for seconds in (0.0, 5.0, 19.0):
            self.clock.now = 1000.0 + seconds
            self.srv.process_command_queue()
            self.assertEqual(self.ran, [], seconds)
        self.srv._note_image_load_done()  # OnImageAsyncLoadAllDone
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["capture_viewport"])

    def test_an_image_load_holds_a_capture_20_s_at_most(self):
        # An OnImageAsyncLoadAllDone that never comes must not hold the queue for good; a held direct capture must
        # still start within the bridge's 30 s.
        self.srv._note_image_load_start()
        self.queue("capture_viewport")
        self.clock.now += 19.9
        self.srv.process_command_queue()
        self.assertEqual(self.ran, [])
        self.clock.now += 0.2
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["capture_viewport"])

    def test_the_20_s_count_from_cc5s_last_image_load_start(self):
        self.srv._note_image_load_start()
        self.clock.now += 15
        self.srv._note_image_load_start()  # another load began
        self.queue("capture_viewport")
        self.clock.now += 15  # 30 s after the first start, 15 s after the last
        self.srv.process_command_queue()
        self.assertEqual(self.ran, [])
        self.clock.now += 5.1
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["capture_viewport"])

    def test_a_cancelled_capture_is_dropped_without_holding_the_commands_behind_it(self):
        self.queue("load_asset")
        # A direct capture whose caller was told "cancelled" after the bridge's 30 s (_execute_sync): it never runs.
        self.srv.command_queue.put_nowait({"id": "cmd_cancelled", "action": "capture_viewport", "params": {}})
        self.srv._cancelled.add("cmd_cancelled")
        self.queue("set_skin_color")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset", "set_skin_color"])
        self.assertEqual(self.srv._cancelled, set())

    def test_a_cancelled_command_that_was_skipped_starts_no_wait(self):
        self.srv.command_queue.put_nowait({"id": "cmd_cancelled", "action": "load_asset", "params": {}})
        self.srv._cancelled.add("cmd_cancelled")
        self.queue("capture_viewport")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["capture_viewport"])

    def test_a_capture_that_fails_with_the_dialogs_text_is_not_held(self):
        # The queue guard fails it without running it: there is nothing to wait for.
        self.srv.MODAL_WAIT_SECONDS = 0.0
        self.described = {"title": "Character Creator 5", "text": "Do you want to delete the selected light?",
                          "buttons": ["Yes", "No"], "text_read": True, "progress": False}
        load, capture = self.queue("load_asset", "capture_viewport")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, [])
        self.assertEqual((self.status(load), self.status(capture)), ("failed", "failed"))
        result = self.srv._job_status(capture)[1]["result"]["result"]
        self.assertTrue(result["error"].startswith('CC5 is waiting for an answer to "Do you want to delete'), result)

    def test_a_held_capture_waits_the_full_time_for_a_later_dialog(self):
        # Batch F review #0: the queue guard stamps the head when it first sees a dialog, and nothing dropped the stamp
        # while the head stayed queued. A capture the gate holds stays first in the queue after the dialog closed, so a
        # second dialog 7 s after the first failed it at once instead of after MODAL_WAIT_SECONDS.
        first = {"title": "Character Creator 5", "text": "Do you want to delete the selected light?",
                 "buttons": ["Yes", "No"], "text_read": True, "progress": False}
        second = {**first, "text": "Save changes to the current project?", "buttons": ["Yes", "No", "Cancel"]}
        self.srv._note_image_load_start()  # CC5 still loads a load's images: the gate holds the capture (20 s at most)
        capture, = self.queue("capture_viewport")
        self.described = first  # t = 0 s: a window shows for about a second
        self.srv.process_command_queue()
        self.clock.now += 1.0
        self.described = None  # it closed; the image load still holds the capture
        self.srv.process_command_queue()
        self.assertEqual(self.status(capture), "queued")
        self.clock.now += 6.0  # t = 7 s: another window shows
        self.described = second
        self.srv.process_command_queue()
        self.assertEqual(self.status(capture), "queued")  # it waits for this one too
        self.clock.now += 4.9
        self.srv.process_command_queue()
        self.assertEqual(self.status(capture), "queued")
        self.clock.now += 0.2  # 5.1 s after the second window showed
        self.srv.process_command_queue()
        self.assertEqual(self.status(capture), "failed")
        result = self.srv._job_status(capture)[1]["result"]["result"]
        self.assertTrue(result["error"].startswith('CC5 is waiting for an answer to "Save changes to the current '
                                                   'project?"'), result)
        self.assertEqual(self.ran, [])

    def test_the_capture_reads_this_modules_image_load_flag(self):
        # Batch F review #2: after IMAGE_LOAD_WAIT_SECONDS the gate lets a capture run while CC5 still loads images, and
        # cc5_api.capture_viewport then leaves its own undo step alone. It reads _images_loading here by name.
        api = sys.modules["cc5_api"]  # the module this server imported
        self.assertFalse(api._images_still_loading())
        self.srv._note_image_load_start()
        self.assertTrue(api._images_still_loading())
        self.srv._note_image_load_done()
        self.assertFalse(api._images_still_loading())


class ImageWatchTest(_QueueTestCase):
    """The REventCallback behind the gate: CC5 tells the bridge when its background image loads start and end."""

    def setUp(self):
        super().setUp()
        rlpy = sys.modules["RLPy"]
        self.handler = mock.MagicMock(name="REventHandler")
        self.handler.RegisterCallback.return_value = 7
        for name, value in (("REventCallback", _EventCallback), ("REventHandler", self.handler)):
            p = mock.patch.object(rlpy, name, value)
            p.start()
            self.addCleanup(p.stop)

    def start(self) -> tuple[bool, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            on = self.srv.start_image_watch()
        return on, out.getvalue()

    def test_nothing_is_registered_at_import(self):
        srv = _support.fresh_import("server")
        self.handler.RegisterCallback.assert_not_called()
        self.assertIsNone(srv._image_watch)
        self.assertFalse(srv._images_loading)

    def test_the_watch_registers_one_callback_and_keeps_it(self):
        self.assertEqual(self.start(), (True, ""))
        watch = self.srv._image_watch
        self.assertIsInstance(watch, _EventCallback)
        self.assertTrue(watch.base_initialised)  # the subclass runs REventCallback.__init__, as CC5's samples do
        self.handler.RegisterCallback.assert_called_once_with(watch)
        self.assertEqual(self.srv._image_watch_id, 7)
        self.assertEqual(self.start(), (True, ""))  # a second start: still the one callback
        self.handler.RegisterCallback.assert_called_once_with(watch)

    def test_its_callbacks_set_and_clear_the_flag_the_queue_reads(self):
        self.start()
        watch = self.srv._image_watch
        watch.OnImageAsyncLoadStart()
        self.assertEqual((self.srv._images_loading, self.srv._images_loading_since), (True, 1000.0))
        self.queue("capture_viewport")
        self.clock.now += 3
        self.srv.process_command_queue()
        self.assertEqual(self.ran, [])
        watch.OnImageAsyncLoadAllDone()
        self.assertFalse(self.srv._images_loading)
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["capture_viewport"])

    def test_its_callbacks_never_raise(self):
        # CC5 calls them; an exception there must not reach CC5.
        self.start()
        watch = self.srv._image_watch
        with mock.patch.object(self.srv, "_note_image_load_start", side_effect=RuntimeError("boom")), \
                mock.patch.object(self.srv, "_note_image_load_done", side_effect=RuntimeError("boom")):
            self.assertIsNone(watch.OnImageAsyncLoadStart())
            self.assertIsNone(watch.OnImageAsyncLoadAllDone())
        with mock.patch.object(self.clock, "monotonic", side_effect=OSError("no clock")):
            self.assertIsNone(self.srv._note_image_load_start())
        self.assertFalse(self.srv._images_loading)

    def test_a_registration_that_fails_leaves_the_watch_off_and_prints_one_line(self):
        self.handler.RegisterCallback.side_effect = RuntimeError("REventHandler\n  is unavailable")
        self.assertEqual(self.start(), (False, "[CC5 MCP Bridge] CC5's image loads are not watched (F-104): "
                                               "REventHandler is unavailable\n"))
        self.assertIsNone(self.srv._image_watch)
        self.assertIsNone(self.srv._image_watch_id)
        # The queue still holds a capture for SETTLE_SECONDS after the previous command.
        self.queue("load_asset", "capture_viewport")
        self.srv.process_command_queue()
        self.assertEqual(self.ran, ["load_asset"])

    def test_a_base_class_that_cannot_be_subclassed_leaves_the_watch_off(self):
        with mock.patch.object(sys.modules["RLPy"], "REventCallback", 5):
            on, printed = self.start()
        self.assertFalse(on)
        self.assertEqual(len(printed.splitlines()), 1, printed)
        self.assertTrue(printed.startswith("[CC5 MCP Bridge] CC5's image loads are not watched (F-104): "), printed)
        self.handler.RegisterCallback.assert_not_called()
        self.assertIsNone(self.srv._image_watch)

    def test_stop_unregisters_the_callback_and_forgets_it(self):
        self.start()
        self.srv._note_image_load_start()
        self.srv.stop_image_watch()
        self.handler.UnregisterCallback.assert_called_once_with(7)
        self.assertIsNone(self.srv._image_watch)
        self.assertIsNone(self.srv._image_watch_id)
        self.assertFalse(self.srv._images_loading)
        self.srv.stop_image_watch()  # without a watch: nothing to unregister
        self.handler.UnregisterCallback.assert_called_once_with(7)

    def test_a_watch_cc5_would_not_unregister_stays_referenced(self):
        self.start()
        watch = self.srv._image_watch
        self.handler.UnregisterCallback.side_effect = RuntimeError("unknown id")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.srv.stop_image_watch()  # no exception
        self.assertEqual(out.getvalue(), "[CC5 MCP Bridge] Unregistering the image-load watch failed: unknown id\n")
        self.assertIs(self.srv._image_watch, watch)  # CC5 may still call it


if __name__ == "__main__":
    unittest.main()

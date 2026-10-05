"""A command that opens a CC5 dialog: the caller hears about it at once, can read it, answer it, then read the job."""
from __future__ import annotations

import sys
import threading
import time
import types
import unittest
from unittest import mock

import _support
from test_auth import BridgeTestCase

LAYER_QUESTION = ("The target object layer already exists.\n"
                  "Do you want to replace the object, or the material only?")


class _Label:
    def __init__(self, text, visible=True):
        self._text, self._visible = text, visible

    def text(self):
        return self._text

    def isVisible(self):
        return self._visible


class _Button(_Label):
    def __init__(self, text, on_click=None, visible=True, enabled=True):
        super().__init__(text, visible)
        self._enabled, self._on_click = enabled, on_click
        self.clicked = 0

    def isEnabled(self):
        return self._enabled

    def click(self):
        self.clicked += 1
        if self._on_click:
            self._on_click(self)


class _CC5Dialog:
    """CC5's own dialog: a QDialog whose question sits in QLabels (not a QMessageBox)."""

    def __init__(self, title, labels, buttons):
        self._title, self._labels, self._buttons = title, labels, buttons

    def windowTitle(self):
        return self._title

    def findChildren(self, cls):
        return list(self._labels if cls is _Label else self._buttons)


def _fake_qt(singleshot_calls):
    widgets = types.ModuleType("PySide2.QtWidgets")
    widgets.QLabel, widgets.QPushButton = _Label, _Button
    widgets.QMessageBox = type("QMessageBox", (), {})
    core = types.ModuleType("PySide2.QtCore")
    class QTimer:
        """Fires on start(). Live, QTimer.singleShot(0, callable) never fired in CC5, so it must not be used."""
        singleShot = None

        def __init__(self):
            self._fns = []
            self.timeout = types.SimpleNamespace(connect=self._fns.append)

        def setSingleShot(self, flag):
            self.single = flag

        def start(self, ms):
            singleshot_calls.append(self)
            for fn in self._fns:
                fn()

    core.QTimer = QTimer
    pkg = types.ModuleType("PySide2")
    pkg.QtWidgets, pkg.QtCore = widgets, core
    return {"PySide2": pkg, "PySide2.QtWidgets": widgets, "PySide2.QtCore": core}


class DialogTest(BridgeTestCase):
    def setUp(self):
        super().setUp()
        self.clicks: list = []
        p = mock.patch.dict(sys.modules, _fake_qt(self.clicks))
        p.start()
        self.addCleanup(p.stop)
        self.answer: list[str] = []
        self.dialog = None
        mw = mock.patch.object(self.srv, "_modal_widget", side_effect=lambda: self.dialog)
        mw.start()
        self.addCleanup(mw.stop)
        self.srv.DIALOG_REPORT_SECONDS = 0.2

        def close(button):
            self.answer.append(button.text())
            self.dialog = None

        self.layer_dialog = _CC5Dialog(
            "Character Creator 5",
            [_Label("The target object layer already exists."),
             _Label("Do you want to replace the object, or the material only?"),
             _Label("hidden", visible=False)],
            [_Button("&Replace", close), _Button("Material Only", close), _Button("Cancel", close),
             _Button("Help", visible=False)])

        def load_eyes(p):
            # Like RFileIO.LoadFile: CC5 opens its question and runs a nested event loop until it is answered.
            self.dialog = self.layer_dialog
            end = time.monotonic() + 10
            while self.dialog is not None and time.monotonic() < end:
                # Inside the dialog's nested loop only the dialog timer fires: Qt never re-fires the command
                # timer whose callback is running this very command.
                self.srv.process_dialog_lane()
                time.sleep(0.01)
            return {"success": True, "answer": self.answer[-1] if self.answer else None}

        self.srv.ACTION_MAP["load_eyes"] = load_eyes

    def test_describes_cc5_dialogs_from_their_labels_and_buttons(self):
        self.dialog = self.layer_dialog
        self.assertEqual(self.srv._describe_modal(), {
            "title": "Character Creator 5", "text": LAYER_QUESTION,
            "buttons": ["Replace", "Material Only", "Cancel"], "text_read": True, "progress": False})

    def test_plain_strips_rich_text(self):
        self.assertEqual(self.srv._plain("<p>Save <b>Kevin</b>?</p><p>Tom &amp; Jerry</p>"), "Save Kevin?\nTom & Jerry")

    def test_caller_hears_about_the_dialog_answers_it_and_reads_the_job(self):
        started = time.monotonic()
        status, body = self.srv._execute_sync("load_eyes", {}, timeout=30)
        self.assertLess(time.monotonic() - started, 5)  # not the full 30 s timeout
        self.assertEqual(status, 409)
        self.assertEqual(body["state"], "waiting_for_dialog")
        self.assertEqual(body["dialog"]["buttons"], ["Replace", "Material Only", "Cancel"])
        job_id = body["job_id"]
        self.assertIn(f'job_status("{job_id}")', body["error"])
        self.assertIn("Buttons: Replace, Material Only, Cancel", body["error"])
        self.assertIn("The target object layer already exists. Do you want to replace", body["error"])

        # While the command still waits inside the dialog, the dialog lane answers.
        status, seen = self.srv._execute_sync("get_dialog", {}, timeout=5)
        self.assertEqual(status, 200)
        self.assertEqual(seen["result"]["waiting_job"], job_id)
        self.assertEqual(seen["result"]["dialog"]["title"], "Character Creator 5")

        status, clicked = self.srv._execute_sync("answer_dialog", {"button": "material only"}, timeout=5)
        self.assertEqual(status, 200)
        self.assertEqual(clicked["result"]["clicked"], "Material Only")
        # Clicked directly, in the same call: live, deferred clicks never reached CC5's QMessageBox.
        self.assertEqual(self.clicks, [])  # no QTimer was used
        self.assertEqual(self.answer, ["Material Only"])

        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(job_id)[1]["result"]
            if job["status"] in ("done", "failed"):
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"], {"success": True, "answer": "Material Only"})

    def test_answer_with_an_unknown_button_lists_the_buttons(self):
        self.dialog = self.layer_dialog
        r = self.srv.answer_dialog("OK")
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], 'No single button "OK" in the dialog. Buttons: Replace, Material Only, Cancel')
        self.assertEqual([b.clicked for b in self.layer_dialog._buttons], [0, 0, 0, 0])

    def test_hidden_and_disabled_buttons_cannot_be_clicked(self):
        self.dialog = self.layer_dialog
        self.assertFalse(self.srv.answer_dialog("Help")["success"])

    def test_answer_without_a_dialog(self):
        self.assertEqual(self.srv.answer_dialog("OK"), {"success": False, "error": "No CC5 dialog is open"})

    def test_the_crash_recovery_prompt_is_the_users_to_answer(self):
        self.dialog = _CC5Dialog("Character Creator 5", [_Label("Unsaved project data found. Would you like to "
                                                                "update your project with the unsaved changes?")],
                                 [_Button("OK"), _Button("Cancel")])
        r = self.srv.answer_dialog("OK")
        self.assertFalse(r["success"])
        self.assertIn("user's decision", r["error"])
        self.assertEqual([b.clicked for b in self.dialog._buttons], [0, 0])

    def test_the_recovery_prompt_is_refused_wherever_its_words_sit(self):
        self.dialog = _CC5Dialog("Character Creator 5",
                                 [_Label("Character Creator 5 closed unexpectedly."),
                                  _Label("Unsaved project data found. Would you like to update your project?")],
                                 [_Button("OK"), _Button("Cancel")])
        self.assertIn("user's decision", self.srv.answer_dialog("OK")["error"])
        self.dialog = _CC5Dialog("Unsaved Project Data Found", [], [_Button("OK")])
        self.assertFalse(self.srv.answer_dialog("OK")["success"])
        self.assertEqual(self.dialog._buttons[0].clicked, 0)

    def test_refuses_a_dialog_whose_text_cannot_be_read(self):
        class Unreadable(_CC5Dialog):
            def findChildren(self, cls):
                if cls is _Label:
                    raise RuntimeError("wrapped C/C++ object has been deleted")
                return super().findChildren(cls)
        self.dialog = Unreadable("Character Creator 5", [], [_Button("OK")])
        r = self.srv.answer_dialog("OK")
        self.assertFalse(r["success"])
        self.assertIn("could not be read", r["error"])
        self.assertEqual(self.dialog._buttons[0].clicked, 0)

    def test_expect_guards_against_answering_the_wrong_dialog(self):
        self.dialog = self.layer_dialog
        wrong = self.srv.answer_dialog("Cancel", expect="Delete Kevin?")
        self.assertFalse(wrong["success"])
        self.assertIn("not the one expected", wrong["error"])
        right = self.srv.answer_dialog("Material Only", expect="target object  layer already EXISTS")
        self.assertTrue(right["success"], right)
        self.assertEqual(self.answer, ["Material Only"])

    def test_plugin_driven_dialogs_are_left_to_their_tool(self):
        self.dialog = _CC5Dialog("Create Mixer Assets", [_Label("Name")], [_Button("Create"), _Button("Cancel")])
        r = self.srv.answer_dialog("Create")
        self.assertFalse(r["success"])
        self.assertIn("driven by its own tool", r["error"])

    def test_a_progress_window_is_not_a_question(self):
        self.assertFalse(self.srv._is_question({"buttons": ["Cancel"], "progress": False}))
        self.assertFalse(self.srv._is_question({"buttons": ["Stop", "Go"], "progress": True}))
        self.assertTrue(self.srv._is_question({"buttons": ["OK"], "progress": False}))

        progress = _CC5Dialog("Loading", [_Label("Loading Kevin... 40%")], [_Button("Cancel")])

        def slow_load(p):
            self.dialog = progress
            end = time.monotonic() + 0.8
            while time.monotonic() < end:
                self.srv.process_dialog_lane()
                time.sleep(0.01)
            self.dialog = None
            return {"success": True}

        self.srv.ACTION_MAP["slow_load"] = slow_load
        status, body = self.srv._execute_sync("slow_load", {}, timeout=10)
        self.assertEqual((status, body["result"]), (200, {"success": True}))

    def test_a_job_waiting_on_a_dialog_reports_it(self):
        _, body = self.srv._start_job("load_eyes", {})
        job_id = body["result"]["job_id"]
        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(job_id)[1]["result"]
            if "dialog" in job:
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "running")
        self.assertEqual(job["dialog"]["buttons"], ["Replace", "Material Only", "Cancel"])
        self.assertIn(f'job_status("{job_id}")', job["dialog_message"])
        self.srv._execute_sync("answer_dialog", {"button": "Replace"}, timeout=5)
        while time.monotonic() < end + 5:
            job = self.srv._job_status(job_id)[1]["result"]
            if job["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(job["result"], {"success": True, "answer": "&Replace"})  # the button's raw Qt label
        self.assertNotIn("dialog", job)

    def test_a_dialog_command_being_run_is_never_reported_cancelled(self):
        gate = threading.Event()
        self.srv.ACTION_MAP["get_dialog"] = lambda p: gate.wait(2) and {"success": True}
        status, body = self.srv._execute_sync("get_dialog", {}, timeout=0.3)
        gate.set()
        self.assertEqual((status, body["state"]), (504, "running"))
        self.assertEqual(self.srv._cancelled, set())

    def test_get_dialog_when_none_is_open(self):
        self.assertEqual(self.srv.get_dialog(), {"success": True, "dialog": None, "waiting_job": None})

    def test_bad_button_argument(self):
        for bad in (None, "", "   ", 5, "x" * 101):
            self.assertFalse(self.srv.answer_dialog(bad)["success"], bad)

    def test_dialog_actions_cannot_run_as_jobs(self):
        for action in ("get_dialog", "answer_dialog"):
            self.assertEqual(self.srv._start_job(action, {"button": "OK"})[0], 400)

    def test_dialog_lane_serves_while_the_command_queue_is_blocked(self):
        gate = threading.Event()
        self.srv.ACTION_MAP["busy"] = lambda p: self._busy(gate)
        t = threading.Thread(target=self.srv._execute_sync, args=("busy", {}, 10))
        t.start()
        time.sleep(0.1)
        status, body = self.srv._execute_sync("get_dialog", {}, timeout=3)
        gate.set()
        t.join(5)
        self.assertEqual(status, 200)

    def _busy(self, gate):
        while not gate.is_set():
            self.srv.process_dialog_lane()
            time.sleep(0.01)
        return {"success": True}

    def test_a_command_without_a_dialog_is_unaffected(self):
        status, body = self.srv._execute_sync("ping", {}, timeout=5)
        self.assertEqual((status, body["result"]), (200, {"success": True, "pong": True}))

    def test_routes(self):
        self.assertEqual(self.srv.POST_ROUTES["/dialog"], "get_dialog")
        self.assertEqual(self.srv.POST_ROUTES["/dialog/answer"], "answer_dialog")
        self.assertEqual(self.srv.REQUIRED_PARAMS["answer_dialog"], ["button"])


class MainTimersTest(unittest.TestCase):
    """main.py must run the dialog lane on its own timer: Qt does not re-fire the command timer while its
    callback (a command waiting in a CC5 dialog) is still running."""

    def test_initialize_starts_a_separate_dialog_timer(self):
        started = []

        class QTimer:
            def __init__(self):
                self.timeout = types.SimpleNamespace(connect=lambda fn: setattr(self, "fn", fn))

            def start(self, ms):
                started.append((self.fn.__name__, ms))

            def stop(self):
                pass

        core = types.ModuleType("PySide2.QtCore")
        core.QTimer = QTimer
        pkg = types.ModuleType("PySide2")
        pkg.QtCore = core
        with mock.patch.dict(sys.modules, {"PySide2": pkg, "PySide2.QtCore": core}):
            sys.modules.pop("main", None)
            main = _support.fresh_import("main")
            with mock.patch.object(main.bridge_server, "start_server", return_value=mock.Mock()):
                main.initialize_plugin()
            names = dict(started)
            self.assertEqual(names["_on_timer"], 16)
            self.assertEqual(names["_on_dialog_timer"], 50)
            with mock.patch.object(main.bridge_server, "process_dialog_lane") as lane:
                main._on_dialog_timer()
            lane.assert_called_once()
            with mock.patch.object(main.bridge_server, "stop_server"):
                main.uninitialize_plugin()
            self.assertIsNone(main._dialog_timer)
        sys.modules.pop("main", None)


if __name__ == "__main__":
    unittest.main()

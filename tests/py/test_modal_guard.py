from __future__ import annotations

import sys
import threading
import time
import types
import unittest
from unittest import mock

import _support
from test_auth import BridgeTestCase

RECOVERY = ("Character Creator 5",
            "Unsaved project data found. Would you like to update your project with the unsaved changes?")


class ModalGuardTest(BridgeTestCase):
    """Live CC5 crashed when the bridge ran an FBX export inside the nested event loop of a modal dialog
    (the crash-recovery prompt): commands wait while a modal dialog is open, then fail with its text."""

    def setUp(self):
        super().setUp()
        self.dialog = RECOVERY  # (title, text) of a readable OK/Cancel question, a full description, or None
        p = mock.patch.object(self.srv, "_describe_modal", side_effect=self._described)
        p.start()
        self.addCleanup(p.stop)
        self.ran: list[object] = []
        self.srv.ACTION_MAP["mark"] = lambda p: self.ran.append(self.dialog) or {"success": True}

    def _described(self):
        if self.dialog is None or isinstance(self.dialog, dict):
            return self.dialog
        title, text = self.dialog
        return {"title": title, "text": text, "buttons": ["OK", "Cancel"], "text_read": True, "progress": False}

    def test_waits_for_the_dialog_then_runs(self):
        threading.Timer(0.3, lambda: setattr(self, "dialog", None)).start()
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 200)
        self.assertEqual(self.ran, [None])  # ran only after the dialog closed

    def test_fails_with_the_dialog_text_when_it_stays_open(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertFalse(body["success"])
        self.assertEqual(self.ran, [])
        self.assertIn('CC5 is waiting for an answer to "Unsaved project data found. Would you like to update '
                      'your project with the unsaved changes?"', body["error"])
        self.assertIn('"Character Creator 5"', body["error"])
        self.assertIn("OK restores your last unsaved work, Cancel discards it", body["error"])
        self.assertTrue(body["error"].endswith("then try again."))

    def test_other_dialogs_get_no_recovery_hint(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = ("Character Creator 5", "Do you want to delete the selected light?")
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        # The guard runs only while no MCP command runs, so no command waits on this dialog: it may be the user's own,
        # and answering it is not a confirmation of something the user asked for (C2 review).
        self.assertEqual(body["error"], 'CC5 is waiting for an answer to "Do you want to delete the selected light?" (the '
                                        '"Character Creator 5" window) - no MCP command is waiting on it, so it is '
                                        "probably the user's own or CC5's: ask the user to answer or close it in CC5, "
                                        "then try again.")
        self.assertNotIn("Unsaved", body["error"])
        self.assertNotIn("answer_cc5_dialog", body["error"])

    # Live CC5 5.13 (F-84, F-85): SkinGen's About box has no buttons, and one of its labels shows the licence serial.
    # Made-up serial; the real one is never written anywhere. The labels are given unredacted here, the worst case.
    ABOUT_BOX = {"title": "CCSkinGen", "text": "S/N : ABCDE-12345-FGHIJ-67890\nProduct Version : 1.0.0824.1\n"
                                               "www.reallusion.com", "buttons": [], "text_read": True, "progress": False}

    def test_a_window_with_no_buttons_is_named_by_its_title_never_by_its_text(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = dict(self.ABOUT_BOX)
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character '
                                        "Creator 5 (no MCP tool can close it), then try again.")
        self.assertNotIn("ABCDE-12345-FGHIJ-67890", body["error"])
        self.assertNotIn("Product Version", body["error"])
        self.assertEqual(self.ran, [])

    def test_an_untitled_window_with_no_buttons_is_named_by_its_first_line(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = {**self.ABOUT_BOX, "title": "", "text": "Preparing SkinGen layers\nStep 2 of 5"}
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(body["error"], 'CC5 has a window open with no buttons: "Preparing SkinGen layers" - close it '
                                        "in Character Creator 5 (no MCP tool can close it), then try again.")
        self.dialog = {**self.ABOUT_BOX, "title": "T" * 200}
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertIn(f'"{"T" * 117}..."', body["error"])  # a long title is cut, as the questions are

    def test_a_window_with_no_buttons_keeps_the_other_branches(self):
        # A window whose text could not be read, a recovery prompt whose buttons could not be read, and a progress
        # window without buttons keep their own messages.
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = {**self.ABOUT_BOX, "text": "", "text_read": False}
        self.assertIn("its text could not be read", self.srv._execute_sync("mark", {}, timeout=5)[1]["error"])
        self.dialog = {"title": RECOVERY[0], "text": RECOVERY[1], "buttons": [], "text_read": True, "progress": False}
        self.assertIn("OK restores your last unsaved work", self.srv._execute_sync("mark", {}, timeout=5)[1]["error"])
        self.dialog = {**self.ABOUT_BOX, "progress": True}
        self.assertTrue(self.srv._execute_sync("mark", {}, timeout=5)[1]["error"].startswith('CC5 is busy with "CCSkinGen"'))
        self.assertEqual(self.ran, [])

    def test_a_progress_window_is_reported_as_busy_not_as_a_question(self):
        # F-56: a command's progress window (an export's) is not a question, and its Cancel aborts that command.
        self.srv.MODAL_WAIT_SECONDS = 0.2
        for buttons, progress in ((["Cancel"], False), ([], True)):
            with self.subTest(buttons=buttons, progress=progress):
                self.dialog = {"title": "Exporting", "text": "Exporting FBX...", "buttons": buttons,
                               "text_read": True, "progress": progress}
                status, body = self.srv._execute_sync("mark", {}, timeout=5)
                self.assertEqual(status, 400)
                self.assertEqual(body["error"], 'CC5 is busy with "Exporting" (the progress window of a command it is '
                                                "running) - try again when it closes. Do not cancel it unless the user "
                                                "asks; they cancel it in CC5.")
        self.assertEqual(self.ran, [])

    def test_a_dialog_whose_text_could_not_be_read_goes_to_the_user(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = {"title": "Character Creator 5", "text": "", "buttons": ["OK", "Cancel"], "text_read": False,
                       "progress": False}
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], 'CC5 is waiting for an answer to "Character Creator 5" - its text could not be '
                                        "read, so ask the user to answer it in CC5, then try again.")

    def test_an_untitled_window_is_named_as_the_welcome_page(self):
        # Live CC5 5.13 can start with its full-screen Welcome / What's New page: untitled, with no text.
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = ("", "")
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "CC5's Welcome / What's New page (or another untitled CC5 window) is open - "
                                        "close it in Character Creator 5 (tick \"Don't show this again\" so it stays "
                                        "closed), then try again.")
        self.assertEqual(self.ran, [])

    def test_does_not_wait_longer_than_needed(self):
        self.srv.MODAL_WAIT_SECONDS = 0.3
        started = time.monotonic()
        self.srv._execute_sync("mark", {}, timeout=5)
        self.assertLess(time.monotonic() - started, 2)

    def test_a_job_fails_with_the_dialog_text(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        _, body = self.srv._start_job("mark", {})
        job_id = body["result"]["job_id"]
        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(job_id)[1]["result"]
            if job["status"] in ("done", "failed"):
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "failed")
        self.assertIn("Unsaved project data found", job["result"]["error"])
        self.assertEqual(self.ran, [])

    def test_commands_behind_the_waiting_one_keep_their_order(self):
        threading.Timer(0.3, lambda: setattr(self, "dialog", None)).start()
        order: list[str] = []
        self.srv.ACTION_MAP["first"] = lambda p: order.append("first") or {"success": True}
        self.srv.ACTION_MAP["second"] = lambda p: order.append("second") or {"success": True}
        t = threading.Thread(target=self.srv._execute_sync, args=("first", {}, 5))
        t.start()
        time.sleep(0.05)
        self.srv._execute_sync("second", {}, timeout=5)
        t.join(5)
        self.assertEqual(order, ["first", "second"])

    def test_actions_built_to_run_inside_their_own_dialog_are_not_held(self):
        self.srv.MODAL_WAIT_SECONDS = 30
        for action in ("silent_configure_and_click", "silent_finalize", "get_export_status",
                       "get_mixer_status", "exec_python"):
            with self.subTest(action=action):
                self.srv.ACTION_MAP[action] = lambda p, a=action: {"success": True, "ran": a}
                status, body = self.srv._execute_sync(action, {"code": "result=1"}, timeout=2)
                self.assertEqual((status, body["result"]["ran"]), (200, action))

    def test_waits_five_seconds_by_default(self):
        self.assertEqual(_support.fresh_import("server").MODAL_WAIT_SECONDS, 5.0)


class _Widget:
    def __init__(self, title="", visible=True, modal=True):
        self._title, self._visible, self._modal = title, visible, modal

    def windowTitle(self):
        return self._title

    def isVisible(self):
        return self._visible

    def isModal(self):
        return self._modal


class _Dialog(_Widget):
    pass


class _MessageBox(_Dialog):
    def __init__(self, title, text, informative="", **kw):
        super().__init__(title, **kw)
        self._text, self._informative = text, informative

    def text(self):
        return self._text

    def informativeText(self):
        return self._informative


class ActiveModalDialogTest(unittest.TestCase):
    """server._active_modal_dialog reads PySide2; outside CC5 (no PySide2 or no QApplication) it says None."""

    def setUp(self):
        self.srv = _support.fresh_import("server")
        self.app = types.SimpleNamespace(modal=None, tops=[], exists=True)
        app = self.app

        class QApplication:
            @staticmethod
            def instance():
                return object() if app.exists else None

            @staticmethod
            def activeModalWidget():
                return app.modal

            @staticmethod
            def topLevelWidgets():
                return list(app.tops)

        widgets = types.ModuleType("PySide2.QtWidgets")
        widgets.QApplication, widgets.QDialog, widgets.QMessageBox = QApplication, _Dialog, _MessageBox
        pkg = types.ModuleType("PySide2")
        pkg.QtWidgets = widgets
        p = mock.patch.dict(sys.modules, {"PySide2": pkg, "PySide2.QtWidgets": widgets})
        p.start()
        self.addCleanup(p.stop)

    def test_none_without_pyside2(self):
        with mock.patch.dict(sys.modules, {"PySide2": None, "PySide2.QtWidgets": None}):
            self.assertIsNone(self.srv._active_modal_dialog())

    def test_none_without_a_qapplication(self):
        self.app.exists = False
        self.app.modal = _MessageBox(*RECOVERY)
        self.assertIsNone(self.srv._active_modal_dialog())

    def test_none_when_no_dialog_is_open(self):
        self.app.tops = [_Widget("Character Creator 5", modal=False), _Dialog("Hidden", visible=False),
                         _Dialog("Modeless panel", modal=False)]
        self.assertIsNone(self.srv._active_modal_dialog())

    def test_active_modal_message_box(self):
        self.app.modal = _MessageBox(*RECOVERY)
        self.assertEqual(self.srv._active_modal_dialog(), RECOVERY)

    def test_active_modal_widget_that_is_not_a_message_box(self):
        self.app.modal = _Dialog("Export FBX")
        self.assertEqual(self.srv._active_modal_dialog(), ("Export FBX", ""))

    def test_untitled_modal_widget_is_not_named_by_its_qt_class(self):
        # Live CC5 5.13 can start with its full-screen "What's New" page: an untitled application-modal QWidget.
        # Its Qt class name means nothing to the user, so it stays untitled and the error describes the page.
        page = _Widget("")
        page.metaObject = lambda: types.SimpleNamespace(className=lambda: "CRLWhatsNewWebEngineWidget")
        self.app.modal = page
        self.assertEqual(self.srv._active_modal_dialog(), ("", ""))

    def test_visible_modal_message_box_among_top_level_widgets(self):
        self.app.tops = [_Widget("Character Creator 5", modal=False), _MessageBox(*RECOVERY)]
        self.assertEqual(self.srv._active_modal_dialog(), RECOVERY)

    def test_qt_errors_mean_no_dialog(self):
        self.app.modal = mock.Mock(windowTitle=mock.Mock(side_effect=RuntimeError("deleted")))
        self.assertIsNone(self.srv._active_modal_dialog())

    def test_a_serial_in_the_title_or_the_text_is_redacted(self):
        # F-85: _describe_modal is where every message about a dialog gets its text from. Made-up serials.
        self.app.modal = _MessageBox("SN: QX7-ABCDE-12345-FGHIJ", "Licence Key: ABCDE-12345-FGHIJ-67890")
        self.assertEqual(self.srv._active_modal_dialog(), ("SN: (serial)", "Licence Key: (serial)"))

    def test_a_serial_in_the_informative_text_after_its_label_is_redacted(self):
        # P-4: the label ends the message box's text and the value is its informative text. Made-up keys.
        self.app.modal = _MessageBox("Activation", "Thank you for registering.\nSerial Number:", "XK29QZ7731ABCD")
        self.assertEqual(self.srv._active_modal_dialog(),
                         ("Activation", "Thank you for registering.\nSerial Number:\n(serial)"))
        self.app.modal = _MessageBox("Activation", "License Key", "QWERTYUIOPASDF")
        self.assertEqual(self.srv._active_modal_dialog(), ("Activation", "License Key\n(serial)"))
        self.app.modal = _MessageBox("Character Creator 5", RECOVERY[1], "Your changes were saved automatically.")
        self.assertEqual(self.srv._active_modal_dialog(),
                         ("Character Creator 5", f"{RECOVERY[1]}\nYour changes were saved automatically."))


class RedactSecretsTest(unittest.TestCase):
    """F-85: a licence serial in a dialog never reaches a message. Made-up serials only."""

    LABELS = ("S/N", "SN", "Serial", "Serial No", "Serial Number", "Licence", "License", "Licence Key", "License Key",
              "Product Key", "Activation Code", "Registration Code")

    def setUp(self):
        self.redact = _support.fresh_import("server")._redact_secrets

    def test_the_value_after_each_serial_or_licence_label_is_replaced(self):
        for label in self.LABELS:
            for separator in (" : ", ": ", " # ", "#"):
                with self.subTest(label=label, separator=separator):
                    self.assertEqual(self.redact(f"{label}{separator}XK29QZ7731"), f"{label}{separator}(serial)")

    def test_labels_match_in_any_case_and_without_a_separator_when_the_value_holds_a_digit(self):
        self.assertEqual(self.redact("serial number: XK29QZ"), "serial number: (serial)")
        self.assertEqual(self.redact("S/N XK29QZ7731"), "S/N (serial)")
        self.assertEqual(self.redact("LICENSE KEY 7731-ab and more"), "LICENSE KEY (serial) and more")

    def test_a_key_of_dash_joined_groups_is_replaced_anywhere(self):
        self.assertEqual(self.redact("Your key ABCDE-12345-FGHIJ-67890 is active."), "Your key (serial) is active.")
        self.assertEqual(self.redact("abcd-1234-efgh"), "(serial)")

    def test_the_value_on_the_line_after_its_label_is_replaced(self):
        # P-4: a dialog's text is its labels joined by newlines, so the value can sit on the next line.
        self.assertEqual(self.redact("Serial Number:\nXK29QZ7731ABCD\nProduct Version : 1.0.0824.1"),
                         "Serial Number:\n(serial)\nProduct Version : 1.0.0824.1")
        self.assertEqual(self.redact("S/N\nXK29QZ7731"), "S/N\n(serial)")
        self.assertEqual(self.redact("Your license\nhas expired."), "Your license\nhas expired.")  # no digit, no ':'

    def test_the_live_about_box_keeps_everything_but_the_serial(self):
        self.assertEqual(self.redact("S/N : ABCDE-12345-FGHIJ-67890"), "S/N : (serial)")
        for text in ("CCSkinGen", "Product Version : 1.0.0824.1", "www.reallusion.com",
                     "Copyright © 2022-2026 Reallusion, Inc. All rights reserved."):
            with self.subTest(text=text):
                self.assertEqual(self.redact(text), text)

    def test_text_without_a_secret_is_unchanged(self):
        for text in ("The target object layer already exists.\nDo you want to replace the object, or the material only?",
                     "Your license has expired. Renew it in the Reallusion Hub.", RECOVERY[1],
                     "Exported on 2026-10-06 at 15:02", "Mesh-to-MetaHuman", "Licensed to the studio", "Snap to grid",
                     "Serial", ""):
            with self.subTest(text=text):
                self.assertEqual(self.redact(text), text)


if __name__ == "__main__":
    unittest.main()

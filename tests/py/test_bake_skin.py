"""F-84: bake_skin_textures triggers only a real bake command; on CC5 5.13 it opens nothing and returns the manual steps."""
from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

import _support

# Live CC5 5.13 with SkinGen Premium: the SkinGen menu's four items. About (objectName qtSkinGenAboutAction, live) opens
# a modal window with no buttons; the other objectNames stand in for the live ones, which matched "skingen" too.
SKINGEN_MENU = [("About", "qtSkinGenAboutAction"), ("Online Manual", "qtSkinGenOnlineManualAction"),
                ("Video Tutorial", "qtSkinGenVideoTutorialAction"), ("Remove SkinGen Data", "qtSkinGenRemoveDataAction")]
MANUAL = ("Bake the skin by hand in Character Creator 5: open the character's skin editor (SkinGen), set the texture "
          "size to {} and bake.")


class _Action:
    """A QAction."""

    def __init__(self, text, name="", enabled=True):
        self._text, self._name, self._enabled = text, name, enabled
        self.triggered = 0

    def text(self):
        return self._text

    def objectName(self):
        return self._name

    def isEnabled(self):
        return self._enabled

    def trigger(self):
        self.triggered += 1


class _Widget:
    def __init__(self, *actions):
        self._actions = list(actions)

    def actions(self):
        return list(self._actions)


def _fake_qt(widgets, timer_calls):
    qtwidgets = types.ModuleType("PySide2.QtWidgets")
    app = types.SimpleNamespace(allWidgets=lambda: list(widgets))
    qtwidgets.QApplication = types.SimpleNamespace(instance=lambda: app)
    qtcore = types.ModuleType("PySide2.QtCore")
    # Recorded, never run: the action must be triggered directly (F-84).
    qtcore.QTimer = types.SimpleNamespace(singleShot=lambda *args: timer_calls.append(args))
    pkg = types.ModuleType("PySide2")
    pkg.QtWidgets, pkg.QtCore = qtwidgets, qtcore
    return {"PySide2": pkg, "PySide2.QtWidgets": qtwidgets, "PySide2.QtCore": qtcore}


class BakeSkinTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.widgets: list = []
        self.timer_calls: list = []
        p = mock.patch.dict(sys.modules, _fake_qt(self.widgets, self.timer_calls))
        p.start()
        self.addCleanup(p.stop)

    def skingen_menu(self):
        actions = [_Action(text, name) for text, name in SKINGEN_MENU]
        self.widgets.append(_Widget(*actions))
        return actions

    def test_cc5_5_13s_skingen_menu_opens_nothing_and_the_manual_steps_come_back(self):
        menu = self.skingen_menu()
        others = [_Action("Export Head", "qtExportHeadAction"), _Action("&File")]
        self.widgets.append(_Widget(*others))
        r = self.api.bake_skin_textures(2048)
        self.assertEqual([a.triggered for a in menu + others], [0] * 6)
        self.assertEqual(r, {
            "success": False, "manual_step_required": True,
            "error": "CC5 has no Bake / Apply Skin / Skin Editor command the plugin can run, so nothing was opened",
            "instructions": MANUAL.format(2048), "notes": [],
            "candidates_inspected": [{"text": text, "objectName": name} for text, name in SKINGEN_MENU]})
        self.assertEqual(self.timer_calls, [])

    def test_the_bare_skingen_words_no_longer_qualify_an_action(self):
        # The old keywords "skin gen" / "skingen" matched About, whose window with no buttons blocked every command.
        actions = [_Action("SkinGen"), _Action("Skin Gen Premium", "qtSkinGenMenu")]
        self.widgets.append(_Widget(*actions))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual([a.triggered for a in actions], [0, 0])
        self.assertFalse(r["success"])
        self.assertEqual(len(r["candidates_inspected"]), 2)

    def test_a_bake_command_is_triggered_directly_and_named(self):
        menu = self.skingen_menu()
        bake = _Action("Bake Skin Textures", "qtBakeSkinTexturesAction")
        self.widgets.append(_Widget(bake))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual(bake.triggered, 1)
        self.assertEqual([a.triggered for a in menu], [0, 0, 0, 0])
        self.assertEqual(self.timer_calls, [])  # not QTimer.singleShot: the reply comes after the action ran
        self.assertEqual(r, {
            "success": True, "resolution": 4096, "triggered_action": "Bake Skin Textures", "manual_step_required": True,
            "instructions": "CC5 opened 'Bake Skin Textures'. Set the texture size to 4096 there and run the bake: the "
                            "plugin cannot press it.",
            "notes": ["Triggered QAction: text='Bake Skin Textures' objectName='qtBakeSkinTexturesAction'"],
            "candidates_inspected": [{"text": text, "objectName": name} for text, name in SKINGEN_MENU]
            + [{"text": "Bake Skin Textures", "objectName": "qtBakeSkinTexturesAction"}]})

    def test_no_texture_size_is_set_on_a_throwaway_export_setting(self):
        # The old step 1 set the size on an RExportFbxSetting that no export used.
        self.skingen_menu()
        self.api.bake_skin_textures(4096)
        self.rl.RExportFbxSetting.assert_not_called()

    def test_bake_comes_before_apply_and_apply_before_the_skin_editor(self):
        editor, apply_skin, bake = _Action("Skin Editor"), _Action("Apply SkinGen"), _Action("Bake Texture", "qtBake")
        self.widgets.append(_Widget(editor, apply_skin, bake))
        self.api.bake_skin_textures(1024)
        self.assertEqual((editor.triggered, apply_skin.triggered, bake.triggered), (0, 0, 1))
        editor, apply_skin = _Action("Skin Editor"), _Action("Apply Skin Gen")
        self.widgets[:] = [_Widget(editor, apply_skin)]
        r = self.api.bake_skin_textures(1024)
        self.assertEqual((editor.triggered, apply_skin.triggered, r["triggered_action"]), (0, 1, "Apply Skin Gen"))

    def test_help_destructive_and_disabled_commands_never_run(self):
        actions = [_Action("Skin Editor Help"), _Action("Delete Skin Editor Data"),
                   _Action("Bake Skin Textures", enabled=False), _Action("Bake Skin Textures Online", "qtBakeSkin")]
        self.widgets.append(_Widget(*actions))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual([a.triggered for a in actions], [0, 0, 0, 0])
        self.assertEqual(r["error"], self.api.BAKE_COMMAND_MISSING)
        self.assertEqual(len(r["candidates_inspected"]), 4)

    def test_candidates_inspected_lists_each_command_once_and_at_most_20(self):
        many = [_Action(f"Skin Layer {i}") for i in range(30)]
        self.widgets.append(_Widget(*many))
        self.widgets.append(_Widget(many[0]))  # the same command in a second widget (a menu and a toolbar)
        r = self.api.bake_skin_textures(4096)
        texts = [c["text"] for c in r["candidates_inspected"]]
        self.assertEqual(texts, [f"Skin Layer {i}" for i in range(20)])

    def test_a_command_that_fails_to_trigger_returns_the_manual_steps(self):
        bake = _Action("Bake Skin Textures")
        bake.trigger = mock.Mock(side_effect=RuntimeError("wrapped C/C++ object of type QAction has been deleted"))
        self.widgets.append(_Widget(bake))
        r = self.api.bake_skin_textures(512)
        self.assertEqual((r["success"], r["manual_step_required"], r["instructions"]), (False, True, MANUAL.format(512)))
        self.assertEqual(r["error"], "wrapped C/C++ object of type QAction has been deleted")

    def test_without_a_qapplication_or_pyside2_the_manual_steps_come_back(self):
        sys.modules["PySide2.QtWidgets"].QApplication = types.SimpleNamespace(instance=lambda: None)
        r = self.api.bake_skin_textures(256)
        self.assertEqual(r, {"success": False, "manual_step_required": True,
                             "error": "QApplication.instance() returned None", "instructions": MANUAL.format(256),
                             "notes": [], "candidates_inspected": []})
        with mock.patch.dict(sys.modules, {"PySide2": None}):
            r = self.api.bake_skin_textures(256)
        self.assertTrue(r["error"].startswith("PySide2 not available"))
        self.assertEqual(r["instructions"], MANUAL.format(256))

    def test_the_manual_steps_name_no_menu_path(self):
        # No menu path has been verified on CC5 5.13, so the old "Modify panel -> Skin Editor" is not repeated.
        r = self.api.bake_skin_textures(4096)
        self.assertNotIn("->", r["instructions"])
        self.assertNotIn("Modify panel", r["instructions"])

    def test_an_unsupported_resolution_is_refused(self):
        for bad in (300, 8192, True):
            with self.subTest(resolution=bad):
                r = self.api.bake_skin_textures(bad)
                self.assertFalse(r["success"])
                self.assertIn("Unsupported resolution", r["error"])
                self.assertEqual(r["candidates_inspected"], [])


if __name__ == "__main__":
    unittest.main()

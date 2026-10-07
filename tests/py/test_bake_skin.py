"""F-84, F-87: bake_skin_textures triggers only a bake, apply-skin or skin-editor command, found by its words; a disabled
one is named and never run. CC5 5.13's bake command was disabled in every state tried live: then it runs nothing and
returns the manual steps."""
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
# F-87 (live CC5 5.13): the Character menu's bake command as Qt names it. It was disabled with no character, with CC4
# Kevin and with Kevin wearing a SkinGen preset, so nobody has seen it run.
BAKE_ALL = ("Bake All &Skin Textures", "qtBakeAllSkinTextureAction")
BAKE_ALL_SHOWN = {"text": "Bake All Skin Textures", "objectName": "qtBakeAllSkinTextureAction"}
# Live 2026-10-07: also disabled, and no skin bake; the objectName stands in for the live one, which was not read.
SUBSTANCE_BAKE = ("Bake All &Substance Textures", "qtBakeAllSubstanceTextureAction")
MANUAL = ("Bake the skin by hand in Character Creator 5: open the character's skin editor (SkinGen), set the texture "
          "size to {} and bake.")
# F-87 (Chad, 2026-10-07): when CC5 enables its bake command.
ENABLED_WHEN = "CC5 enables {} once the character has SkinGen layers applied in the Appearance Editor."


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


class BakeCommandWordsTest(unittest.TestCase):
    """F-87: a QAction's menu text and objectName are compared as words, not substrings."""

    def setUp(self):
        _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")

    def kind(self, label):
        return self.api._bake_command_kind(self.api._action_words(label))

    def test_the_menu_text_drops_its_mnemonics(self):
        self.assertEqual(self.api._menu_text("Bake All &Skin Textures"), "Bake All Skin Textures")
        self.assertEqual(self.api._menu_text("&File"), "File")
        self.assertEqual(self.api._menu_text("Skin && Hair"), "Skin & Hair")  # "&&" is a literal "&"

    def test_camel_case_and_underscores_split_into_lower_case_words(self):
        words = self.api._action_words
        self.assertEqual(words("qtBakeAllSkinTextureAction"), ["qt", "bake", "all", "skin", "texture", "action"])
        self.assertEqual(words("Bake All Skin Textures"), ["bake", "all", "skin", "textures"])
        self.assertEqual(words("bake_skin_textures"), ["bake", "skin", "textures"])
        self.assertEqual(words("actionBakeHDSkin"), ["action", "bake", "hd", "skin"])
        self.assertEqual(words(""), [])

    def test_cc5_5_13s_bake_command_is_a_bake_command_by_its_text_and_by_its_object_name(self):
        text, name = BAKE_ALL
        self.assertEqual(self.kind(self.api._menu_text(text)), "bake")
        self.assertEqual(self.kind(name), "bake")

    def test_the_kind_comes_from_whole_words_and_keeps_the_old_phrases_word_order(self):
        for label, expected in [
                ("Bake Skin Textures", "bake"), ("qt_bake_skin_textures", "bake"), ("Bake SkinGen Texture", "bake"),
                ("Apply Skin and Bake", "bake"),
                ("Apply SkinGen", "apply_skin"), ("Apply Skin Gen", "apply_skin"), ("apply skingen", "apply_skin"),
                ("qtApplySkinAction", "apply_skin"),
                ("Skin Editor", "skin_editor"), ("qtSkinEditorAction", "skin_editor"),
                ("Bakery Skin", None), ("Bake Lighting", None), ("Apply Skinny Jeans", None), ("Skin Apply", None),
                ("Editor Skin", None), ("SkinGen Editor", None), ("Skin Layers", None), ("SkinGen", None), ("", None)]:
            with self.subTest(label=label):
                self.assertEqual(self.kind(label), expected)

    def test_a_bake_command_needs_the_word_skin_or_skingen(self):
        # Live 2026-10-07: with texture(s) enough, the rule also took "Bake All Substance Textures", which is no skin
        # bake, and it would take an objectName such as qtBakeLightTextureAction.
        for label in (self.api._menu_text(SUBSTANCE_BAKE[0]), SUBSTANCE_BAKE[1], "qtBakeLightTextureAction",
                      "Bake Texture", "Bake All Textures"):
            with self.subTest(label=label):
                self.assertIsNone(self.kind(label))
        self.assertEqual(self.api._command_kind(self.api._menu_text(BAKE_ALL[0]), BAKE_ALL[1]), "bake")
        self.assertIsNone(self.api._command_kind(self.api._menu_text(SUBSTANCE_BAKE[0]), SUBSTANCE_BAKE[1]))
        # The best kind either label names: the objectName's bake beats the text's skin editor.
        self.assertEqual(self.api._command_kind("Skin Editor", "qtBakeSkinAction"), "bake")

    def test_skip_words_are_matched_as_words_or_word_beginnings(self):
        skipped = self.api._bake_skipped
        for label in ("About", "qtSkinGenOnlineManualAction", "Video Tutorial", "Remove SkinGen Data",
                      "Skin Editor Help", "Delete Skin Editor Data", "Skin Editor Tutorials", "Removed Skin Textures"):
            with self.subTest(label=label):
                self.assertTrue(skipped(self.api._action_words(label)))
        for label in BAKE_ALL + ("Skin Editor", "Apply SkinGen"):
            with self.subTest(label=label):
                self.assertFalse(skipped(self.api._action_words(self.api._menu_text(label))))


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

    def test_skingens_menu_alone_opens_nothing_and_the_manual_steps_come_back(self):
        menu = self.skingen_menu()
        others = [_Action("Export Head", "qtExportHeadAction"), _Action("&File")]
        self.widgets.append(_Widget(*others))
        r = self.api.bake_skin_textures(2048)
        self.assertEqual([a.triggered for a in menu + others], [0] * 6)
        self.assertEqual(r, {
            "success": False, "manual_step_required": True,
            "error": "CC5 has no Bake / Apply Skin / Skin Editor command the plugin can run, so nothing was opened",
            "instructions": MANUAL.format(2048), "notes": [],
            "candidates_inspected": [{"text": text, "objectName": name} for text, name in SKINGEN_MENU],
            "disabled_candidates": []})
        self.assertEqual(self.timer_calls, [])

    def test_the_bare_skingen_words_no_longer_qualify_an_action(self):
        # The old keywords "skin gen" / "skingen" matched About, whose window with no buttons blocked every command.
        actions = [_Action("SkinGen"), _Action("Skin Gen Premium", "qtSkinGenMenu")]
        self.widgets.append(_Widget(*actions))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual([a.triggered for a in actions], [0, 0])
        self.assertFalse(r["success"])
        self.assertEqual(len(r["candidates_inspected"]), 2)

    def test_cc5_5_13s_disabled_bake_command_is_named_and_nothing_runs(self):
        # F-87 (live): the "Commands looked at" list showed it next to SkinGen's menu, and it was disabled.
        menu = self.skingen_menu()
        bake_all = _Action(*BAKE_ALL, enabled=False)
        self.widgets.append(_Widget(bake_all))
        r = self.api.bake_skin_textures(2048)
        self.assertEqual([a.triggered for a in menu + [bake_all]], [0] * 5)
        self.assertEqual(r, {
            "success": False, "manual_step_required": True,
            "error": "CC5's \"Bake All Skin Textures\" command is disabled right now, so nothing was run. "
                     + ENABLED_WHEN.format("it"),
            "instructions": MANUAL.format(2048), "notes": [],
            "candidates_inspected": [{"text": text, "objectName": name} for text, name in SKINGEN_MENU]
            + [BAKE_ALL_SHOWN],
            "disabled_candidates": [BAKE_ALL_SHOWN]})
        self.assertEqual(self.timer_calls, [])
        self.assertEqual(r["error"], "CC5's \"Bake All Skin Textures\" command is disabled right now, so nothing was "
                                     "run. CC5 enables it once the character has SkinGen layers applied in the "
                                     "Appearance Editor.")

    def test_the_substance_bake_is_neither_named_nor_run(self):
        # Live 2026-10-07 (batch E plugin): 'CC5's "Bake All Skin Textures" and "Bake All Substance Textures" commands
        # are disabled right now', and the list of commands looked at left the Substance bake out.
        bake_all = _Action(*BAKE_ALL, enabled=False)
        substance = _Action(*SUBSTANCE_BAKE, enabled=False)
        self.widgets.append(_Widget(bake_all, substance))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual(r["error"], "CC5's \"Bake All Skin Textures\" command is disabled right now, so nothing was "
                                     "run. " + ENABLED_WHEN.format("it"))
        self.assertEqual(r["disabled_candidates"], [BAKE_ALL_SHOWN])
        self.assertNotIn("Substance", str(r))
        # Enabled, it is still no skin bake: nothing runs.
        substance._enabled = True
        r = self.api.bake_skin_textures(4096)
        self.assertEqual((substance.triggered, bake_all.triggered, r["success"]), (0, 0, False))

    def test_every_command_the_reply_names_is_in_the_list_of_commands_looked_at(self):
        # F-87 (live): the reply named a disabled command that "Commands looked at" left out. Past the limit of 20
        # skin-related actions, the commands that qualify are still listed.
        layers = [_Action(f"Skin Layer {i}") for i in range(25)]
        bake_all, editor = _Action(*BAKE_ALL, enabled=False), _Action("Skin Editor", "qtSkinEditorAction")
        self.widgets.append(_Widget(*layers, bake_all, editor))
        r = self.api.bake_skin_textures(2048)
        listed = r["candidates_inspected"]
        self.assertEqual(listed[:20], [{"text": f"Skin Layer {i}", "objectName": ""} for i in range(20)])
        self.assertEqual(listed[20:], [BAKE_ALL_SHOWN, {"text": "Skin Editor", "objectName": "qtSkinEditorAction"}])
        self.assertEqual((r["triggered_action"], r["disabled_candidates"]), ("Skin Editor", [BAKE_ALL_SHOWN]))
        for named in r["disabled_candidates"] + [{"text": r["triggered_action"], "objectName": "qtSkinEditorAction"}]:
            self.assertIn(named, listed)

    def test_when_cc5_enables_it_is_said_only_of_bake_commands(self):
        cases = [
            # A Skin Editor alone: when CC5 enables it is not known.
            ([("Skin &Editor", "qtSkinEditorAction")],
             "CC5's \"Skin Editor\" command is disabled right now, so nothing was run"),
            # Two bake commands: "them".
            ([BAKE_ALL, ("Bake Skin Texture", "")],
             "CC5's \"Bake All Skin Textures\" and \"Bake Skin Texture\" commands are disabled right now, so nothing "
             "was run. " + ENABLED_WHEN.format("them")),
            # A bake command beside an Apply Skin command: the bake command is named.
            ([("Apply SkinGen", ""), BAKE_ALL],
             "CC5's \"Bake All Skin Textures\" and \"Apply SkinGen\" commands are disabled right now, so nothing was "
             "run. " + ENABLED_WHEN.format("\"Bake All Skin Textures\"")),
        ]
        for commands, error in cases:
            with self.subTest(commands=commands):
                self.widgets[:] = [_Widget(*[_Action(text, name, enabled=False) for text, name in commands])]
                r = self.api.bake_skin_textures(1024)
                self.assertEqual(r["error"], error)
                self.assertEqual(r["instructions"], MANUAL.format(1024))

    def test_cc5_5_13s_bake_command_when_enabled_is_triggered_and_its_result_is_not_claimed(self):
        menu = self.skingen_menu()
        bake_all = _Action(*BAKE_ALL)
        self.widgets.append(_Widget(bake_all))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual(bake_all.triggered, 1)
        self.assertEqual([a.triggered for a in menu], [0, 0, 0, 0])
        self.assertEqual(self.timer_calls, [])  # not QTimer.singleShot: the reply comes after the action ran
        self.assertEqual(r, {
            "success": True, "resolution": 4096, "triggered_action": "Bake All Skin Textures", "command_kind": "bake",
            "manual_step_required": True,
            "instructions": "This bridge has not yet seen CC5's \"Bake All Skin Textures\" command run and could not "
                            "pass the texture size (4096) to it: check what it did with captures and get_cc5_dialog.",
            "notes": ["Triggered QAction: text='Bake All &Skin Textures' objectName='qtBakeAllSkinTextureAction'"],
            "candidates_inspected": [{"text": text, "objectName": name} for text, name in SKINGEN_MENU]
            + [BAKE_ALL_SHOWN],
            "disabled_candidates": []})
        # A command that bakes opens no panel, and nothing has been seen to come of it.
        self.assertNotIn("opened", r["instructions"])

    def test_a_bake_command_found_by_its_object_name_alone_is_named_by_it(self):
        bake_all = _Action("", BAKE_ALL[1])
        self.widgets.append(_Widget(bake_all))
        r = self.api.bake_skin_textures(1024)
        self.assertEqual(bake_all.triggered, 1)
        self.assertEqual((r["triggered_action"], r["command_kind"]), ("qtBakeAllSkinTextureAction", "bake"))

    def test_apply_skin_and_skin_editor_commands_keep_the_opened_wording(self):
        for text, name, kind in [("Skin &Editor", "qtSkinEditorAction", "skin_editor"),
                                 ("Apply SkinGen", "", "apply_skin")]:
            with self.subTest(text=text):
                action = _Action(text, name)
                self.widgets[:] = [_Widget(action)]
                r = self.api.bake_skin_textures(1024)
                label = text.replace("&", "")
                self.assertEqual(action.triggered, 1)
                self.assertEqual((r["success"], r["triggered_action"], r["command_kind"]), (True, label, kind))
                self.assertEqual(r["instructions"], f"CC5 opened '{label}'. Set the texture size to 1024 there and "
                                                    "run the bake: the plugin cannot press it.")

    def test_no_texture_size_is_set_on_a_throwaway_export_setting(self):
        # The old step 1 set the size on an RExportFbxSetting that no export used.
        self.skingen_menu()
        self.api.bake_skin_textures(4096)
        self.rl.RExportFbxSetting.assert_not_called()

    def test_bake_comes_before_apply_and_apply_before_the_skin_editor(self):
        editor, apply_skin = _Action("Skin Editor"), _Action("Apply SkinGen")
        bake = _Action("Bake Skin Texture", "qtBakeSkin")
        self.widgets.append(_Widget(editor, apply_skin, bake))
        self.api.bake_skin_textures(1024)
        self.assertEqual((editor.triggered, apply_skin.triggered, bake.triggered), (0, 0, 1))
        editor, apply_skin = _Action("Skin Editor"), _Action("Apply Skin Gen")
        self.widgets[:] = [_Widget(editor, apply_skin)]
        r = self.api.bake_skin_textures(1024)
        self.assertEqual((editor.triggered, apply_skin.triggered, r["triggered_action"]), (0, 1, "Apply Skin Gen"))

    def test_help_and_destructive_words_win_over_a_command_match_enabled_or_not(self):
        menu = self.skingen_menu()
        actions = [_Action("Skin Editor Help"), _Action("Delete Skin Editor Data"),
                   _Action("Bake Skin Textures Online", "qtBakeSkin"),
                   _Action("Bake All Skin Textures", "qtBakeAllSkinTexturesTutorialAction"),
                   _Action("Skin Editor Tutorials"), _Action("Remove Bake Skin Data", enabled=False),
                   _Action("&About Bake Skin Textures", enabled=False)]
        self.widgets.append(_Widget(*actions))
        r = self.api.bake_skin_textures(4096)
        self.assertEqual([a.triggered for a in menu + actions], [0] * 11)
        self.assertEqual(r["error"], self.api.BAKE_COMMAND_MISSING)
        self.assertEqual(r["disabled_candidates"], [])
        self.assertEqual(len(r["candidates_inspected"]), 11)

    def test_disabled_commands_are_named_best_first_and_each_once(self):
        editor = _Action("Skin Editor", enabled=False)
        in_menu, in_toolbar = _Action(*BAKE_ALL, enabled=False), _Action(*BAKE_ALL, enabled=False)
        self.widgets.extend([_Widget(editor), _Widget(in_menu), _Widget(in_toolbar)])
        r = self.api.bake_skin_textures(4096)
        self.assertEqual([a.triggered for a in (editor, in_menu, in_toolbar)], [0, 0, 0])
        self.assertEqual(r["error"], "CC5's \"Bake All Skin Textures\" and \"Skin Editor\" commands are disabled right "
                                     "now, so nothing was run. " + ENABLED_WHEN.format("\"Bake All Skin Textures\""))
        self.assertEqual(r["disabled_candidates"], [BAKE_ALL_SHOWN, {"text": "Skin Editor", "objectName": ""}])
        self.assertEqual((r["success"], r["manual_step_required"], r["instructions"]), (False, True, MANUAL.format(4096)))

    def test_an_enabled_skin_editor_opens_and_the_disabled_bake_command_is_listed(self):
        bake_all, editor = _Action(*BAKE_ALL, enabled=False), _Action("Skin Editor")
        self.widgets.append(_Widget(bake_all, editor))
        r = self.api.bake_skin_textures(2048)
        self.assertEqual((bake_all.triggered, editor.triggered), (0, 1))
        self.assertEqual((r["success"], r["triggered_action"], r["command_kind"]), (True, "Skin Editor", "skin_editor"))
        self.assertEqual(r["disabled_candidates"], [BAKE_ALL_SHOWN])

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
                             "notes": [], "candidates_inspected": [], "disabled_candidates": []})
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

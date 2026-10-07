"""Batch C follow-ups (C2): redo after a capture (F-55), and the F-21 refusals the live check found left."""
from __future__ import annotations

import ast
import importlib
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import _support


def _named(name, oid=1):
    o = mock.MagicMock(name=name)
    o.GetName.return_value = name
    o.GetID.return_value = oid
    return o


class RedoAfterCaptureTest(unittest.TestCase):
    """Live (F-55): undo -> capture -> redo said "Redo successful" and the undone change did not come back."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        p = mock.patch.object(self.api, "get_first_avatar", return_value=None)
        p.start()
        self.addCleanup(p.stop)

    def test_redo_is_refused_when_a_capture_holds_the_redo_slot(self):
        self.assertTrue(self.api.undo()["success"])
        self.api._drop_capture_undo_steps(1)  # what capture_viewport does after its render
        self.rl.RGlobal.Redo.reset_mock()
        r = self.api.redo()
        self.assertFalse(r["success"])
        self.assertIn("Nothing of yours to redo", r["error"])
        # Only an undo made in CC5 after the capture is still in CC5's redo history (C2b review).
        self.assertIn("Only something undone in CC5 itself after the capture can still be redone there", r["error"])
        self.rl.RGlobal.Redo.assert_not_called()

    def test_redo_works_after_an_undo_with_no_capture(self):
        self.api.undo()
        self.assertTrue(self.api.redo()["success"])
        self.rl.RGlobal.Redo.assert_called_once()

    def test_an_undo_after_the_capture_can_be_redone_but_not_the_capture_under_it(self):
        self.api._drop_capture_undo_steps(1)
        self.api.undo()
        self.assertTrue(self.api.redo()["success"])
        self.assertFalse(self.api.redo()["success"])
        self.assertEqual(self.rl.RGlobal.Redo.call_count, 1)

    def test_a_capture_that_recorded_nothing_leaves_redo_alone(self):
        self.api.undo()
        self.api._drop_capture_undo_steps(0)
        self.assertTrue(self.api.redo()["success"])

    def test_a_capture_whose_own_undo_failed_still_holds_the_redo_slot(self):
        # The capture's step was recorded either way, and recording it cleared CC5's redo history.
        self.api.undo()
        self.rl.RGlobal.Undo.side_effect = RuntimeError("SWIG")
        self.api._drop_capture_undo_steps(1)
        self.rl.RGlobal.Redo.reset_mock()
        self.assertFalse(self.api.redo()["success"])
        self.rl.RGlobal.Redo.assert_not_called()

    def test_the_redo_slots_survive_a_reload(self):
        # /reload re-imports the module in place; a fresh list would forget the capture (C2 review).
        self.api._drop_capture_undo_steps(1)
        reloaded = importlib.reload(self.api)
        self.assertFalse(reloaded.redo()["success"])

    def test_a_change_after_the_undo_is_not_seen_so_redo_still_asks_cc5(self):
        # Known limit, stated in redo's description: RLPy's Undo/Redo report nothing, so after undo -> a new
        # change -> redo, CC5 has nothing left to redo and the bridge cannot tell. It asks CC5 and says so.
        avatar = mock.MagicMock()
        with mock.patch.object(self.api, "get_first_avatar", return_value=avatar), \
                mock.patch.object(self.api, "_unknown_morph_ids", return_value=[]):
            self.api.undo()
            self.assertTrue(self.api.set_morph_value("pack_jaw10", 0.5)["success"])
            self.rl.RGlobal.Redo.reset_mock()
            self.assertTrue(self.api.redo()["success"])
        self.rl.RGlobal.Redo.assert_called_once()


class RedoThroughCaptureViewportTest(unittest.TestCase):
    """The F-55 guard as capture_viewport engages it, and the reply F-58's TypeScript fix depends on."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        param = mock.MagicMock()
        param.kCommon.nOutputSizeWidth = 1280
        param.kCommon.nOutputSizeHeight = 720
        self.rl.RGlobal.GetRenderExportImageParameter.return_value = param
        p = mock.patch.object(self.api, "get_first_avatar", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        self.out = os.path.join(tempfile.mkdtemp(), "shot.png")

    def _renders(self, writes):
        attempts = iter(writes)

        def render(path):
            if next(attempts, False):
                with open(path, "wb") as f:
                    f.write(b"png")
        self.rl.RGlobal.RenderImage.side_effect = render

    def test_undo_capture_redo_is_refused(self):
        # Live (F-55): this said "Redo successful" and the undone change did not come back.
        self.api.undo()
        self._renders([True])
        self.assertTrue(self.api.capture_viewport(self.out, 1280, 720)["success"])
        self.rl.RGlobal.Redo.reset_mock()
        r = self.api.redo()
        self.assertFalse(r["success"])
        self.assertIn("Nothing of yours to redo", r["error"])
        self.rl.RGlobal.Redo.assert_not_called()

    def test_a_capture_that_recorded_no_step_leaves_redo_to_cc5(self):
        self.api.undo()
        self._renders([False, False])
        with mock.patch.object(self.api, "_capture_window_screenshot"):
            self.api.capture_viewport(self.out, 1280, 720)
        self.rl.RGlobal.Redo.reset_mock()
        self.assertTrue(self.api.redo()["success"])
        self.rl.RGlobal.Redo.assert_called_once()

    def test_the_window_screenshot_gets_its_path_from_the_environment(self):
        # An argument after -Command is appended to the command text, never bound to a param() block: the fallback
        # ran with an empty path and failed every time (C2b review; checked with a harmless script).
        with mock.patch("subprocess.run") as run:
            run.return_value = mock.Mock(returncode=0, stderr=b"")
            self.api._capture_window_screenshot(self.out)
        argv, kwargs = run.call_args[0][0], run.call_args[1]
        self.assertEqual(argv[:4], ["powershell", "-NoProfile", "-NonInteractive", "-Command"])
        self.assertEqual(len(argv), 5)  # nothing after the script
        self.assertIn("$OutputPath = $env:CC5_CAP_OUT", argv[4])
        self.assertNotIn(self.out, argv[4])  # the path is data, never script text
        self.assertEqual(kwargs["env"]["CC5_CAP_OUT"], self.out)
        # F-64: no console window may open over CC5 while CopyFromScreen copies that area.
        self.assertEqual(kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))
        script = argv[4]
        self.assertLess(script.index("Add-Type -AssemblyName System.Windows.Forms"),
                        script.index("[System.Windows.Forms.Screen]"))

    def test_a_render_too_large_to_send_returns_its_path_and_a_warning(self):
        self._renders([True])
        with mock.patch.object(self.api, "MAX_IMAGE_BYTES", 2):
            r = self.api.capture_viewport(self.out, 1280, 720)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["path"], self.out)
        self.assertIn("too large", r["warning"])
        self.assertNotIn("base64", r)


class RefusalWordingTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.avatar.GetClothes.return_value = [_named("Boxers", 11)]
        self.avatar.GetHairs.return_value = [_named("Oval Afro", 12)]
        self.avatar.GetAccessories.return_value = []
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_get_morph_value_refuses_an_unknown_id(self):
        # Live: "Morph 'not_a_real_morph' current value: 0".
        with mock.patch.object(self.api, "_get_all_morph_ids", return_value={"pack_jaw10"}):
            r = self.api.get_morph_value("not_a_real_morph")
            self.assertEqual(r["error"], "Morph not found: not_a_real_morph (find morph IDs with search_morphs)")
            self.avatar.GetAvatarShapingComponent.return_value.GetShapingMorphWeight.return_value = 0.25
            self.assertEqual(self.api.get_morph_value("pack_jaw10")["value"], 0.25)

    def test_get_morph_value_still_reads_when_the_catalog_is_empty(self):
        with mock.patch.object(self.api, "_get_all_morph_ids", return_value=set()):
            self.avatar.GetAvatarShapingComponent.return_value.GetShapingMorphWeight.return_value = 0.5
            self.assertEqual(self.api.get_morph_value("anything")["value"], 0.5)

    def test_get_morph_value_still_reads_when_listing_the_catalog_fails(self):
        # Before C2 the value was read directly; a SWIG error while listing the catalog must not fail the read.
        with mock.patch.object(self.api, "_get_all_morph_ids", side_effect=RuntimeError("SWIG")):
            self.avatar.GetAvatarShapingComponent.return_value.GetShapingMorphWeight.return_value = 0.5
            self.assertEqual(self.api.get_morph_value("anything")["value"], 0.5)

    def test_a_slider_missing_from_a_stale_catalog_is_read_after_one_fresh_read(self):
        # The per-avatar ID cache can predate a slider: the check reads the catalog again before refusing.
        with mock.patch.object(self.api, "_get_all_morph_ids", side_effect=[{"pack_jaw10"}, {"pack_jaw10", "new_slider"}]):
            self.avatar.GetAvatarShapingComponent.return_value.GetShapingMorphWeight.return_value = 0.3
            self.assertEqual(self.api.get_morph_value("new_slider")["value"], 0.3)

    def _catalog(self, ids):
        comp = self.avatar.GetAvatarShapingComponent.return_value
        comp.GetShapingMorphCatergoryNames.return_value = ["Jaw"]
        comp.GetShapingMorphIDs.return_value = list(ids)
        return comp

    def test_the_fresh_read_really_bypasses_the_cached_catalog(self):
        # With the real catalog read: the first read caches the old IDs, so only clearing that cache lets the second
        # read see a slider added since (C2b review: a mocked catalog hid a missing cache clear).
        comp = self._catalog(["pack_jaw10"])
        self.api._get_all_morph_ids()
        comp.GetShapingMorphIDs.return_value = ["pack_jaw10", "new_slider"]
        comp.GetShapingMorphWeight.return_value = 0.3
        self.assertEqual(self.api.get_morph_value("new_slider")["value"], 0.3)
        self.assertIn("new_slider", self.api._morph_id_cache[self.avatar.GetID()])

    def test_set_multiple_morphs_reads_a_stale_catalog_again_before_refusing(self):
        comp = self._catalog(["pack_jaw10"])
        self.api._get_all_morph_ids()
        comp.GetShapingMorphIDs.return_value = ["pack_jaw10", "new_slider"]
        r = self.api.set_multiple_morphs([{"morph_id": "pack_jaw10", "value": 0.1},
                                          {"morph_id": "new_slider", "value": 0.2}])
        self.assertTrue(r["success"], r)
        self.assertEqual(comp.SetShapingMorphWeight.call_count, 2)

    def test_set_multiple_morphs_refuses_unknown_ids_and_changes_nothing(self):
        comp = self._catalog(["pack_jaw10"])
        r = self.api.set_multiple_morphs([{"morph_id": "pack_jaw10", "value": 0.1}, {"morph_id": "nope", "value": 0.2}])
        self.assertEqual(r["error"], "Morph(s) not found: nope (find morph IDs with search_morphs)")
        self.rl.RGlobal.BeginAction.assert_not_called()
        comp.SetShapingMorphWeight.assert_not_called()

    def test_set_morph_value_refuses_an_unknown_id(self):
        comp = self._catalog(["pack_jaw10"])
        r = self.api.set_morph_value("nope", 0.5)
        self.assertEqual(r["error"], "Morph not found: nope (find morph IDs with search_morphs)")
        comp.SetShapingMorphWeight.assert_not_called()

    def test_the_morph_setters_still_write_when_the_catalog_cannot_be_listed(self):
        # As before C2: no catalog, no check (the check must never be what breaks a write).
        comp = self.avatar.GetAvatarShapingComponent.return_value
        comp.GetShapingMorphCatergoryNames.side_effect = RuntimeError("SWIG")
        self.assertTrue(self.api.set_morph_value("pack_jaw10", 0.5)["success"])
        self.assertTrue(self.api.set_multiple_morphs([{"morph_id": "pack_jaw10", "value": 0.1}])["success"])
        self.assertEqual(comp.SetShapingMorphWeight.call_count, 2)

    def _skin(self, params):
        mat = self.avatar.GetMaterialComponent.return_value
        mat.GetMaterialNames.return_value = ["Std_Skin_Head", "Std_Skin_Body"]
        mat.GetShaderParameterNames.side_effect = lambda mesh, m: list(params)
        mat.GetShaderParameter.side_effect = lambda mesh, m, n: list(params[n])
        return mat

    def test_set_skin_shader_suggests_close_matches(self):
        mat = self._skin({"Original Roughness Strength": [0.85], "_Specular": [0.45]})
        r = self.api.set_skin_shader("Original Roughnes Strength", [0.4])
        self.assertIn("Shader parameter not found on the skin materials: Original Roughnes Strength.", r["error"])
        self.assertIn("Close matches: Original Roughness Strength.", r["error"])
        self.assertIn("get_shader_parameters", r["error"])
        mat.SetShaderParameter.assert_not_called()

    def test_set_skin_shader_names_a_wrong_value_count(self):
        self._skin({"Original Roughness Strength": [0.85]})
        r = self.api.set_skin_shader("Original Roughness Strength", [0.1, 0.2])
        self.assertIn("'Original Roughness Strength' does not take 2 value(s) on the skin materials.", r["error"])

    def test_set_skin_shader_says_when_cc5_could_not_read_the_parameter(self):
        mat = self._skin({"Original Roughness Strength": [0.85]})
        mat.GetShaderParameter.side_effect = RuntimeError("SWIG")
        r = self.api.set_skin_shader("Original Roughness Strength", [0.4])
        self.assertTrue(r["error"].startswith("CC5 could not read 'Original Roughness Strength' on the skin materials: "
                                              "CC_Base_Body/Std_Skin_Head: 'Original Roughness Strength' unreadable "
                                              "(SWIG)"), r["error"])
        self.assertNotIn("does not take", r["error"])
        mat.SetShaderParameter.assert_not_called()

    def test_set_skin_shader_without_a_close_match(self):
        self._skin({"Original Roughness Strength": [0.85]})
        r = self.api.set_skin_shader("Not_A_Param", [1.0])
        self.assertEqual(r["error"], "Shader parameter not found on the skin materials: Not_A_Param. "
                                     "get_shader_parameters on CC_Base_Body / Std_Skin_Head shows the names and how "
                                     "many values each takes.")

    def test_set_skin_shader_suggests_only_the_real_close_match(self):
        # F-64 (live): at difflib's default cutoff (0.6) the typo also offered Keep Original Roughness (ratio 0.69)
        # and Chin Roughness Scale (0.61).
        mat = self._skin({"Original Roughness Strength": [0.85], "Keep Original Roughness": [1.0],
                          "Chin Roughness Scale": [1.0], "_Specular": [0.45]})
        r = self.api.set_skin_shader("Original Roughnes Strength", [0.4])
        self.assertIn("Close matches: Original Roughness Strength.", r["error"])
        self.assertNotIn("Keep Original Roughness", r["error"])
        self.assertNotIn("Chin Roughness Scale", r["error"])
        mat.SetShaderParameter.assert_not_called()

    SKIN_HINT = " get_shader_parameters on CC_Base_Body / Std_Skin_Head shows the names and how many values each takes."

    def test_set_skin_shader_says_when_the_parameter_has_no_value(self):
        # F-69: CC5 returns [] for some names (CC4 Kevin's 'SSS Metallic Threshold'); "does not take 1 value(s)" misled.
        no_value = ("'SSS Metallic Threshold' has no value CC5 can read on the skin materials, so it cannot be set."
                    + self.SKIN_HINT)
        mat = self._skin({"SSS Metallic Threshold": [], "Original Roughness Strength": [0.85]})
        r = self.api.set_skin_shader("SSS Metallic Threshold", [0.5])
        self.assertEqual(r["error"], no_value)
        # One skin material lacks it and the other holds no value: the same answer.
        mat.GetShaderParameterNames.side_effect = lambda mesh, m: (
            ["Original Roughness Strength"] if m == "Std_Skin_Body" else ["SSS Metallic Threshold"])
        r = self.api.set_skin_shader("SSS Metallic Threshold", [0.5])
        self.assertEqual(r["error"], no_value)
        self.assertIn("CC_Base_Body/Std_Skin_Body: no 'SSS Metallic Threshold'", r["skipped"])
        self.assertIn("CC_Base_Body/Std_Skin_Head: 'SSS Metallic Threshold' has no value", r["skipped"])
        mat.SetShaderParameter.assert_not_called()
        self.rl.RGlobal.BeginAction.assert_not_called()

    def test_set_skin_shader_refuses_padding_before_reading_cc5(self):
        mat = self._skin({"padding1": [0.0, 0.0, 0.0]})
        r = self.api.set_skin_shader("padding1", [0, 0, 0])
        self.assertEqual(r, {"success": False,
                             "error": "'padding1' is shader padding (filler), not a setting, so it is not set."})
        mat.GetMaterialNames.assert_not_called()
        mat.SetShaderParameter.assert_not_called()

    def test_set_eye_color_refuses_corneas_whose_iris_colour_has_no_value(self):
        mat = self.avatar.GetMaterialComponent.return_value
        params = {"Iris Color": [], "Iris Depth Scale": [0.743]}
        mat.GetShaderParameterNames.side_effect = lambda mesh, m: list(params)
        mat.GetShaderParameter.side_effect = lambda mesh, m, n: list(params[n])
        r = self.api.set_eye_color(0.1, 0.5, 0.2)
        self.assertFalse(r["success"])
        self.assertTrue(r["error"].startswith("This character's eyes have no 'Iris Color' shader parameter"), r)
        self.assertIn("CC_Base_Eye/Std_Cornea_R: 'Iris Color' has no value", r["skipped"])
        mat.SetShaderParameter.assert_not_called()
        self.rl.RGlobal.BeginAction.assert_not_called()

    def test_set_item_visible_says_what_is_worn(self):
        # Live: "Item not found: nope" alone.
        self.rl.RScene.FindObject.return_value = None
        self.rl.RScene.FindObjects.return_value = []
        r = self.api.set_item_visible("nope", True)
        self.assertEqual(r["error"], "Item not found: nope. Worn now: Boxers, Oval Afro. "
                                     "Props and lights: see get_scene_objects.")

    def test_a_named_delete_that_matches_nothing_lists_the_characters_and_records_nothing(self):
        self.rl.RScene.GetAvatars.return_value = [_named("Kevin", 1), _named("Camila", 2)]
        r = self.api.delete_avatar("Nobody")
        self.assertEqual(r["error"], "Avatar not found: Nobody. Characters in the scene: Kevin, Camila.")
        self.rl.RGlobal.BeginAction.assert_not_called()
        self.rl.RScene.RemoveObject.assert_not_called()

    def test_a_named_delete_removes_only_that_character(self):
        kevin, camila = _named("Kevin", 1), _named("Camila", 2)
        self.rl.RScene.GetAvatars.return_value = [kevin, camila]
        r = self.api.delete_avatar("Camila")
        self.assertEqual(r["removed"], ["Camila"])
        self.rl.RScene.RemoveObject.assert_called_once_with(camila)

    def test_the_fbx_hint_warns_to_save_first(self):
        r = self.api.load_asset(os.path.join(tempfile.gettempdir(), "box.fbx"))
        self.assertEqual(r["error"], "Disallowed file extension: .fbx (a prop or clothing FBX goes in with import_fbx; "
                                     "save first, CC5 can crash on an FBX import early in a session)")


class NoConsoleWindowTest(unittest.TestCase):
    """F-64: CC5 is a GUI process, so every process the plugin starts must ask for no console window."""

    def _trees(self):
        for name in sorted(os.listdir(_support.PLUGIN_DIR)):
            if name.endswith(".py"):
                # utf-8-sig: Python imports a source file that starts with a UTF-8 BOM; ast.parse of the text does not.
                with open(os.path.join(_support.PLUGIN_DIR, name), encoding="utf-8-sig") as f:
                    yield name, ast.parse(f.read(), filename=name)

    def test_every_subprocess_call_passes_creationflags(self):
        calls: dict[str, int] = {}
        for name, tree in self._trees():
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module == "subprocess":
                    self.fail(f"{name}:{node.lineno}: 'from subprocess import' hides calls from this check")
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == "subprocess" and alias.asname:
                            self.fail(f"{name}:{node.lineno}: 'import subprocess as {alias.asname}' hides calls "
                                      "from this check")
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess"):
                    calls[name] = calls.get(name, 0) + 1
                    self.assertIn("creationflags", [k.arg for k in node.keywords],
                                  f"{name}:{node.lineno}: subprocess.{node.func.attr} without creationflags")
        # The window screenshot fallback and the silent export's tasklist lookup.
        self.assertGreaterEqual(calls.get("cc5_api.py", 0), 2)


if __name__ == "__main__":
    unittest.main()

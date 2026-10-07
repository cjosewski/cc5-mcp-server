from __future__ import annotations

import importlib
import itertools
import os
import tempfile
import unittest
from unittest import mock

import _support


def _obj(name, oid, otype="Prop"):
    o = mock.MagicMock(name=name)
    o.GetName.return_value = name
    o.GetID.return_value = oid
    o.GetType.return_value = otype
    return o


class FakeScene:
    """Just enough of RLPy.RScene for selection: objects by type, avatars, and a real selection list."""

    def __init__(self, rl, avatars=(), props=(), lights=(), cameras=()):
        self.avatars = list(avatars)
        self.by_type = {"prop": list(props), "spot": list(lights), "camera": list(cameras)}
        self.selection = []
        rl.EObjectType_Prop = "prop"
        rl.EObjectType_SpotLight = "spot"
        rl.EObjectType_PointLight = "point"
        rl.EObjectType_DirectionalLight = "dir"
        rl.EObjectType_Camera = "camera"
        rl.EObjectType_Avatar = "avatar"
        scene = rl.RScene
        scene.GetAvatars.side_effect = lambda: list(self.avatars)
        scene.FindObjects.side_effect = lambda t: list(self.by_type.get(t, []))
        scene.GetSelectedObjects.side_effect = lambda: list(self.selection)
        scene.ClearSelectObjects.side_effect = lambda: self.selection.clear()
        scene.SelectObject.side_effect = lambda o: self.selection.__setitem__(slice(None), [o])  # replaces, as in CC5
        scene.SelectObjects.side_effect = lambda objs: self.selection.extend(objs)


def _selection_reads_fail(rl, scene, *failing):
    """GetSelectedObjects raises RuntimeError("SWIG") on the reads numbered in `failing` (0: the read before the clear,
    1: the read after it) and lists the fake scene's selection on the others."""
    reads = itertools.count()

    def read():
        if next(reads) in failing:
            raise RuntimeError("SWIG")
        return list(scene.selection)
    rl.RScene.GetSelectedObjects.side_effect = read


def _error_status():
    """An RStatus whose IsError() is True: how RLPy reports a call that failed without raising."""
    status = mock.MagicMock(name="RStatus")
    status.IsError.return_value = True
    return status


def _avatar(name, oid, clothes=(), hairs=(), accessories=()):
    a = _obj(name, oid, "avatar")
    a.GetClothes.return_value = list(clothes)
    a.GetHairs.return_value = list(hairs)
    a.GetAccessories.return_value = list(accessories)
    return a


class SelectionTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.s = _support.fresh_import("cc5_scene")
        self.boxers = _obj("Boxers", 11, "cloth")
        self.kevin = _avatar("Kevin", 1, clothes=[self.boxers])
        self.key = _obj("Key", 21, "spot")
        self.catcher = _obj("Shadow Catcher", 31, "prop")
        self.scene = FakeScene(self.rl, avatars=[self.kevin], props=[self.catcher], lights=[self.key])

    def names(self, r):
        return [o["name"] for o in r["selected"]]

    def test_selects_a_character_by_name(self):
        r = self.s.select_objects(["Kevin"])
        self.assertTrue(r["success"], r)
        self.assertEqual(self.names(r), ["Kevin"])
        self.assertEqual(r["selected"][0]["type"], "Avatar")

    def test_selects_worn_items_lights_and_props(self):
        r = self.s.select_objects(["Boxers", "Key", "Shadow Catcher"])
        self.assertTrue(r["success"], r)
        self.assertEqual(self.names(r), ["Boxers", "Key", "Shadow Catcher"])

    def test_replaces_the_selection_by_default(self):
        self.scene.selection = [self.key]
        r = self.s.select_objects(["Kevin"])
        self.assertEqual(self.names(r), ["Kevin"])

    def test_add_keeps_the_current_selection_without_duplicates(self):
        self.scene.selection = [self.key]
        r = self.s.select_objects(["Kevin", "Key"], add=True)
        self.assertTrue(r["success"], r)
        self.assertEqual(self.names(r), ["Key", "Kevin"])

    def test_unknown_name_fails_and_leaves_the_selection_alone(self):
        self.scene.selection = [self.key]
        r = self.s.select_objects(["Kevin", "NoSuchItem"])
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "Object not found: NoSuchItem")
        self.assertEqual(self.scene.selection, [self.key])
        self.rl.RScene.ClearSelectObjects.assert_not_called()

    def test_ambiguous_name_fails(self):
        self.scene.by_type["prop"].append(_obj("Key", 99, "prop"))
        r = self.s.select_objects(["Key"])
        self.assertFalse(r["success"])
        self.assertIn("more than one item", r["error"])

    def test_reports_failure_when_cc5_does_not_select(self):
        self.rl.RScene.SelectObject.side_effect = lambda o: None  # CC5 ignores the call
        r = self.s.select_objects(["Kevin"])
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "CC5 did not select: Kevin")

    def test_restores_the_previous_selection_when_selecting_raises(self):
        self.scene.selection = [self.key]
        self.rl.RScene.SelectObjects.side_effect = TypeError("bad list")
        r = self.s.select_objects(["Kevin", "Boxers"])
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "bad list")
        self.assertEqual(self.scene.selection, [self.key])

    def test_add_with_items_already_selected(self):
        self.scene.selection = [self.kevin]
        r = self.s.select_objects(["Kevin"], add=True)
        self.assertTrue(r["success"], r)
        self.assertEqual(self.names(r), ["Kevin"])

    def test_rejects_bad_input(self):
        for bad in ([], "Kevin", [""], [5], ["x" * 300]):
            self.assertFalse(self.s.select_objects(bad)["success"], bad)
        self.assertFalse(self.s.select_objects(["Kevin"], add="yes")["success"])
        self.assertFalse(self.s.select_objects(["a"] * 101)["success"])

    def test_get_selection(self):
        self.scene.selection = [self.kevin, self.key]
        r = self.s.get_selection()
        self.assertTrue(r["success"])
        self.assertEqual(self.names(r), ["Kevin", "Key"])

    def test_clear_selection(self):
        self.scene.selection = [self.kevin]
        r = self.s.clear_selection()
        self.assertEqual(r, {"success": True, "selected": []})

    def test_clear_reports_items_cc5_kept(self):
        self.scene.selection = [self.kevin]
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: None
        r = self.s.clear_selection()
        self.assertFalse(r["success"])

    def test_selection_is_not_an_undo_step(self):
        self.s.select_objects(["Kevin"])
        self.s.clear_selection()
        self.rl.RGlobal.BeginAction.assert_not_called()

    def test_dispatch_tables(self):
        self.assertEqual(self.s.POST_ROUTES["/scene/select"], "select_objects")
        self.assertEqual(self.s.REQUIRED_PARAMS["select_objects"], ["names"])
        r = self.s.ACTIONS["select_objects"]({"names": ["Kevin"], "add": False})
        self.assertTrue(r["success"])


class LoadAssetTargetTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.kevin = _avatar("Kevin", 1)
        self.amy = _avatar("Amy", 2)
        self.scene = FakeScene(self.rl, avatars=[self.kevin, self.amy])
        self.rl.RFileIO.LoadFile.return_value.IsError.return_value = False
        self.dir = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("CC5_CHANGE_CHECK", None)  # the F-34 comparison is on, whatever the developer's shell says

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_character_content_is_aimed_at_the_first_avatar_and_selects_it(self):
        path = self._file("_Green CH1 Eyes.ccEye")
        r = self.api.load_asset(path)
        self.assertEqual((r["success"], r["path"], r["target"]), (True, path, "Kevin"))
        # F-34: every character-content load is compared before and after (tests/py/test_changes.py).
        self.assertIn("changes", r)
        self.assertIs(r["changes"]["complete"], True, r)
        self.rl.RFileIO.LoadFile.assert_called_once_with(path, True, self.kevin)
        self.assertEqual(self.scene.selection, [self.kevin])

    def test_prefers_the_selected_avatar(self):
        self.scene.selection = [self.amy]
        r = self.api.load_asset(self._file("eyes.ccEye"))
        self.assertEqual(r["target"], "Amy")

    def test_named_target(self):
        r = self.api.load_asset(self._file("shirt.ccCloth"), "Amy")
        self.assertEqual(r["target"], "Amy")

    def test_unknown_target(self):
        r = self.api.load_asset(self._file("eyes.ccEye"), "Nobody")
        self.assertEqual(r, {"success": False, "error": "Avatar not found: Nobody"})
        self.rl.RFileIO.LoadFile.assert_not_called()

    def test_character_content_without_an_avatar(self):
        self.scene.avatars.clear()
        r = self.api.load_asset(self._file("eyes.ccEye"))
        self.assertFalse(r["success"])
        self.assertIn("No avatar in scene", r["error"])

    def test_scene_content_is_loaded_without_a_target(self):
        path = self._file("Close Face_Front.ccCam")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path})
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)
        self.rl.RScene.SelectObject.assert_not_called()

    def test_target_is_refused_for_scene_content(self):
        r = self.api.load_asset(self._file("Close Face_Front.ccCam"), "Kevin")
        self.assertFalse(r["success"])
        self.assertIn("only to character content", r["error"])

    def test_several_selected_characters_are_refused(self):
        self.scene.selection = [self.kevin, self.amy]
        r = self.api.load_asset(self._file("eyes.ccEye"))
        self.assertFalse(r["success"])
        self.assertIn("pass target", r["error"])
        self.rl.RFileIO.LoadFile.assert_not_called()

    def test_selected_non_avatar_falls_back_to_the_first_avatar(self):
        self.scene.selection = [_obj("Key", 21, "spot")]
        self.assertEqual(self.api.load_asset(self._file("eyes.ccEye"))["target"], "Kevin")

    def test_duplicate_target_names_are_refused(self):
        self.scene.avatars.append(_avatar("Amy", 3))
        r = self.api.load_asset(self._file("eyes.ccEye"), "Amy")
        self.assertEqual(r, {"success": False, "error": "More than one avatar is named Amy"})

    def test_hair_gloves_and_makeup_are_character_content(self):
        for name in ("Bob.ccHair", "work.ccGloves", "smoky.ccSkinGenPreset"):
            self.assertEqual(self.api.load_asset(self._file(name))["target"], "Kevin", name)

    def test_rlhair_hairstyles_are_character_content(self):
        # Live: every hairstyle CC5 5.13 ships is .rlHair, and load_asset refused it outright.
        path = self._file("Buzz Cut.rlHair")
        r = self.api.load_asset(path)
        self.assertEqual((r["success"], r["path"], r["target"]), (True, path, "Kevin"))
        self.assertIn("changes", r)
        self.assertIs(r["changes"]["complete"], True, r)
        self.rl.RFileIO.LoadFile.assert_called_once_with(path, True, self.kevin)

    def test_other_rl_files_stay_refused(self):
        r = self.api.load_asset(self._file("Buzz Cut.rlHairElement"))
        self.assertEqual(r, {"success": False, "error": "Disallowed file extension: .rlhairelement"})

    def test_character_load_is_one_undo_step_even_when_it_fails(self):
        self.rl.RFileIO.LoadFile.side_effect = RuntimeError("boom")
        r = self.api.load_asset(self._file("eyes.ccEye"))
        self.assertEqual(r, {"success": False, "error": "boom"})
        self.rl.RGlobal.BeginAction.assert_called_once_with("Load Asset")
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_error_status_from_cc5_is_a_failure(self):
        self.rl.RFileIO.LoadFile.return_value.IsError.return_value = True
        for name in ("eyes.ccEye", "cam.ccCam"):
            r = self.api.load_asset(self._file(name))
            self.assertFalse(r["success"], name)
            self.assertIn("LoadFile reported an error status", r["error"])

    # F-92 precaution: a .ccProject replaces the scene, so its load removes the characters in it. The crash was seen only
    # with delete_avatar, so this is a precaution: the selection is cleared first, and the load runs in any case.
    PROJECT_CLEARED = ("CC5's selection ({}) was cleared before the project load: a project replaces the scene, and "
                       "deleting a character while one of its worn items is selected can crash CC5 (F-92).")

    def _order(self):
        order: list = []
        clear = self.rl.RScene.ClearSelectObjects.side_effect
        status = self.rl.RFileIO.LoadFile.return_value
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: order.append("ClearSelectObjects") or clear()
        self.rl.RFileIO.LoadFile.side_effect = lambda *a: order.append("LoadFile") or status
        return order

    def test_a_project_load_clears_the_selection_first_and_names_it(self):
        order = self._order()
        pants = _obj("Pants", 11, "cloth")
        self.scene.selection = [pants, self.amy]
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path, "notes": [self.PROJECT_CLEARED.format("Pants, Amy")]})
        self.assertEqual(order, ["ClearSelectObjects", "LoadFile"])
        self.assertEqual(self.scene.selection, [])
        self.rl.RGlobal.BeginAction.assert_not_called()  # a selection change is no undo step

    def test_a_project_load_with_nothing_selected_adds_no_note(self):
        order = self._order()
        path = self._file("Scene.ccProject")
        self.assertEqual(self.api.load_asset(path), {"success": True, "path": path})
        self.assertEqual(order, ["ClearSelectObjects", "LoadFile"])

    def test_a_project_load_runs_when_the_selection_cannot_be_cleared(self):
        self.scene.selection = [self.amy]
        self.rl.RScene.ClearSelectObjects.side_effect = RuntimeError("SWIG")
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path, "notes": [
            "WARNING: CC5's selection could not be cleared before the project load (SWIG): a project replaces the "
            "scene, and deleting a character while one of its worn items is selected can crash CC5 (F-92)."]})
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)

    def test_a_project_load_says_a_selection_it_could_not_read_was_cleared(self):
        # The selection read again after the clear is empty (batch F review #1), so the note can say it was cleared.
        self.scene.selection = [self.amy]
        _selection_reads_fail(self.rl, self.scene, 0)
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r["notes"], [self.PROJECT_CLEARED.format("it could not be read: SWIG")])
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)

    # Batch F review #1: a clear that returned is checked by reading the selection again, so the note says "was cleared"
    # only when that read is empty. A selection still set, or unreadable after the clear, is a WARNING note, and the
    # project loads all the same, as after a clear that failed.
    def test_a_project_load_warns_when_the_selection_is_still_set_after_the_clear(self):
        self.scene.selection = [_obj("Pants", 11, "cloth")]
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: None  # returns, and clears nothing
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path, "notes": [
            "WARNING: CC5's selection could not be cleared before the project load (Pants stayed selected): a project "
            "replaces the scene, and deleting a character while one of its worn items is selected can crash CC5 "
            "(F-92)."]})
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)

    NOT_READ_AFTER_CLEAR = ("WARNING: CC5's selection could not be read after it was cleared before the project load "
                            "(SWIG), so it may still be set: a project replaces the scene, and deleting a character "
                            "while one of its worn items is selected can crash CC5 (F-92).")

    def test_a_project_load_warns_when_the_selection_cannot_be_read_after_the_clear(self):
        self.scene.selection = [self.amy]
        _selection_reads_fail(self.rl, self.scene, 1)
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path, "notes": [self.NOT_READ_AFTER_CLEAR]})
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)

    def test_a_project_load_warns_when_the_selection_can_be_read_neither_before_nor_after_the_clear(self):
        # Before batch F review #1 this note said the selection was cleared.
        _selection_reads_fail(self.rl, self.scene, 0, 1)
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path, "notes": [self.NOT_READ_AFTER_CLEAR]})
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)

    def test_a_project_load_counts_an_error_status_from_the_clear_as_a_failed_clear(self):
        # RLPy's ClearSelectObjects returns an RStatus (batch F review #1): an error status is a clear that failed.
        self.scene.selection = [self.amy]
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: _error_status()
        path = self._file("Scene.ccProject")
        r = self.api.load_asset(path)
        self.assertEqual(r, {"success": True, "path": path, "notes": [
            "WARNING: CC5's selection could not be cleared before the project load (ClearSelectObjects reported an "
            "error status): a project replaces the scene, and deleting a character while one of its worn items is "
            "selected can crash CC5 (F-92)."]})
        self.rl.RFileIO.LoadFile.assert_called_once_with(path)

    def test_a_failed_project_load_keeps_the_note(self):
        self.scene.selection = [self.amy]
        self.rl.RFileIO.LoadFile.side_effect = RuntimeError("boom")
        r = self.api.load_asset(self._file("Scene.ccProject"))
        self.assertEqual(r, {"success": False, "error": "boom", "notes": [self.PROJECT_CLEARED.format("Amy")]})

    def test_other_scene_content_leaves_the_selection_alone(self):
        self.scene.selection = [self.amy]
        path = self._file("Close Face_Front.ccCam")
        self.assertEqual(self.api.load_asset(path), {"success": True, "path": path})
        self.rl.RScene.ClearSelectObjects.assert_not_called()
        self.assertEqual(self.scene.selection, [self.amy])


class DeleteAvatarSelectionTest(unittest.TestCase):
    """F-92 (live): CC5 crashed deleting a character while its uniform pants were selected (load_asset leaves the
    loaded item selected). Clearing the selection in the same action, before RemoveObject, deleted it cleanly."""

    CLEARED = ("CC5's selection ({}) was cleared before the delete: deleting a character while one of its worn items "
               "is selected can crash CC5 (F-92).")

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.pants = _obj("Pants", 11, "cloth")
        self.kevin = _avatar("Kevin", 1, clothes=[self.pants])
        self.amy = _avatar("Amy", 2)
        self.scene = FakeScene(self.rl, avatars=[self.kevin, self.amy])
        self.order = []
        clear = self.rl.RScene.ClearSelectObjects.side_effect
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: self.order.append("ClearSelectObjects") or clear()
        self.rl.RGlobal.BeginAction.side_effect = lambda name: self.order.append("BeginAction")
        self.rl.RGlobal.EndAction.side_effect = lambda: self.order.append("EndAction")

        def remove(obj):
            self.order.append(f"RemoveObject {obj.GetName()}")
            self.scene.avatars.remove(obj)
            # A removed character and what it wore are gone: their handles must not be touched afterwards.
            for gone in (obj, *obj.GetClothes()):
                gone.GetName.side_effect = RuntimeError("deleted object")

        self.rl.RScene.RemoveObject.side_effect = remove

    def test_the_selection_is_cleared_in_the_action_before_the_character_is_removed(self):
        self.scene.selection = [self.pants]  # live, after load_asset: get_selection said "Pants (Cloth)"
        r = self.api.delete_avatar("Kevin")
        self.assertEqual(self.order, ["BeginAction", "ClearSelectObjects", "RemoveObject Kevin", "EndAction"])
        self.assertEqual(self.scene.selection, [])
        # The names were read before the delete: the Pants' handle is gone after it.
        self.assertEqual(r, {"success": True, "removed": ["Kevin"], "notes": [self.CLEARED.format("Pants")]})

    def test_deleting_every_character_clears_once_before_the_first_remove(self):
        self.scene.selection = [self.pants, self.amy]
        r = self.api.delete_avatar("")
        self.assertEqual(self.order, ["BeginAction", "ClearSelectObjects", "RemoveObject Kevin", "RemoveObject Amy",
                                      "EndAction"])
        self.assertEqual(r["removed"], ["Kevin", "Amy"])
        self.assertEqual(r["notes"], [self.CLEARED.format("Pants, Amy")])

    def test_no_note_when_nothing_was_selected(self):
        r = self.api.delete_avatar("Kevin")
        self.assertEqual(r, {"success": True, "removed": ["Kevin"]})
        self.assertEqual(self.order, ["BeginAction", "ClearSelectObjects", "RemoveObject Kevin", "EndAction"])

    # Review #2 (fail closed): nothing is deleted when the clear failed while the selection held something or could not
    # be read. Batch F review #1: after a clear that returned, the selection is read again, and the delete goes on only
    # when that read is empty, whatever the read before the clear gave. Batch F review #31: both refusals also say to
    # deselect in CC5, since clear_selection calls the same ClearSelectObjects.
    NOT_CLEARED = ("CC5's selection ({}) could not be cleared, so nothing was deleted: deleting a character while one of "
                   "its worn items is selected can crash CC5 (F-92). Run clear_selection (or deselect everything in "
                   "Character Creator 5), then delete again.")
    NOT_READ = ("CC5's selection could not be read or cleared, so nothing was deleted: deleting a character while one of "
                "its worn items is selected can crash CC5 (F-92). Run clear_selection (or deselect everything in "
                "Character Creator 5), then delete again.")

    def test_the_refusals_are_the_plugins(self):
        self.assertEqual(self.api.DELETE_SELECTION_NOT_CLEARED, self.NOT_CLEARED)
        self.assertEqual(self.api.DELETE_SELECTION_NOT_READ, self.NOT_READ)

    def assertNothingDeleted(self):
        self.assertEqual(self.scene.avatars, [self.kevin, self.amy])
        self.rl.RScene.RemoveObject.assert_not_called()

    def test_a_selection_that_cannot_be_cleared_deletes_nothing(self):
        # Before, the delete went on with a WARNING note: the F-92 crash itself, with the note never seen.
        self.scene.selection = [self.pants, self.amy]
        self.rl.RScene.ClearSelectObjects.side_effect = RuntimeError("SWIG")
        for name in ("Kevin", ""):
            with self.subTest(name=name):
                self.order.clear()
                r = self.api.delete_avatar(name)
                self.assertEqual(r, {"success": False, "error": self.NOT_CLEARED.format("Pants, Amy")})
                self.assertEqual(self.order, ["BeginAction", "EndAction"])  # the undo step is still closed
                self.assertNothingDeleted()

    def test_a_selection_that_cannot_be_read_is_cleared_and_the_delete_goes_on(self):
        # ClearSelectObjects ran and the selection read again after it is empty, so nothing is selected any more,
        # whatever it held: the note says the selection could not be read (batch F's first round refused this delete,
        # though the clear had run).
        self.scene.selection = [self.pants]
        _selection_reads_fail(self.rl, self.scene, 0)
        r = self.api.delete_avatar("Kevin")
        self.assertEqual(r, {"success": True, "removed": ["Kevin"],
                             "notes": [self.CLEARED.format("it could not be read: SWIG")]})
        self.assertEqual(self.order, ["BeginAction", "ClearSelectObjects", "RemoveObject Kevin", "EndAction"])
        self.assertEqual(self.scene.selection, [])

    # Batch F review #1: RLPy's ClearSelectObjects returns an RStatus, so a clear that returned may have left the
    # selection in place. The delete reads it again, as cc5_scene.clear_selection does.
    def test_a_clear_that_returns_but_leaves_the_pants_selected_deletes_nothing(self):
        # Before, the delete went on and noted "CC5's selection (Pants) was cleared": the F-92 crash.
        self.scene.selection = [self.pants]
        # It returns, and clears nothing.
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: self.order.append("ClearSelectObjects")
        for name in ("Kevin", ""):
            with self.subTest(name=name):
                self.order.clear()
                r = self.api.delete_avatar(name)
                self.assertEqual(r, {"success": False, "error": self.NOT_CLEARED.format("Pants")})
                self.assertEqual(self.order, ["BeginAction", "ClearSelectObjects", "EndAction"])
                self.assertNothingDeleted()

    def test_the_refusal_names_what_is_left_after_the_clear(self):
        # The selection could not be read before the clear; read after it, the pants are still selected.
        self.scene.selection = [self.pants, self.amy]
        _selection_reads_fail(self.rl, self.scene, 0)
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: self.scene.selection.remove(self.amy)
        self.assertEqual(self.api.delete_avatar("Kevin"), {"success": False, "error": self.NOT_CLEARED.format("Pants")})
        self.assertNothingDeleted()

    def test_a_selection_that_cannot_be_read_after_the_clear_deletes_nothing(self):
        # Before the clear: the pants, or a read that failed too. Nothing proves the selection empty at the delete.
        for failing in ((1,), (0, 1)):
            with self.subTest(failing=failing):
                self.order.clear()
                self.scene.selection = [self.pants]
                _selection_reads_fail(self.rl, self.scene, *failing)
                self.assertEqual(self.api.delete_avatar("Kevin"), {"success": False, "error": self.NOT_READ})
                self.assertEqual(self.order, ["BeginAction", "ClearSelectObjects", "EndAction"])
                self.assertNothingDeleted()

    def test_a_clear_that_returns_an_error_status_is_a_clear_that_failed(self):
        # CC5 said the clear failed: the read before it decides, and the selection is not read again.
        self.scene.selection = [self.pants]
        failed = _error_status()
        self.rl.RScene.ClearSelectObjects.side_effect = lambda: self.order.append("ClearSelectObjects") or failed
        r = self.api.delete_avatar("Kevin")
        self.assertEqual(r, {"success": False, "error": self.NOT_CLEARED.format("Pants")})
        self.assertEqual(self.rl.RScene.GetSelectedObjects.call_count, 1)
        self.assertNothingDeleted()
        # With nothing selected, an error status stops nothing: a clear selects nothing.
        self.scene.selection.clear()
        self.assertEqual(self.api.delete_avatar("Kevin"), {"success": True, "removed": ["Kevin"]})

    def test_a_selection_that_can_neither_be_read_nor_cleared_deletes_nothing(self):
        self.rl.RScene.GetSelectedObjects.side_effect = RuntimeError("SWIG")
        self.rl.RScene.ClearSelectObjects.side_effect = RuntimeError("SWIG")
        for name in ("Kevin", ""):
            with self.subTest(name=name):
                self.order.clear()
                self.assertEqual(self.api.delete_avatar(name), {"success": False, "error": self.NOT_READ})
                self.assertEqual(self.order, ["BeginAction", "EndAction"])  # the undo step is still closed
                self.assertNothingDeleted()

    def test_a_clear_that_fails_with_nothing_selected_still_deletes(self):
        # Read and empty: nothing is selected that a delete could crash on.
        self.rl.RScene.ClearSelectObjects.side_effect = RuntimeError("SWIG")
        r = self.api.delete_avatar("Kevin")
        self.assertEqual(r, {"success": True, "removed": ["Kevin"]})
        self.assertEqual(self.order, ["BeginAction", "RemoveObject Kevin", "EndAction"])

    # What the refusal says to do: clear_selection (cc5_scene), or deselect everything in Character Creator 5, then
    # delete again. Batch F review #31: this test emptied the fake selection by hand and never called clear_selection.
    def test_after_a_refusal_clear_selection_then_delete_works(self):
        cc5_scene = importlib.import_module("cc5_scene")  # imported after this test's cc5_api, so it uses that one
        self.scene.selection = [self.pants]
        clear = self.rl.RScene.ClearSelectObjects.side_effect
        self.rl.RScene.ClearSelectObjects.side_effect = RuntimeError("SWIG")  # once
        self.assertEqual(self.api.delete_avatar("Kevin"), {"success": False, "error": self.NOT_CLEARED.format("Pants")})
        self.rl.RScene.ClearSelectObjects.side_effect = clear
        self.assertEqual(cc5_scene.clear_selection(), {"success": True, "selected": []})
        self.assertEqual(self.api.delete_avatar("Kevin"), {"success": True, "removed": ["Kevin"]})

    def test_where_clear_selection_fails_too_deselecting_in_cc5_lets_the_delete_go_on(self):
        # The refusal's trigger is a failing ClearSelectObjects, and clear_selection calls the same one, so it fails
        # too; the other way the refusal gives is the user deselecting everything in CC5.
        cc5_scene = importlib.import_module("cc5_scene")
        self.scene.selection = [self.pants]
        self.rl.RScene.ClearSelectObjects.side_effect = RuntimeError("SWIG")  # every time
        refused = self.api.delete_avatar("Kevin")
        self.assertEqual(refused, {"success": False, "error": self.NOT_CLEARED.format("Pants")})
        self.assertIn("(or deselect everything in Character Creator 5)", refused["error"])
        self.assertEqual(cc5_scene.clear_selection(), {"success": False, "error": "SWIG"})
        self.assertEqual(self.scene.selection, [self.pants])
        self.scene.selection.clear()  # the user deselected everything in CC5
        self.assertEqual(self.api.delete_avatar("Kevin"), {"success": True, "removed": ["Kevin"]})
        self.assertEqual(self.order, ["BeginAction", "EndAction", "BeginAction", "RemoveObject Kevin", "EndAction"])

    def test_a_delete_that_finds_nobody_leaves_the_selection_alone(self):
        self.scene.selection = [self.pants]
        r = self.api.delete_avatar("Nobody")
        self.assertFalse(r["success"])
        self.assertEqual(self.scene.selection, [self.pants])
        self.assertEqual(self.order, [])


class FakeVec:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z


class FakeTransform:
    """RLPy.RTransform(scale, rotation, position), read back with T() / S() / R()."""

    def __init__(self, scale=None, rot="rot", pos=None):
        self._s = scale or FakeVec(1.0, 1.0, 1.0)
        self._r = rot
        self._t = pos or FakeVec(0.0, 0.0, 0.0)

    def T(self):
        return self._t

    def S(self):
        return self._s

    def R(self):
        return self._r


class FakeTransformControl:
    def __init__(self, applies=True):
        self.value = FakeTransform()
        self.applies = applies
        self.set_calls = []

    def GetValue(self, time, out):
        out._t, out._s, out._r = self.value._t, self.value._s, self.value._r

    def SetValue(self, time, tr):
        self.set_calls.append(tr)
        if self.applies:
            self.value = tr


class DeleteAndPlaceTest(unittest.TestCase):
    """delete_object and set_object_transform (flight 01, F-48 / F-49)."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.s = _support.fresh_import("cc5_scene")
        self.rl.EObjectType_Cloth = "cloth"
        self.rl.RTransform.side_effect = lambda *a: FakeTransform(*a)
        self.rl.RVector3.side_effect = lambda x, y, z: FakeVec(x, y, z)
        self.boxers = _obj("Boxers", 11, "cloth")
        self.kevin = _avatar("Kevin", 1, clothes=[self.boxers])
        self.key = _obj("Key", 21, "spot")
        self.box = _obj("Box_001", 31, "prop")
        self.camera = _obj("Preview Camera", 41, "camera")
        self.scene = FakeScene(self.rl, avatars=[self.kevin], props=[self.box], lights=[self.key],
                               cameras=[self.camera])
        self.control = FakeTransformControl()
        self.box.GetControl.return_value = self.control

        def remove(obj):
            for objs in self.scene.by_type.values():
                if obj in objs:
                    objs.remove(obj)
            for avatar in self.scene.avatars:
                clothes = avatar.GetClothes.return_value
                if obj in clothes:
                    clothes.remove(obj)

        self.rl.RScene.RemoveObject.side_effect = remove

    def test_deletes_a_prop_as_one_undo_step(self):
        r = self.s.delete_object(["Box_001"])
        self.assertTrue(r["success"], r)
        self.assertEqual([d["name"] for d in r["deleted"]], ["Box_001"])
        self.rl.RScene.RemoveObject.assert_called_once_with(self.box)
        self.rl.RGlobal.BeginAction.assert_called_once_with("Delete Object")
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_deletes_lights_and_worn_items_together(self):
        r = self.s.delete_object(["Key", "Boxers"])
        self.assertTrue(r["success"], r)
        self.assertEqual(self.rl.RScene.RemoveObject.call_count, 2)

    def test_unknown_or_ambiguous_names_delete_nothing(self):
        r = self.s.delete_object(["Box_001", "nope"])
        self.assertFalse(r["success"])
        self.assertIn("Object not found: nope", r["error"])
        self.scene.by_type["prop"].append(_obj("Key", 22, "prop"))
        r = self.s.delete_object(["Key"])
        self.assertIn("more than one", r["error"])
        self.rl.RScene.RemoveObject.assert_not_called()

    def test_characters_and_the_camera_are_refused(self):
        r = self.s.delete_object(["Kevin"])
        self.assertIn("delete_avatar", r["error"])
        r = self.s.delete_object(["Preview Camera"])
        self.assertIn("camera", r["error"])
        self.rl.RScene.RemoveObject.assert_not_called()

    def test_a_character_is_refused_even_when_its_type_cannot_be_read(self):
        # Review: refusing by GetType() failed open (an unreadable type is "Unknown", not "Avatar").
        self.kevin.GetType.side_effect = RuntimeError("SWIG")
        r = self.s.delete_object(["Kevin"])
        self.assertIn("delete_avatar", r["error"])
        r = self.s.set_object_transform("Boxers", position=[0, 0, 0])
        self.assertIn("worn by a character", r["error"])
        self.rl.RScene.RemoveObject.assert_not_called()

    def test_a_child_already_removed_with_its_parent_is_not_removed_again(self):
        # A parent's removal can take its children with it; RemoveObject must never get a handle that is gone.
        child = _obj("Lid", 32, "prop")
        self.scene.by_type["prop"].append(child)

        def remove(obj):
            for o in (obj, child) if obj is self.box else (obj,):
                if o in self.scene.by_type["prop"]:
                    self.scene.by_type["prop"].remove(o)

        self.rl.RScene.RemoveObject.side_effect = remove
        r = self.s.delete_object(["Box_001", "Lid"])
        self.assertTrue(r["success"], r)
        self.rl.RScene.RemoveObject.assert_called_once_with(self.box)

    def test_an_item_cc5_kept_is_reported(self):
        self.rl.RScene.RemoveObject.side_effect = None
        r = self.s.delete_object(["Box_001"])
        self.assertFalse(r["success"])
        self.assertIn("CC5 did not delete: Box_001", r["error"])

    def test_bad_names_argument_is_refused(self):
        for names in ([], "Box_001", None, [""]):
            with self.subTest(names=names):
                self.assertFalse(self.s.delete_object(names)["success"])

    def test_moves_and_scales_a_prop_keeping_its_rotation(self):
        # Live: Box_001 moved from 0 to x 150 cm and scaled 1.5; one undo put it back.
        r = self.s.set_object_transform("Box_001", position=[150, 0, 0], scale=1.5)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["before"], {"position": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]})
        self.assertEqual(r["after"], {"position": [150.0, 0.0, 0.0], "scale": [1.5, 1.5, 1.5]})
        self.assertEqual(self.control.set_calls[0].R(), "rot")
        self.rl.RGlobal.BeginAction.assert_called_once_with("Set Object Transform")

    def test_position_only_keeps_the_scale(self):
        self.control.value = FakeTransform(FakeVec(2.0, 2.0, 2.0))
        r = self.s.set_object_transform("Box_001", position=[10, 20, 30])
        self.assertTrue(r["success"], r)
        self.assertEqual(r["after"]["scale"], [2.0, 2.0, 2.0])

    def test_a_transform_cc5_ignored_is_reported(self):
        self.control.applies = False
        r = self.s.set_object_transform("Box_001", position=[150, 0, 0])
        self.assertFalse(r["success"])
        self.assertIn("did not apply the position", r["error"])

    def test_bad_values_are_refused_before_cc5(self):
        cases = ({}, {"position": [1, 2]}, {"position": ["a", 0, 0]}, {"position": [1e9, 0, 0]},
                 {"scale": 0}, {"scale": [1, 1, True]}, {"position": [float("nan"), 0, 0]})
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self.assertFalse(self.s.set_object_transform("Box_001", **kwargs)["success"])
        self.assertEqual(self.control.set_calls, [])

    def test_worn_items_and_the_camera_cannot_be_placed(self):
        r = self.s.set_object_transform("Boxers", position=[0, 0, 0])
        self.assertIn("moves with it", r["error"])
        r = self.s.set_object_transform("Preview Camera", position=[0, 0, 0])
        self.assertIn("frame_camera", r["error"])

    def test_reads_a_transform(self):
        self.control.value = FakeTransform(FakeVec(1.0, 1.0, 1.0), "rot", FakeVec(12.345, 0.0, -3.0))
        r = self.s.get_object_transform("Box_001")
        self.assertEqual(r, {"success": True, "name": "Box_001", "position": [12.35, 0.0, -3.0],
                             "scale": [1.0, 1.0, 1.0]})


if __name__ == "__main__":
    unittest.main()

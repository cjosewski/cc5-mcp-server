from __future__ import annotations

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

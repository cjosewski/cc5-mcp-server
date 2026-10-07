"""F-34: a character-content load reads the target character just before and just after LoadFile and reports what
else changed (Chad, 2026-10-05; P7-3: the US Army uniform pants swapped out CC4 Kevin's Boxers unreported)."""
from __future__ import annotations

import importlib
import itertools
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import _support

SWITCHED_OFF = "WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared"
NOT_FOUND = "WARNING: the character was not found after the load, so nothing was compared afterwards"
NOT_COMPARED = "WARNING: not compared, because CC5 could not read them before or after the load: "
SKIN = ("Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg")
SKIN_NAMES = "Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg"
# Review #1: a colour the bridge set that CC5 reads after the load as it read it before.
NOT_REFRESHED = ("WARNING: CC5 still reports the colour from before the bridge set it on {}, so whether this load "
                 "changed it was not checked: capture, then compare")
# Review #20: colour and opacity differences without a record, after an undo or redo. Batch F review #14: that CC5
# reports colours late after an undo or redo is inferred from F-90 (a colour set without an undo), not seen.
COLOURS_LATE = ("WARNING: CC5 may report material colours late after an undo, a redo or a load that left a colour "
                "unsettled (seen for a colour set without an undo, F-90; not checked live after an undo), so "
                "whether this load changed the {} on {} was not checked: capture, then compare")


def _material(shader="Pbr", diffuse=(255, 255, 255), opacity=100.0, blend=False, params=None):
    """One row of a character's material table. A stored exception is raised by the read that reaches it."""
    return {"shader": shader, "diffuse": tuple(diffuse), "opacity": opacity, "blend": blend,
            "params": {name: list(values) for name, values in (params or {}).items()}}


class _Status:
    """The RStatus of a load CC5 reports as done."""

    def IsError(self):
        return False


class FakeItem:
    """A worn item (cloth, hair, accessory). `meshes` maps each of its meshes to its materials."""

    def __init__(self, oid, name, meshes):
        self.oid, self.name, self.meshes = oid, name, dict(meshes)

    def GetID(self):
        return self.oid

    def GetName(self):
        return self.name

    def GetMeshNames(self, all_meshes=True):
        return list(self.meshes)


class FakeColor:
    def __init__(self, rgb):
        self.rgb = rgb

    def Red(self):
        return self.rgb[0]

    def Green(self):
        return self.rgb[1]

    def Blue(self):
        return self.rgb[2]


class FakeMaterials:
    """RIMaterialComponent over a character's material table; every read is logged to the shared events list."""

    def __init__(self, character):
        self.c = character
        # Stale until CC5 renders (F-65): the comparison must never read them.
        self.GetGlossinessWeight = mock.Mock(name="GetGlossinessWeight")
        self.GetSpecularWeight = mock.Mock(name="GetSpecularWeight")
        self.GetTextureWeights = mock.Mock(name="GetTextureWeights")

    def _read(self, call, mesh, material, field, *extra):
        self.c.events.append(("read", call, mesh, material) + extra)
        value = self.c.table[(mesh, material)][field]
        if isinstance(value, Exception):
            raise value
        return value

    def GetMaterialNames(self, mesh):
        self.c.events.append(("read", "GetMaterialNames", mesh))
        if mesh in self.c.unlisted:
            raise RuntimeError("SWIG")
        return list(self.c.mesh_materials().get(mesh, []))

    def GetShader(self, mesh, material):
        return self._read("GetShader", mesh, material, "shader")

    def GetDiffuseColor(self, mesh, material):
        return FakeColor(self._read("GetDiffuseColor", mesh, material, "diffuse"))

    def GetOpacity(self, mesh, material):
        return self._read("GetOpacity", mesh, material, "opacity")

    def HasImage(self, mesh, material, channel):
        return self._read("HasImage", mesh, material, "blend", channel)

    def GetShaderParameterNames(self, mesh, material):
        return list(self._read("GetShaderParameterNames", mesh, material, "params"))

    def GetShaderParameter(self, mesh, material, name):
        self.c.events.append(("read", "GetShaderParameter", mesh, material, name))
        value = self.c.table[(mesh, material)]["params"][name]
        if isinstance(value, Exception):
            raise value
        return list(value)

    # F-90: CC5 holds what these write at once, but its reads report it only after it renders (Character.render).

    def AddDiffuseKey(self, key, mesh, material, color):
        self.c.events.append(("write", "AddDiffuseKey", mesh, material))
        # CC5 keeps the 0-255 step and drops the fraction (F-14); `color` is what RLPy.RRgb returned (see setUp).
        self.c.pending.setdefault((mesh, material), {})["diffuse"] = tuple(int(v * 255) for v in color)

    def AddOpacityKey(self, key, mesh, material, value):
        self.c.events.append(("write", "AddOpacityKey", mesh, material))
        self.c.pending.setdefault((mesh, material), {})["opacity"] = value


class FakeShaping:
    def __init__(self, character):
        self.c = character

    def GetShapingMorphCatergoryNames(self):  # CC5's own spelling
        return list(self.c.morph_ids)

    def GetShapingMorphIDs(self, category):
        return list(self.c.morph_ids[category])

    def GetShapingMorphWeight(self, morph_id):
        return self.c.morphs.get(morph_id, 0.0)


class Character:
    """The state behind every proxy of one character."""

    def __init__(self, oid, name, events):
        self.oid, self.name, self.events = oid, name, events
        self.base: dict = {}  # base mesh -> materials, in CC5's mesh order
        self.clothes: list = []
        self.hairs: list = []
        self.accessories: list = []
        self.table: dict = {}  # (mesh, material) -> _material(...)
        self.morph_ids = {"Body": ["Body Fat A", "Muscular"]}
        self.morphs = {"Body Fat A": 0.35}
        self.subdivision = 0
        self.fail: set = set()  # avatar methods that raise
        self.unlisted: set = set()  # meshes whose materials GetMaterialNames cannot list
        self.pending: dict = {}  # (mesh, material) -> fields written that CC5's reads report only after a render
        self.materials = FakeMaterials(self)

    def render(self):
        """CC5 renders: from now on its reads report what it holds (F-90)."""
        for key, fields in self.pending.items():
            self.table[key].update(fields)
        self.pending.clear()

    def mesh_materials(self):
        meshes = dict(self.base)
        for item in self.clothes + self.hairs + self.accessories:
            meshes.update(item.meshes)
        return meshes

    def wear(self, group, item, **material):
        getattr(self, group).append(item)
        for mesh, names in item.meshes.items():
            for name in names:
                self.table[(mesh, name)] = _material(**material)


class FakeAvatar:
    """One SWIG proxy over a character: RScene.GetAvatars makes new ones on every call. A stale one always raises."""

    def __init__(self, character):
        self.c = character
        self.stale = False

    def _call(self, name):
        if self.stale:
            raise RuntimeError(f"{name}: stale proxy (CC5 rebuilt the character)")
        self.c.events.append(("avatar", name))
        if name in self.c.fail:
            raise RuntimeError(f"{name} failed (SWIG)")

    def GetID(self):
        self._call("GetID")
        return self.c.oid

    def GetName(self):
        self._call("GetName")
        return self.c.name

    def GetClothes(self):
        self._call("GetClothes")
        return list(self.c.clothes)

    def GetHairs(self):
        self._call("GetHairs")
        return list(self.c.hairs)

    def GetAccessories(self, all_items=True):
        self._call("GetAccessories")
        return list(self.c.accessories)

    def GetAvatarShapingComponent(self):
        self._call("GetAvatarShapingComponent")
        return FakeShaping(self.c)

    def GetMaterialComponent(self):
        self._call("GetMaterialComponent")
        return self.c.materials

    def GetMeshNames(self, all_meshes=True):
        self._call("GetMeshNames")
        meshes = list(self.c.base)
        for item in self.c.clothes + self.c.hairs + self.c.accessories:
            meshes += list(item.meshes)
        return meshes

    def GetSubdivMeshLevel(self):
        self._call("GetSubdivMeshLevel")
        return self.c.subdivision


def _kevin(events):
    """CC4 Kevin, as far as the comparison reads him."""
    kevin = Character(1, "Kevin", events)
    # CC5 lists the eyes first here; the comparison reads CC_Base_Body first all the same.
    kevin.base = {"CC_Base_Eye": ["Std_Cornea_R"], "CC_Base_Body": list(SKIN) + ["Std_Nails"]}
    for name in SKIN:
        params = ({"_BaseColorMap Brightness": [0.0], "Original Roughness Strength": [0.85], "padding1": [0, 0, 0]}
                  if name == "Std_Skin_Head" else {})
        kevin.table[("CC_Base_Body", name)] = _material("Digital_Human Skin", (204, 153, 128), params=params)
    kevin.table[("CC_Base_Body", "Std_Nails")] = _material("Pbr", (230, 190, 180))
    # CC4 Kevin's corneas carry a Diffuse Blend image (F-66).
    kevin.table[("CC_Base_Eye", "Std_Cornea_R")] = _material("Digital_Human Eye", blend=True)
    kevin.wear("clothes", FakeItem(11, "Boxers", {"Boxers": ["Std_Boxers"]}))
    kevin.wear("hairs", FakeItem(12, "Buzz_Cut", {"Buzz_Cut": ["Hair_Transparency"]}))
    return kevin


def _amy(events):
    amy = Character(2, "Amy", events)
    amy.base = {"CC_Base_Body": ["Std_Skin_Head"]}
    amy.table[("CC_Base_Body", "Std_Skin_Head")] = _material("Digital_Human Skin", (180, 130, 110))
    return amy


class ChangeCheckTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        # cc5_api dropped cc5_changes at its import: this is the module load_asset imports next.
        self.changes = importlib.import_module("cc5_changes")
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("CC5_CHANGE_CHECK", None)  # on, whatever the developer's shell says
        self.events: list = []
        self.kevin = _kevin(self.events)
        self.amy = _amy(self.events)
        self.characters = [self.kevin]
        self.proxies: list = []
        self.change = None
        self.rl.EMaterialTextureChannel_DiffuseBlend = "DiffuseBlend"
        self.rl.RRgb.side_effect = lambda r, g, b: (r, g, b)  # what cc5_api._cc5_rgb sends, for AddDiffuseKey
        self.rl.RScene.GetAvatars.side_effect = self._avatars
        self.rl.RScene.GetSelectedObjects.return_value = []
        self.rl.RGlobal.BeginAction.side_effect = lambda name: self.events.append(("begin", name))
        self.rl.RGlobal.EndAction.side_effect = lambda: self.events.append(("end",))
        self.rl.RFileIO.LoadFile.side_effect = self._load_file
        self.file = os.path.join(tempfile.mkdtemp(), "US_Army_Uniform_Pants.ccCloth")
        open(self.file, "wb").close()

    def _avatars(self):
        fresh = [FakeAvatar(c) for c in self.characters]  # SWIG returns new proxies on every call
        self.proxies += fresh
        return fresh

    def _load_file(self, path, record_step, avatar):
        self.events.append(("load",))
        if self.change is not None:
            self.change(avatar)
        return _Status()

    def load(self, change=None, target=None):
        self.change = change
        r = self.api.load_asset(self.file, target)
        # What the bridge sends: cc5-bridge.ts parses it with response.json(), which throws on NaN.
        json.dumps(r, allow_nan=False)
        return r

    def skin(self, material="Std_Skin_Head"):
        return self.kevin.table[("CC_Base_Body", material)]

    # --- what is reported ---

    def test_a_clothing_swap_and_a_skin_change_are_reported(self):
        # P7-3: the uniform pants swapped out the Boxers while the recipe said every step succeeded.
        def change(avatar):
            self.skin()["diffuse"] = (255, 255, 255)
            self.skin()["params"]["_BaseColorMap Brightness"] = [0.2]
            self.kevin.clothes.clear()
            self.kevin.wear("clothes", FakeItem(13, "Pants", {"Pants": ["M_Pants"]}))

        r = self.load(change)
        self.assertTrue(r["success"], r)
        self.assertEqual((r["path"], r["target"]), (self.file, "Kevin"))
        c = r["changes"]
        # No 'present' fact for Std_Boxers or M_Pants: the worn facts already say the items came and went.
        self.assertEqual(c["facts"], [
            {"kind": "worn_added", "group": "clothing", "id": "13", "name": "Pants"},
            {"kind": "worn_removed", "group": "clothing", "id": "11", "name": "Boxers"},
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [204, 153, 128], "after": [255, 255, 255]},
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "param",
             "name": "_BaseColorMap Brightness", "before": [0.0], "after": [0.2]},
        ])
        self.assertIs(c["complete"], True)
        # worn: Boxers, Pants and Buzz_Cut; morphs: the 2 sliders read; materials: the 7 listed both times.
        self.assertEqual(c["compared"], {"worn": 3, "morphs": 2, "materials": 7})
        self.assertEqual((c["skipped"], c["truncated"], c["target"], c["target_is_first"]), (0, False, "Kevin", True))
        self.assertIsInstance(c["elapsed_ms"], int)
        self.assertNotIn("notes", r)
        json.dumps(r, allow_nan=False)

    def test_both_reads_sit_outside_the_load_asset_undo_step(self):
        self.load(lambda avatar: self.skin("Std_Nails").update(diffuse=(0, 0, 0)))
        begin = self.events.index(("begin", "Load Asset"))
        end = self.events.index(("end",))
        self.assertEqual(self.events[begin + 1:end], [("load",)])  # nothing is read inside the undo step
        shader_reads = [i for i, e in enumerate(self.events) if e[:2] == ("read", "GetShader")]
        self.assertEqual(len([i for i in shader_reads if i < begin]), 8)  # every material, before the step
        self.assertEqual(len([i for i in shader_reads if i > end]), 8)  # and again after it
        self.rl.RGlobal.BeginAction.assert_called_once_with("Load Asset")
        self.rl.RGlobal.EndAction.assert_called_once_with()

    def test_reads_that_fail_leave_the_load_alone_and_name_what_was_not_compared(self):
        self.kevin.fail.add("GetClothes")
        self.skin("Std_Nails")["shader"] = RuntimeError("SWIG")  # one field: left out without a warning

        def change(avatar):
            self.kevin.fail.discard("GetClothes")  # CC5 failed the clothing read before the load only

        r = self.load(change)
        self.assertTrue(r["success"], r)
        self.rl.RGlobal.BeginAction.assert_called_once_with("Load Asset")
        self.rl.RGlobal.EndAction.assert_called_once_with()
        self.assertIs(r["changes"]["complete"], False)
        self.assertEqual(r["notes"], [NOT_COMPARED + "clothing"])
        self.assertEqual(r["changes"]["compared"]["worn"], 1)  # the hair only: clothing was not read both times
        self.assertEqual(r["changes"]["facts"], [])

    def test_unreadable_parts_are_named_in_read_order(self):
        self.kevin.fail.add("GetAvatarShapingComponent")

        def change(avatar):
            self.kevin.fail.discard("GetAvatarShapingComponent")
            self.kevin.materials = None  # no material component after the load

        r = self.load(change)
        c = r["changes"]
        self.assertIs(c["complete"], False)
        self.assertEqual(r["notes"], [NOT_COMPARED + "shaping morphs, the material list"])
        self.assertEqual(c["compared"], {"worn": 2, "morphs": 0, "materials": 0})
        self.assertEqual(c["skipped"], 0)

    def test_the_comparison_only_reads(self):
        r = self.load(lambda avatar: self.skin().update(diffuse=(1, 2, 3)))
        self.assertTrue(r["success"], r)
        g, scene, mats = self.rl.RGlobal, self.rl.RScene, self.kevin.materials
        for call in (g.RenderImage, g.Undo, g.Redo, g.SetRenderExportParameter, scene.GetCurrentCamera,
                     scene.ClearSelectObjects, mats.GetGlossinessWeight, mats.GetSpecularWeight,
                     mats.GetTextureWeights):
            call.assert_not_called()
        scene.SelectObject.assert_called_once()  # load_asset's own selection, as a click in CC5 would
        read = [e[4] for e in self.events if e[:2] == ("read", "GetShaderParameter")]
        self.assertIn("Original Roughness Strength", read)
        self.assertNotIn("padding1", read)
        channels = {e[4] for e in self.events if e[:2] == ("read", "HasImage")}
        self.assertEqual(channels, {"DiffuseBlend"})

    def test_the_read_after_the_load_finds_the_character_again_by_id(self):
        def change(avatar):
            for proxy in self.proxies:  # CC5 rebuilt the character: every handle from before the load is stale
                proxy.stale = True
            self.skin("Std_Skin_Arm")["diffuse"] = (10, 20, 30)

        r = self.load(change)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["target"], "Kevin")
        self.assertIs(r["changes"]["complete"], True)
        self.assertEqual([(f["material"], f["after"]) for f in r["changes"]["facts"]],
                         [("Std_Skin_Arm", [10, 20, 30])])
        self.assertNotIn("notes", r)

    def test_target_is_first_compares_ids(self):
        # GetAvatars returns new proxies on every call, so `is` would never match.
        self.characters.append(self.amy)
        self.assertIs(self.load()["changes"]["target_is_first"], True)
        r = self.load(target="Amy")
        c = r["changes"]
        self.assertEqual((r["target"], c["target"], c["target_is_first"], c["complete"]), ("Amy", "Amy", False, True))

    def test_a_character_gone_after_the_load_is_not_compared(self):
        r = self.load(lambda avatar: self.characters.remove(self.kevin))
        self.assertTrue(r["success"], r)
        c = r["changes"]
        self.assertEqual((c["complete"], c["facts"], c["target"]), (False, [], "Kevin"))
        self.assertEqual(r["notes"], [NOT_FOUND])

    def test_cc5_change_check_switches_the_comparison_off(self):
        for value in ("0", "off", "false", "no", " OFF "):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"CC5_CHANGE_CHECK": value}):
                self.events.clear()
                r = self.load(lambda avatar: self.skin().update(diffuse=(1, 1, 1)))
                self.assertTrue(r["success"], r)
                self.assertEqual((r["changes"]["complete"], r["changes"]["facts"]), (False, []))
                self.assertEqual(r["notes"], [SWITCHED_OFF])
                read = {e[1] for e in self.events if e[0] == "avatar"}
                self.assertFalse(read & {"GetClothes", "GetMaterialComponent", "GetAvatarShapingComponent"}, read)

    def test_the_comparison_is_on_unless_switched_off(self):
        for value in ("1", None):
            with self.subTest(value=value), mock.patch.dict(os.environ):
                if value is None:
                    os.environ.pop("CC5_CHANGE_CHECK", None)
                else:
                    os.environ["CC5_CHANGE_CHECK"] = value
                self.events.clear()
                r = self.load()
                self.assertIs(r["changes"]["complete"], True)
                self.assertIn(("avatar", "GetClothes"), self.events)

    def test_materials_past_the_time_limit_are_skipped_not_reported(self):
        ticks = itertools.count()

        def change(avatar):
            self.skin()["diffuse"] = (255, 255, 255)  # read first both times
            self.skin("Std_Nails")["diffuse"] = (0, 0, 0)  # never reached

        with mock.patch.object(self.changes, "_now", side_effect=lambda: float(next(ticks))):  # 1 s per call
            r = self.load(change)
        c = r["changes"]
        self.assertIs(c["complete"], True)
        self.assertGreater(c["skipped"], 0)
        self.assertEqual(c["compared"]["materials"] + c["skipped"], 8)
        self.assertEqual(c["facts"], [{"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head",
                                       "field": "diffuse", "before": [204, 153, 128], "after": [255, 255, 255]}])

    def test_a_load_that_waited_for_a_dialog_is_still_compared(self):
        # Each read has its own time limit: a minute in a CC5 question does not use up the read after the load.
        clock = [1000.0]

        def change(avatar):
            clock[0] += 60
            self.skin("Std_Nails")["diffuse"] = (0, 0, 0)

        with mock.patch.object(self.changes, "_now", side_effect=lambda: clock[0]):
            r = self.load(change)
        c = r["changes"]
        self.assertEqual((c["compared"]["materials"], c["skipped"]), (8, 0))
        self.assertEqual([f["material"] for f in c["facts"]], ["Std_Nails"])

    def test_a_hair_swap_is_reported_by_the_worn_facts_only(self):
        def change(avatar):
            self.kevin.hairs.clear()
            self.kevin.wear("hairs", FakeItem(14, "Afro", {"Afro": ["Afro_Transparency"]}))

        r = self.load(change)
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "worn_added", "group": "hair", "id": "14", "name": "Afro"},
            {"kind": "worn_removed", "group": "hair", "id": "12", "name": "Buzz_Cut"},
        ])
        self.assertIs(r["changes"]["complete"], True)

    def test_a_base_material_that_goes_is_a_present_fact(self):
        r = self.load(lambda avatar: self.kevin.base["CC_Base_Body"].remove("Std_Nails"))
        self.assertEqual(r["changes"]["facts"], [{"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Nails",
                                                  "field": "present", "before": True, "after": False}])

    def test_a_mesh_whose_materials_cannot_be_listed_proves_nothing(self):
        r = self.load(lambda avatar: self.kevin.unlisted.add("CC_Base_Eye"))
        self.assertEqual(r["changes"]["facts"], [])
        self.assertIs(r["changes"]["complete"], True)
        self.assertEqual(r["changes"]["compared"]["materials"], 7)

    def test_shader_opacity_and_blend_image_changes(self):
        def change(avatar):
            self.skin("Std_Skin_Body")["opacity"] = 50.0  # CC5 keeps opacity on 0-100
            self.skin("Std_Nails")["shader"] = "Digital_Human Nails"
            self.kevin.table[("CC_Base_Eye", "Std_Cornea_R")]["blend"] = False

        r = self.load(change)
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Body", "field": "opacity",
             "before": 1.0, "after": 0.5},
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Nails", "field": "shader",
             "before": "Pbr", "after": "Digital_Human Nails"},
            {"kind": "material", "mesh": "CC_Base_Eye", "material": "Std_Cornea_R", "field": "blend_image",
             "before": True, "after": False},
        ])

    def test_morph_and_subdivision_changes(self):
        self.kevin.morphs["Body Fat A"] = 0.3499999940395355  # CC5 keeps float32 weights (F-62)

        def change(avatar):
            self.kevin.morphs.update({"Body Fat A": 0.5, "Muscular": 0.2})
            self.kevin.subdivision = 1

        r = self.load(change)
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "morph", "id": "Body Fat A", "before": 0.35, "after": 0.5},
            {"kind": "morph", "id": "Muscular", "before": 0.0, "after": 0.2},
            {"kind": "subdivision", "before": 0, "after": 1},
        ])

    def test_a_nan_value_is_left_out_and_the_reply_stays_json(self):
        self.skin("Std_Skin_Body")["params"]["SSS Radius"] = [float("nan")]

        def change(avatar):
            self.skin()["params"]["Original Roughness Strength"] = [float("nan")]
            self.kevin.morphs["Muscular"] = float("nan")

        r = self.load(change)
        self.assertIs(r["changes"]["complete"], True)
        self.assertEqual(r["changes"]["facts"], [])
        json.dumps(r, allow_nan=False)

    def test_a_load_that_changes_nothing(self):
        r = self.load()
        self.assertEqual((r["changes"]["facts"], r["changes"]["complete"]), ([], True))
        self.assertNotIn("notes", r)

    def test_more_than_300_facts_are_cut_and_marked(self):
        sliders = [f"slider_{i:03}" for i in range(301)]
        self.kevin.morph_ids["Many"] = sliders
        r = self.load(lambda avatar: self.kevin.morphs.update({s: 0.5 for s in sliders}))
        self.assertEqual((len(r["changes"]["facts"]), r["changes"]["truncated"]), (300, True))

        def failing(avatar):
            self.kevin.morphs.update({s: 0.25 for s in sliders})
            raise RuntimeError("boom")

        r = self.load(failing)
        self.assertEqual(r["error"], "boom (CC5 reported an error, but it changed more than 300 things)")

    # --- a load that failed ---

    def test_a_failed_load_that_changed_something_says_so(self):
        def change(avatar):
            self.skin()["diffuse"] = (255, 255, 255)
            raise RuntimeError("boom")

        r = self.load(change)
        self.assertIs(r["success"], False)
        self.assertEqual(r["error"], "boom (CC5 reported an error, but it changed 1 thing)")
        # X-3: the file and the character, as a successful load names them: job_status words the report by the
        # kind of file loaded ('(file)' made it "this unknown load").
        self.assertEqual((r["path"], r["target"]), (self.file, "Kevin"))
        self.assertEqual(len(r["changes"]["facts"]), 1)
        self.assertNotIn("notes", r)
        self.assertEqual(sorted(r), ["changes", "error", "path", "success", "target"])

        def two(avatar):
            self.skin("Std_Skin_Arm")["diffuse"] = (1, 1, 1)
            self.kevin.subdivision = 1
            raise RuntimeError("boom")

        self.assertEqual(self.load(two)["error"], "boom (CC5 reported an error, but it changed 2 things)")

    def test_a_failed_load_names_the_character_it_was_aimed_at(self):
        self.characters.append(self.amy)

        def change(avatar):
            self.amy.table[("CC_Base_Body", "Std_Skin_Head")]["diffuse"] = (1, 2, 3)
            raise RuntimeError("boom")

        r = self.load(change, target="Amy")
        self.assertEqual((r["success"], r["path"], r["target"], r["changes"]["target"]),
                         (False, self.file, "Amy", "Amy"))
        self.assertEqual(r["changes"]["facts"], [{"kind": "material", "mesh": "CC_Base_Body",
                                                  "material": "Std_Skin_Head", "field": "diffuse",
                                                  "before": [180, 130, 110], "after": [1, 2, 3]}])

    def test_a_failed_load_that_changed_nothing_keeps_its_plain_error(self):
        def change(avatar):
            raise RuntimeError("boom")

        self.assertEqual(self.load(change), {"success": False, "error": "boom"})

    # --- F-90: CC5 reports a material's colour as it was when it last rendered ---

    def skin_reads(self, rgb):
        """What CC5's reads report for Kevin's four skin materials: the colour from its last render."""
        for name in SKIN:
            self.skin(name)["diffuse"] = rgb

    def test_f90_a_colour_set_before_the_load_is_not_reported_as_its_change(self):
        # Live 2026-10-07: recipe {base CC4 Kevin, skin_rgb (0.8, 0.6, 0.5), Sport Sneakers}: the sneakers' report
        # said "CHECK skin colour on Std_Skin_Head/Body/Arm/Leg: (1, 1, 1) -> (0.8, 0.6, 0.502)". CC5 still reported
        # the colour from before skin_rgb, and the new one right after LoadFile.
        self.skin_reads((255, 255, 255))
        self.assertTrue(self.api.set_skin_color(0.8, 0.6, 0.5)["success"])
        self.assertEqual(self.skin()["diffuse"], (255, 255, 255))  # CC5 still reports the colour from before
        self.assertEqual(self.api._writes_since_render,
                         {("1", "CC_Base_Body", name): {"diffuse": [204, 153, 128]} for name in SKIN})

        def sneakers(avatar):
            self.kevin.render()
            self.kevin.wear("clothes", FakeItem(15, "Sport_Sneakers", {"Sneakers": ["Std_Sneakers"]}))

        r = self.load(sneakers)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["changes"]["facts"],
                         [{"kind": "worn_added", "group": "clothing", "id": "15", "name": "Sport_Sneakers"}])
        self.assertIs(r["changes"]["complete"], True)
        # CC5 reports the colours it holds now: nothing is left to stand in for its reads, and nothing is marked as
        # possibly late (batch F review #3).
        self.assertEqual(self.api._writes_since_render, {})
        self.assertEqual(self.api._colours_late_since_undo, set())

    def test_f90_a_reset_by_the_load_is_reported_from_the_colour_the_bridge_set(self):
        self.skin_reads((230, 200, 190))  # CC5 still reports the template's colour
        self.api.set_skin_color(0.8, 0.6, 0.5)

        def reset(avatar):  # the preset sets the head back to white, and CC5 reports that at once
            del self.kevin.pending[("CC_Base_Body", "Std_Skin_Head")]
            self.skin()["diffuse"] = (255, 255, 255)

        r = self.load(reset)
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [204, 153, 128], "after": [255, 255, 255]}])
        # The head now reads what CC5 holds; the other three still report the template's colour, so they are named as
        # not checked (review #1)...
        self.assertEqual(r["notes"], [NOT_REFRESHED.format("Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg")])
        # ...and, since the bridge no longer knows what CC5 holds there, they leave the record too and Kevin is marked
        # as a character whose colour reads may be late (batch F review #3).
        self.assertEqual(self.api._writes_since_render, {})
        self.assertEqual(self.api._colours_late_since_undo, {"1"})

    def test_f90_a_recorded_colour_cc5_still_reads_as_before_is_named_as_not_checked(self):
        # Review #1: whether every LoadFile refreshes every material is not known, so a read still from before is no
        # CHECK line; but it is no longer dropped silently either.
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)
        r = self.load()
        self.assertEqual((r["changes"]["facts"], r["changes"]["complete"]), ([], True))
        self.assertEqual(r["notes"], [NOT_REFRESHED.format(SKIN_NAMES)])
        # Batch F review #3: CC5 holds the colour set, or the load set it back, and the reads cannot tell which. Kept,
        # the record would answer get_diffuse_color and the export with the colour set as CC5's; so the colours leave
        # it, and Kevin is marked: CC5 may report his colours late until a capture renders.
        self.assertEqual(self.api._writes_since_render, {})
        self.assertEqual(self.api._colours_late_since_undo, {"1"})

        # The next load: CC5 now reports the colour set. With no record to tell that from a change, it is not checked.
        r = self.load(lambda avatar: self.kevin.render())
        self.assertEqual(r["changes"]["facts"], [])
        self.assertEqual(r["notes"], [COLOURS_LATE.format("colour", SKIN_NAMES)])

        # A capture renders: the mark goes, and colours are compared as read again.
        self.assertTrue(self.api.capture_viewport(self.capture_renders())["success"])
        self.assertEqual(self.api._colours_late_since_undo, set())
        r = self.load(lambda avatar: self.skin().update(diffuse=(10, 20, 30)))
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [204, 153, 128], "after": [10, 20, 30]}])
        self.assertNotIn("notes", r)

    def test_f90_a_reset_to_the_colour_cc5_still_reported_is_not_silent(self):
        # Review #1: the template is white, the bridge set (0.8, 0.6, 0.5), and the preset sets the skin back to white.
        # The read before (white, from the last render) and after (white, fresh) agree, so the reset cannot be told
        # from a read CC5 has not refreshed: before, the report said nothing at all.
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)

        def reset(avatar):  # CC5 holds white again for all four, and reports it
            self.kevin.pending.clear()

        r = self.load(reset)
        self.assertEqual(r["changes"]["facts"], [])
        self.assertEqual(r["notes"], [NOT_REFRESHED.format(SKIN_NAMES)])
        # Batch F review #3: here CC5 does hold white, so a record kept would have given get_diffuse_color and the
        # export's tint read (0.8, 0.6, 0.502), a colour the skin no longer has.
        self.assertEqual(self.api._writes_since_render, {})
        self.assertEqual(self.api._colours_late_since_undo, {"1"})

    def test_f90_a_colour_cc5_still_reads_as_before_marks_only_its_own_character(self):
        # Batch F review #3, per character: a load on Kevin leaves Amy's record alone, and does not mark her.
        self.characters.append(self.amy)
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)  # the first character: Kevin
        self.api._writes_since_render[("2", "CC_Base_Body", "Std_Skin_Head")] = {"diffuse": [10, 20, 30]}
        r = self.load()  # nothing selected: the first character, Kevin
        self.assertEqual(r["target"], "Kevin")
        self.assertEqual(r["notes"], [NOT_REFRESHED.format(SKIN_NAMES)])
        self.assertEqual(self.api._writes_since_render,
                         {("2", "CC_Base_Body", "Std_Skin_Head"): {"diffuse": [10, 20, 30]}})
        self.assertEqual(self.api._colours_late_since_undo, {"1"})

    def test_f90_a_recorded_colour_not_read_before_the_load_stays_and_marks_nothing(self):
        # Batch F review #3 drops only a field that both reads saw and that did not move: a colour CC5 could not read
        # before the load says nothing about what CC5 holds, so the record keeps the colour set.
        self.skin_reads((255, 255, 255))
        self.assertTrue(self.api.set_diffuse_color("CC_Base_Body", "Std_Skin_Head", 0.8, 0.6, 0.5)["success"])
        head = self.skin()
        head["diffuse"] = RuntimeError("SWIG")  # CC5 cannot read the head's colour before the load
        r = self.load(lambda avatar: head.update(diffuse=(255, 255, 255)))
        self.assertEqual((r["changes"]["facts"], r["changes"]["complete"]), ([], True))
        self.assertNotIn("notes", r)
        self.assertEqual(self.api._writes_since_render,
                         {("1", "CC_Base_Body", "Std_Skin_Head"): {"diffuse": [204, 153, 128]}})
        self.assertEqual(self.api._colours_late_since_undo, set())

    def test_f90_a_comparison_handed_no_set_still_settles_the_record_and_marks_nothing(self):
        # Marking never raises: without a set to add the character to, nothing is marked, and the record still goes.
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)
        state = self.changes.begin(FakeAvatar(self.kevin), "Kevin", record=self.api._writes_since_render,
                                   colours_late=("1",))
        self.assertIsNone(state["late_ids"])
        _changes, notes = self.changes.finish(state)
        self.assertEqual(notes, [NOT_REFRESHED.format(SKIN_NAMES)])
        self.assertEqual(self.api._writes_since_render, {})
        self.assertEqual(self.api._colours_late_since_undo, set())

    def test_f90_a_colour_and_an_opacity_cc5_still_reads_as_before_are_named_in_one_note(self):
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)
        self.api.set_material_opacity("CC_Base_Body", "Std_Skin_Body", 0.5)
        r = self.load()
        self.assertEqual(r["notes"], [
            f"WARNING: CC5 still reports the colour and opacity from before the bridge set them on {SKIN_NAMES}, so "
            "whether this load changed them was not checked: capture, then compare"])

    def test_f90_a_note_names_at_most_12_materials(self):
        self.kevin.base["CC_Base_Body"] += [f"Std_Extra_{i:02}" for i in range(14)]
        for i in range(14):
            self.kevin.table[("CC_Base_Body", f"Std_Extra_{i:02}")] = _material()
            self.api.set_diffuse_color("CC_Base_Body", f"Std_Extra_{i:02}", 0.1, 0.2, 0.3)
        r = self.load()
        extras = ", ".join(f"Std_Extra_{i:02}" for i in range(12))
        self.assertEqual(r["notes"], [NOT_REFRESHED.format(f"{extras} and 2 more")])

    def test_f90_after_a_load_changed_a_recorded_colour_the_next_load_compares_cc5s_reads(self):
        self.skin_reads((230, 200, 190))
        self.api.set_skin_color(0.8, 0.6, 0.5)

        def reset(avatar):
            self.kevin.render()
            self.skin()["diffuse"] = (255, 255, 255)

        self.assertEqual([f["before"] for f in self.load(reset)["changes"]["facts"]], [[204, 153, 128]])
        self.assertEqual(self.api._writes_since_render, {})
        r = self.load(lambda avatar: self.skin().update(diffuse=(10, 20, 30)))
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [255, 255, 255], "after": [10, 20, 30]}])

    def test_f90_an_opacity_set_before_the_load_is_not_reported_as_its_change(self):
        self.assertTrue(self.api.set_material_opacity("CC_Base_Body", "Std_Skin_Body", 0.5)["success"])
        self.assertEqual(self.api._writes_since_render, {("1", "CC_Base_Body", "Std_Skin_Body"): {"opacity": 0.5}})
        self.assertEqual(self.skin("Std_Skin_Body")["opacity"], 100.0)  # CC5 still reports 100 (on its 0-100 scale)
        r = self.load(lambda avatar: self.kevin.render())
        self.assertEqual(r["changes"]["facts"], [])

    def test_f90_the_record_is_kept_per_character(self):
        self.characters.append(self.amy)
        self.api.set_skin_color(0.8, 0.6, 0.5)  # the first character: Kevin

        def change(avatar):
            self.amy.table[("CC_Base_Body", "Std_Skin_Head")]["diffuse"] = (1, 2, 3)

        r = self.load(change, target="Amy")
        self.assertEqual([(f["before"], f["after"]) for f in r["changes"]["facts"]], [([180, 130, 110], [1, 2, 3])])
        self.assertEqual(len(self.api._writes_since_render), 4)  # Kevin's entries are left alone
        self.assertEqual(self.api._colours_late_since_undo, set())  # and nobody is marked (batch F review #3)

    def test_f90_a_capture_an_undo_and_a_redo_clear_the_record(self):
        shot = os.path.join(tempfile.mkdtemp(), "shot.png")

        def render_image(path):
            with open(path, "wb") as f:
                f.write(b"png")
            self.kevin.render()

        self.rl.RGlobal.RenderImage.side_effect = render_image
        steps = (("capture", lambda: self.api.capture_viewport(shot)), ("undo", self.api.undo),
                 ("redo", self.api.redo))
        for name, step in steps:
            with self.subTest(name):
                self.api.set_skin_color(0.8, 0.6, 0.5)
                self.assertEqual(len(self.api._writes_since_render), 4)
                self.assertTrue(step()["success"])
                self.assertEqual(self.api._writes_since_render, {})

    def test_f90_a_capture_without_a_render_keeps_the_record(self):
        # The window screenshot (capture_viewport's last fallback) is no render: CC5's reads stay as they were.
        self.api.set_skin_color(0.8, 0.6, 0.5)
        shot = os.path.join(tempfile.mkdtemp(), "shot.png")
        with mock.patch.object(self.api, "_capture_window_screenshot",
                               side_effect=lambda path: open(path, "wb").close()):
            self.assertTrue(self.api.capture_viewport(shot)["success"])
        self.assertEqual(len(self.api._writes_since_render), 4)

    def test_f90_the_record_is_kept_across_reload(self):
        self.api.set_skin_color(0.8, 0.6, 0.5)
        importlib.reload(self.api)
        self.assertEqual(len(self.api._writes_since_render), 4)

    # --- review #20: after an undo or redo, CC5's reads may still give the colours of its last render ---

    def capture_renders(self):
        """A capture path; RenderImage writes the file and renders (CC5's reads then report what it holds)."""
        shot = os.path.join(tempfile.mkdtemp(), "shot.png")

        def render_image(path):
            with open(path, "wb") as f:
                f.write(b"png")
            self.kevin.render()

        self.rl.RGlobal.RenderImage.side_effect = render_image
        return shot

    def test_after_an_undo_colour_differences_without_a_record_are_not_checked_until_a_capture(self):
        # Set (0.8, 0.6, 0.5) and capture: CC5 reads the new colour. Undo: CC5 holds white again, but its reads keep the
        # colour of its last render. Then a load that refreshes the reads (live, F-90: the sneakers' load did): before,
        # it got "CHECK skin colour ... (0.8, 0.6, 0.502) -> (1, 1, 1)", F-90's own symptom.
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)
        shot = self.capture_renders()
        self.assertTrue(self.api.capture_viewport(shot)["success"])
        self.assertEqual(self.skin()["diffuse"], (204, 153, 128))

        def undo():  # CC5 holds white again; its reads report it only after the next render
            for name in SKIN:
                self.kevin.pending[("CC_Base_Body", name)] = {"diffuse": (255, 255, 255)}

        self.rl.RGlobal.Undo.side_effect = undo
        self.assertTrue(self.api.undo()["success"])
        self.assertEqual(self.api._writes_since_render, {})
        self.assertEqual(self.api._colours_late_since_undo, {"1"})  # Kevin, by id

        def sneakers(avatar):
            self.kevin.render()
            self.kevin.wear("clothes", FakeItem(15, "Sport_Sneakers", {"Sneakers": ["Std_Sneakers"]}))

        r = self.load(sneakers)
        self.assertEqual(r["changes"]["facts"],
                         [{"kind": "worn_added", "group": "clothing", "id": "15", "name": "Sport_Sneakers"}])
        self.assertEqual(r["notes"], [COLOURS_LATE.format("colour", SKIN_NAMES)])

        # A capture renders: from then on colours are compared as read.
        self.rl.RGlobal.Undo.side_effect = None
        self.assertTrue(self.api.capture_viewport(shot)["success"])
        self.assertEqual(self.api._colours_late_since_undo, set())
        r = self.load(lambda avatar: self.skin().update(diffuse=(10, 20, 30)))
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [255, 255, 255], "after": [10, 20, 30]}])
        self.assertNotIn("notes", r)

    def test_after_an_undo_an_opacity_difference_is_held_too_and_a_recorded_colour_still_counts(self):
        self.api._mark_colours_late()  # an undo or redo ran since CC5 last rendered, with Kevin in the scene
        self.skin_reads((255, 255, 255))
        self.api.set_skin_color(0.8, 0.6, 0.5)  # set again after the undo: compared from the record

        def change(avatar):
            self.kevin.render()
            self.skin("Std_Nails")["opacity"] = 40.0
            self.skin("Std_Nails")["shader"] = "Digital_Human Nails"  # not a colour: compared as read

        r = self.load(change)
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Nails", "field": "shader",
             "before": "Pbr", "after": "Digital_Human Nails"}])
        self.assertEqual(r["notes"], [COLOURS_LATE.format("opacity", "Std_Nails")])

    def test_undo_and_redo_mark_the_characters_in_the_scene_and_the_marks_are_kept_across_reload(self):
        self.characters.append(self.amy)
        self.assertEqual(self.api._colours_late_since_undo, set())
        self.rl.RGlobal.Undo.side_effect = RuntimeError("SWIG")
        self.assertFalse(self.api.undo()["success"])
        self.assertEqual(self.api._colours_late_since_undo, set())  # nothing was undone
        self.rl.RGlobal.Undo.side_effect = None
        self.assertTrue(self.api.undo()["success"])
        self.assertEqual(self.api._colours_late_since_undo, {"1", "2"})  # Kevin and Amy, by id
        importlib.reload(self.api)
        self.assertEqual(self.api._colours_late_since_undo, {"1", "2"})
        self.api._clear_colours_late()
        self.characters.remove(self.kevin)
        self.assertTrue(self.api.redo()["success"])
        self.assertEqual(self.api._colours_late_since_undo, {"2"})  # only the character in the scene at the redo
        # An earlier copy of the module kept one flag (a bool) for every character: it names none.
        self.api._colours_late_since_undo = True
        importlib.reload(self.api)
        self.assertEqual(self.api._colours_late_since_undo, set())

    def test_a_capture_that_rendered_clears_the_marks_and_a_window_screenshot_does_not(self):
        shot = self.capture_renders()
        self.api.undo()
        self.assertTrue(self.api.capture_viewport(shot)["success"])
        self.assertEqual(self.api._colours_late_since_undo, set())
        self.api.undo()
        self.rl.RGlobal.RenderImage.side_effect = None  # no render: capture_viewport's last fallback
        with mock.patch.object(self.api, "_capture_window_screenshot",
                               side_effect=lambda path: open(path, "wb").close()):
            self.assertTrue(self.api.capture_viewport(shot)["success"])
        self.assertEqual(self.api._colours_late_since_undo, {"1"})

    def test_a_character_loaded_after_the_undo_is_compared_as_read(self):
        # Review #20, per character: a recipe's base or a batch variant's new character is loaded after the undo, so no
        # undo touched its materials, and a colour its load changes stays a CHECK line (a preset that resets the skin
        # colour fails a batch variant). Only a character that was in the scene at the undo gets the NOT CHECKED note.
        self.assertTrue(self.api.undo()["success"])  # Kevin is the only character in the scene
        self.assertEqual(self.api._colours_late_since_undo, {"1"})
        self.characters.append(self.amy)  # loaded after the undo

        amy_head = self.amy.table[("CC_Base_Body", "Std_Skin_Head")]
        r = self.load(lambda avatar: amy_head.update(diffuse=(240, 230, 225)), target="Amy")
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [180, 130, 110], "after": [240, 230, 225]}])
        self.assertNotIn("notes", r)

        r = self.load(lambda avatar: self.skin().update(diffuse=(240, 230, 225)), target="Kevin")
        self.assertEqual(r["changes"]["facts"], [])
        self.assertEqual(r["notes"], [COLOURS_LATE.format("colour", "Std_Skin_Head")])

        # A capture that rendered clears the marks: Kevin's colours are compared as read again.
        self.assertTrue(self.api.capture_viewport(self.capture_renders())["success"])
        self.assertEqual(self.api._colours_late_since_undo, set())
        r = self.load(lambda avatar: self.skin().update(diffuse=(10, 20, 30)), target="Kevin")
        self.assertEqual(r["changes"]["facts"], [
            {"kind": "material", "mesh": "CC_Base_Body", "material": "Std_Skin_Head", "field": "diffuse",
             "before": [240, 230, 225], "after": [10, 20, 30]}])
        self.assertNotIn("notes", r)

    def test_an_undo_that_cannot_read_the_characters_marks_none_and_still_succeeds(self):
        # Amy's id reads and Kevin's does not: nothing is marked, not Amy alone.
        self.characters.insert(0, self.amy)
        self.kevin.fail.add("GetID")
        self.assertTrue(self.api.undo()["success"])
        self.assertEqual(self.api._colours_late_since_undo, set())
        self.rl.RScene.GetAvatars.side_effect = RuntimeError("SWIG")
        self.api._mark_colours_late()  # never raises
        self.assertEqual(self.api._colours_late_since_undo, set())

    def test_the_marks_reach_the_comparison_only_for_a_character_they_name(self):
        # cc5_changes.begin takes the ids; anything that is no collection of ids marks no character.
        for late, expected in (({"1"}, True), ({"2"}, False), (set(), False), ([1], True), (True, False),
                               (None, False)):
            with self.subTest(late=late):
                state = self.changes.begin(FakeAvatar(self.kevin), "Kevin", colours_late=late)
                self.assertIs(state["colours_late"], expected)
                self.assertIsNotNone(state["before"])
                # Batch F review #3: finish() can add the character only to a set (cc5_api's), so only a set is kept.
                self.assertIs(state["late_ids"], late if isinstance(late, set) else None)

    def test_the_late_colours_note_says_may_and_what_was_seen(self):
        # Batch F review #14: that CC5 reports colours late after an undo or redo is inferred from F-90 (live: a colour
        # set without an undo), not seen, so the note does not state it as CC5's behaviour.
        note = self.changes.COLOURS_LATE
        self.assertTrue(note.startswith("WARNING: CC5 may report material colours late after an undo, a redo or a load "
                                        "that left a colour unsettled (seen for a colour set without an undo, F-90; "
                                        "not checked live after an undo), so "), note)
        self.assertNotIn("CC5 reports material colours late", note)

    # --- the comparison never stops a load ---

    def test_a_character_that_cannot_be_read_before_the_load_is_not_compared(self):
        with mock.patch.object(self.changes, "snapshot", side_effect=RuntimeError("SWIG")):
            r = self.load()
        self.assertTrue(r["success"], r)
        self.assertIs(r["changes"]["complete"], False)
        self.assertEqual(r["notes"], ["WARNING: the character could not be read before the load (SWIG), "
                                      "so nothing was compared"])

    def test_a_comparison_that_fails_after_the_load_says_so(self):
        with mock.patch.object(self.changes, "diff", side_effect=RuntimeError("bad")):
            r = self.load()
        self.assertTrue(r["success"], r)
        self.assertIs(r["changes"]["complete"], False)
        self.assertEqual(r["notes"], ["WARNING: the before/after comparison failed after the load: bad"])
        with mock.patch.object(self.changes, "finish", side_effect=RuntimeError("worse")):
            r = self.load()
        self.assertTrue(r["success"], r)
        self.assertEqual(r["changes"]["facts"], [])
        self.assertEqual(r["notes"], ["WARNING: the before/after comparison failed after the load: worse"])

    def test_a_plugin_copy_without_cc5_changes_still_loads(self):
        sys.modules["cc5_changes"] = None  # `import cc5_changes` now fails, as with a hand copy that lacks the file
        self.addCleanup(sys.modules.pop, "cc5_changes", None)
        r = self.load()
        self.assertTrue(r["success"], r)
        self.rl.RFileIO.LoadFile.assert_called_once()
        self.assertTrue(r["notes"][0].startswith("WARNING: the before/after comparison could not start: "), r)
        self.assertIs(r["changes"]["complete"], False)
        self.assertEqual(r["changes"]["facts"], [])

    def test_reload_drops_cc5_changes_so_the_next_load_reads_the_file_again(self):
        sys.modules["cc5_changes"] = object()
        importlib.reload(self.api)
        self.assertNotIn("cc5_changes", sys.modules)

    def test_cc5_changes_is_not_an_extension_module(self):
        # load_extensions merges each listed module's ACTIONS: listing this one would stop the bridge from starting.
        self.assertFalse(hasattr(self.changes, "ACTIONS"))
        srv = _support.fresh_import("server")
        self.assertNotIn("cc5_changes", srv.EXTENSION_MODULES)


if __name__ == "__main__":
    unittest.main()

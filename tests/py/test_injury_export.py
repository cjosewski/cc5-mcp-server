"""export_for_unity and injuries (F-75): an FBX carries neither a Diffuse Blend overlay nor the skin shader's pallor.
The export lists what it does not carry, refuses to go ahead without the user's per-export choice, and carries the
injuries as chosen: 'bake' (into this export's diffuse textures), 'separate' (images + sidecar JSON) or 'omit'."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

import _support

DIFFUSE_BLEND = 7  # RLPy.EMaterialTextureChannel_DiffuseBlend (live)
AVATAR_ID = "kevin-1"
BODY = "CC_Base_Body"
PALE_06 = {"_BaseColorMap Brightness": 0.036, "_BaseColorMap Saturation": -0.15}  # set_skin_condition('pale', 0.6)
SKIN = ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"]
WARNING = "WARNING: injuries not carried: "


def _write(path: str, data: bytes = b"\x89PNG overlay") -> None:
    with open(path, "wb") as f:
        f.write(data)


class _Rgb:
    def __init__(self, r, g, b):
        self._rgb = (r, g, b)

    def Red(self):
        return self._rgb[0]

    def Green(self):
        return self._rgb[1]

    def Blue(self):
        return self._rgb[2]


class InjuryTestCase(unittest.TestCase):
    """CC4 Kevin in a uniform: per-material Diffuse Blend images and weights, pallor offsets and diffuse colours, and a
    Unity project to export into. The fake export writes <name>.fbx and <name>.fbm/<file> for each of diffuse_files."""

    MATERIALS = {BODY: SKIN, "CC_Base_Eye": ["Std_Cornea_L"], "Shirt": ["M_Shirt"]}

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.rl.EMaterialTextureChannel_DiffuseBlend = DIFFUSE_BLEND
        self.skin = _support.fresh_import("cc5_skin")
        self.pipe = self.skin.cc5_pipeline
        self.root = tempfile.mkdtemp()
        marker = os.path.join(self.root, "ProjectSettings", "ProjectVersion.txt")
        os.makedirs(os.path.dirname(marker))
        with open(marker, "w", encoding="utf-8") as f:
            f.write("m_EditorVersion: 6000.2.10f1\n")
        self.unity_dir = os.path.join(self.root, "Assets", "Patients")
        self.folder = os.path.join(self.unity_dir, "P1")
        self.materials = {mesh: list(mats) for mesh, mats in self.MATERIALS.items()}
        self.images: set = set()  # (mesh, material) with a Diffuse Blend image
        self.weights: dict = {}  # (mesh, material) -> the Diffuse Blend weight CC5 reads
        self.shader: dict = {}  # (mesh, material) -> pallor offsets
        self.colors: dict = {}  # (mesh, material) -> diffuse colour, 0-255
        self.diffuse_files = None  # file names the fake export writes into <name>.fbm (None: <Material>_Diffuse.jpg each)
        self.avatar = self._avatar()
        self.mc = self.avatar.GetMaterialComponent.return_value
        p = mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=self._export)
        self.export_fbx = e.start()
        self.addCleanup(e.stop)

    def _avatar(self):
        avatar = mock.MagicMock(name="Kevin")
        avatar.GetID.return_value = AVATAR_ID
        avatar.GetName.return_value = "Kevin"
        avatar.GetMeshNames.side_effect = lambda *a: list(self.materials)
        mc = avatar.GetMaterialComponent.return_value
        mc.GetMaterialNames.side_effect = lambda mesh: list(self.materials[mesh])
        mc.HasImage.side_effect = lambda mesh, mat, channel: (mesh, mat) in self.images
        mc.GetTextureWeights.side_effect = lambda mesh, mat: (
            [0.0] * DIFFUSE_BLEND + [self.weights.get((mesh, mat), 0.0)] + [0.0])
        mc.GetShaderParameterNames.side_effect = lambda mesh, mat: list(PALE_06) if mesh == BODY else []
        mc.GetShaderParameter.side_effect = lambda mesh, mat, name: [self.shader.get((mesh, mat), {}).get(name, 0.0)]
        mc.GetDiffuseColor.side_effect = lambda mesh, mat: _Rgb(*self.colors.get((mesh, mat), (255, 255, 255)))
        return avatar

    def _export(self, path, flags, **kw):
        _write(path, b"fbx")
        fbm = os.path.splitext(path)[0] + ".fbm"
        os.makedirs(fbm, exist_ok=True)
        names = self.diffuse_files
        if names is None:
            names = list(dict.fromkeys(f"{m}_Diffuse.jpg" for mats in self.materials.values() for m in mats))
        for name in names:
            _write(os.path.join(fbm, name), b"jpg " + name.encode())
        return {"success": True, "flags_applied": True, "notes": ["target_tool=Unity preset applied"], "export_level": 0}

    def export(self, injuries=None, **kw):
        return self.pipe.export_for_unity(self.unity_dir, "P1", injuries=injuries, **kw)

    def overlay(self, mat="Std_Skin_Arm", weight=0.6, mesh=BODY):
        self.images.add((mesh, mat))
        self.weights[(mesh, mat)] = weight

    def record(self, image, strength, mat="Std_Skin_Arm", mesh=BODY):
        """What load_texture / apply_skin_overlay record for a material this bridge loaded an overlay into."""
        self.pipe.BLEND_SOURCES[(AVATAR_ID, mesh, mat)] = {"image": image, "strength": strength}

    def pale(self, mats=SKIN, offsets=PALE_06):
        for mat in mats:
            self.shader[(BODY, mat)] = dict(offsets)

    def source_image(self, name="bruise.png", data=b"\x89PNG the bruise"):
        path = os.path.join(tempfile.mkdtemp(), name)
        _write(path, data)
        return path


class NeedsChoiceTest(InjuryTestCase):
    def test_an_overlay_without_a_choice_is_not_exported(self):
        self.overlay()
        r = self.export()
        self.assertFalse(r["success"])
        self.assertTrue(r["needs_choice"])
        self.assertIn("Choose injuries 'bake', 'separate' or 'omit'", r["error"])
        self.assertIn("an overlay image on Std_Skin_Arm (Diffuse Blend overlay at 60%)", r["injuries"]["not_carried"])
        self.assertIsNone(r["injuries"]["choice"])
        self.export_fbx.assert_not_called()
        self.assertFalse(os.path.exists(self.folder))

    def test_pallor_without_a_choice_is_not_exported(self):
        self.pale()
        r = self.export()
        self.assertTrue(r["needs_choice"])
        self.assertEqual(r["injuries"]["not_carried"], [
            "pale skin on Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg "
            "(Digital Human skin shader: Brightness +0.036, Saturation -0.150)"])
        self.export_fbx.assert_not_called()
        self.assertFalse(os.path.exists(self.folder))

    def test_an_overlay_on_a_worn_item_counts(self):
        # load_texture('diffuse_blend') can put an overlay on any material, and the FBX drops it there too.
        self.overlay("M_Shirt", 0.4, mesh="Shirt")
        r = self.export()
        self.assertTrue(r["needs_choice"])
        self.assertIn("an overlay image on M_Shirt (Diffuse Blend overlay at 40%)", r["injuries"]["not_carried"])

    def test_a_cornea_image_at_0_without_a_record_is_not_an_overlay(self):
        # CC4 Kevin's corneas carry a Diffuse Blend image at 0 by design.
        self.overlay("Std_Cornea_L", 0.0, mesh="CC_Base_Eye")
        r = self.export()
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["not_carried"], [])
        self.export_fbx.assert_called_once()

    def test_a_skin_image_that_reads_0_without_a_record_may_be_showing(self):
        # The read can be stale until CC5 renders, and a .ccAvatar's overlay has no record: never drop it silently.
        self.overlay(weight=0.0)
        r = self.export()
        self.assertTrue(r["needs_choice"])
        self.assertEqual(r["injuries"]["not_carried"], [
            "an overlay image on Std_Skin_Arm (Diffuse Blend overlay; CC5 reads its strength as 0, which can be stale "
            "until CC5 renders, so it may be showing)"])

    def test_bake_refuses_an_overlay_of_unknown_strength(self):
        self.overlay(weight=0.0)
        with mock.patch.object(self.skin, "_paint_bake") as paint:
            r = self.export("bake")
        self.assertTrue(r["success"])
        failed = ("Std_Skin_Arm: the overlay's strength is unknown (CC5 reads 0 until it renders): run capture_viewport, "
                  "then export again")
        self.assertEqual(r["injuries"]["failed"], [failed])
        self.assertIn(WARNING + failed, r["notes"])
        paint.assert_not_called()

    def test_separate_ships_an_overlay_of_unknown_strength_with_a_null_strength(self):
        self.overlay(weight=0.0)
        self.mc.GetImage.return_value.SaveFile.side_effect = _write
        r = self.export("separate")
        self.assertTrue(r["success"])
        self.assertTrue(os.path.isfile(os.path.join(self.folder, "Injuries", "Std_Skin_Arm_DiffuseBlend.png")))
        with open(os.path.join(self.folder, "P1_injuries.json"), encoding="utf-8") as f:
            sidecar = json.load(f)
        self.assertIsNone(sidecar["overlays"][0]["strength"])
        self.assertIn("Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, strength unknown)", r["injuries"]["done"])
        self.assertIn("Std_Skin_Arm: strength unknown in the sidecar (null)", r["injuries"]["notes"])
        self.assertEqual(r["injuries"]["failed"], [])

    def test_an_unknown_choice_is_refused_before_cc5_is_asked_anything(self):
        self.overlay()
        r = self.export("paint")
        self.assertEqual(r, {"success": False, "error": "injuries must be one of: bake, separate, omit"})
        self.avatar.GetMaterialComponent.assert_not_called()
        self.mc.HasImage.assert_not_called()
        self.export_fbx.assert_not_called()
        self.assertFalse(os.path.exists(self.folder))

    def test_a_material_cc5_cannot_read_is_not_verified_but_does_not_stop_the_export(self):
        def has_image(mesh, mat, channel):
            if mat == "Std_Skin_Leg":
                raise RuntimeError("boom")
            return False
        self.mc.HasImage.side_effect = has_image
        r = self.export()
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["unverified"], [
            "Std_Skin_Leg: CC5 could not read its Diffuse Blend layer (boom), so an overlay there is not ruled out"])

    def test_an_overlay_that_cannot_be_checked_is_not_verified_and_the_state_never_raises(self):
        # CC5 gives an int id live; an id that cannot key BLEND_SOURCES must not make every export fail.
        self.overlay()
        self.avatar.GetID.return_value = ["not", "hashable"]
        r = self.export()
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["not_carried"], [])
        self.assertEqual(len(r["injuries"]["unverified"]), 1)
        # The TypeError's wording differs between Python versions; it always says "unhashable".
        self.assertRegex(r["injuries"]["unverified"][0], r"^Std_Skin_Arm: its Diffuse Blend overlay could not be "
                                                         r"checked \(.*unhashable.*\), so an overlay there is not ruled out$")


class BlendSourcesTest(InjuryTestCase):
    """The bridge's record of the strength it set wins over CC5's read, which lags until CC5 renders (F-65)."""

    def state(self):
        return self.skin.skin_export_state(self.avatar)

    def test_a_read_of_0_uses_the_strength_the_bridge_set(self):
        image = self.source_image()
        self.overlay(weight=0.0)
        self.record(image, 0.6)
        state = self.state()
        self.assertEqual(state["overlays"], [{"mesh": BODY, "material": "Std_Skin_Arm", "strength": 0.6, "image": image,
                                               "skin": True}])
        self.assertEqual(state["notes"], ["Std_Skin_Arm: CC5 read the overlay strength as 0 (it updates when CC5 "
                                          "renders); used the 60% the bridge set"])
        report = self.skin.injury_report(state, None)
        self.assertEqual(report["not_carried"], ["bruise.png on Std_Skin_Arm (Diffuse Blend overlay at 60%)"])

    def test_a_read_that_disagrees_with_the_record_uses_the_record_and_names_both(self):
        self.overlay(weight=0.6)
        self.record(self.source_image(), 0.3)
        state = self.state()
        self.assertEqual(state["overlays"][0]["strength"], 0.3)
        self.assertEqual(state["notes"], [
            "Std_Skin_Arm: CC5 reads 60% but the bridge last set 30%; used 30% (CC5's read lags until it renders; after "
            "an undo or a change made in CC5 itself 60% would be right: capture_viewport and check)"])

    def test_a_record_at_0_that_cc5_reads_as_0_is_not_an_overlay(self):
        self.overlay(weight=0.0)
        self.record(self.source_image(), 0.0)
        state = self.state()
        self.assertEqual((state["overlays"], state["notes"]), ([], []))
        self.assertFalse(self.skin.needs_injury_choice(state))

    def test_a_record_at_0_while_cc5_reads_more_is_an_overlay_at_the_read(self):
        # P-1: an undo, or a change made in CC5, can bring the overlay back after the bridge set it to 0. It must never
        # be dropped silently: CC5's read is used, and the bridge's image is not trusted.
        self.overlay(weight=0.6)
        self.record(self.source_image(), 0.0)
        state = self.state()
        self.assertEqual(state["overlays"], [{"mesh": BODY, "material": "Std_Skin_Arm", "strength": 0.6, "image": None,
                                               "skin": True, "stale": True}])
        self.assertEqual(state["notes"], ["Std_Skin_Arm: the bridge last set 0%, CC5 reads 60%: an undo or a change "
                                          "made in CC5; used 60%"])
        self.assertTrue(self.skin.needs_injury_choice(state))
        r = self.export()
        self.assertTrue(r["needs_choice"])
        self.assertEqual(r["injuries"]["not_carried"],
                         ["an overlay image on Std_Skin_Arm (Diffuse Blend overlay at 60%)"])
        self.export_fbx.assert_not_called()

    def test_the_report_says_an_image_it_names_is_the_one_this_bridge_last_loaded(self):
        # P-1: the image comes from the bridge's record; an image changed in CC5 itself is not seen.
        self.overlay()
        self.record(self.source_image(), 0.6)
        report = self.skin.injury_report(self.state(), None)
        self.assertEqual(report["not_carried"], ["bruise.png on Std_Skin_Arm (Diffuse Blend overlay at 60%)"])
        self.assertEqual(report["notes"], ["Overlay images are named as this bridge last loaded them "
                                           "(apply_skin_overlay, load_texture): an image changed in CC5 itself is not "
                                           "seen."])
        self.pipe.BLEND_SOURCES.clear()  # no record: no image is named, so no such note
        report = self.skin.injury_report(self.state(), None)
        self.assertEqual((report["not_carried"], report["notes"]),
                         (["an overlay image on Std_Skin_Arm (Diffuse Blend overlay at 60%)"], []))

    def test_a_read_that_is_not_a_number_counts_as_unread(self):
        # P-8: a NaN read would reach the JSON reply, which the MCP server cannot parse.
        self.overlay(weight=float("nan"))
        state = self.state()
        self.assertEqual(state["overlays"], [{"mesh": BODY, "material": "Std_Skin_Arm", "strength": None, "image": None,
                                               "skin": True}])
        self.assertTrue(self.skin.needs_injury_choice(state))

    def test_a_record_that_agrees_adds_no_note_and_another_avatars_record_does_not_count(self):
        self.overlay(weight=0.6)
        self.record(self.source_image(), 0.6)
        self.pipe.BLEND_SOURCES[("someone-else", BODY, "Std_Skin_Head")] = {"image": "x.png", "strength": 1.0}
        self.overlay("Std_Skin_Head", 0.0)
        state = self.state()
        self.assertEqual(state["notes"], [])
        self.assertEqual([(o["material"], o["strength"]) for o in state["overlays"]],
                         [("Std_Skin_Head", None), ("Std_Skin_Arm", 0.6)])

    def test_the_state_never_raises_when_cc5_cannot_list_the_meshes(self):
        self.avatar.GetMeshNames.side_effect = RuntimeError("gone")
        state = self.state()
        self.assertEqual(state["unread"], ["the character's materials: CC5 could not list them (gone), so overlays "
                                           "and a skin condition are not ruled out"])
        self.assertFalse(self.skin.needs_injury_choice(state))

    def test_brightness_below_0_is_a_skin_change_not_pale(self):
        self.pale(["Std_Skin_Arm"], {"_BaseColorMap Brightness": -0.05, "_BaseColorMap Saturation": 0.0})
        report = self.skin.injury_report(self.state(), None)
        self.assertEqual(report["not_carried"], [
            "skin Brightness/Saturation change on Std_Skin_Arm (Digital Human skin shader: Brightness -0.050, "
            "Saturation +0.000)"])
        self.assertEqual((report["done"], report["failed"], report["calibrated"]), ([], [], None))


class StaleRecordTest(InjuryTestCase):
    """P-1: an undo or redo can bring back another overlay image or strength than the bridge last set, so cc5_api's
    undo() and redo() mark every BLEND_SOURCES record stale. A stale record never overrides CC5's read, and its image is
    neither shipped nor baked."""

    NOT_KNOWN = ("Std_Skin_Arm: the overlay image is not known after an undo or a change made in CC5: re-apply it with "
                 "apply_skin_overlay or load_texture, then export again")

    def stale(self, image, strength, read, mat="Std_Skin_Arm", mesh=BODY):
        """bruise.png then `image` applied, then an undo: CC5 reads `read`, the record says `image` at `strength`."""
        self.overlay(mat, read, mesh=mesh)
        self.record(image, strength, mat, mesh)
        self.pipe.mark_blend_sources_stale()

    def test_mark_blend_sources_stale_marks_every_record(self):
        self.record("C:/o/dirt.png", 0.6)
        self.pipe.BLEND_SOURCES[("someone-else", BODY, "Std_Skin_Head")] = {"image": "C:/o/x.png", "strength": 1.0}
        self.pipe.mark_blend_sources_stale()
        self.pipe.mark_blend_sources_stale()  # an undo after an undo: no harm
        self.assertEqual(self.pipe.BLEND_SOURCES, {
            (AVATAR_ID, BODY, "Std_Skin_Arm"): {"image": "C:/o/dirt.png", "strength": 0.6, "stale": True},
            ("someone-else", BODY, "Std_Skin_Head"): {"image": "C:/o/x.png", "strength": 1.0, "stale": True}})

    def test_a_stale_record_never_overrides_cc5s_read_and_its_image_is_not_named(self):
        self.stale(self.source_image("dirt.png"), 1.0, 0.8)
        state = self.skin.skin_export_state(self.avatar)
        self.assertEqual(state["overlays"], [{"mesh": BODY, "material": "Std_Skin_Arm", "strength": 0.8, "image": None,
                                               "skin": True, "stale": True}])
        self.assertEqual(state["notes"], ["Std_Skin_Arm: an undo or redo ran since the bridge set this overlay, so "
                                          "CC5's read is used for its strength and its image is not known"])
        report = self.skin.injury_report(state, None)
        self.assertEqual(report["not_carried"], ["an overlay image on Std_Skin_Arm (Diffuse Blend overlay at 80%)"])

    def test_a_stale_record_at_0_never_drops_an_overlay_cc5_may_show(self):
        # load_texture(..., strength=0) hid the shirt's blood, then an undo brought it back: CC5 reads 100% once it
        # renders, or still 0 until then. Either way the export asks.
        cases = ((1.0, "an overlay image on M_Shirt (Diffuse Blend overlay at 100%)"),
                 (0.0, "an overlay image on M_Shirt (Diffuse Blend overlay; CC5 reads its strength as 0, which can be "
                       "stale until CC5 renders, so it may be showing)"))
        for read, line in cases:
            with self.subTest(read=read):
                self.pipe.BLEND_SOURCES.clear()
                self.stale(self.source_image("blood.png"), 0.0, read, mat="M_Shirt", mesh="Shirt")
                r = self.export()
                self.assertTrue(r["needs_choice"])
                self.assertEqual(r["injuries"]["not_carried"], [line])
        self.export_fbx.assert_not_called()

    def test_separate_does_not_ship_a_stale_records_image_and_says_why(self):
        # The strengths agree, so before P-1 nothing showed that dirt.png was not the image CC5 shows after the undo.
        self.stale(self.source_image("dirt.png", b"\x89PNG dirt"), 1.0, 1.0)
        r = self.export("separate")
        self.assertTrue(r["success"])
        self.assertEqual((r["injuries"]["failed"], r["injuries"]["done"]), ([self.NOT_KNOWN], []))
        self.assertIn(WARNING + self.NOT_KNOWN, r["notes"])
        self.mc.GetImage.assert_not_called()  # CC5's own image is not verified live either
        self.assertFalse(os.path.exists(os.path.join(self.folder, "Injuries")))
        self.assertFalse(os.path.exists(os.path.join(self.folder, "P1_injuries.json")))

    def test_bake_does_not_bake_a_stale_records_image_and_says_why(self):
        self.stale(self.source_image("dirt.png"), 1.0, 1.0)
        self.pale(["Std_Skin_Arm"])  # nor that material's pallor alone: anything unsure leaves the file
        with mock.patch.object(self.skin, "_paint_bake") as paint:
            r = self.export("bake")
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["failed"], [self.NOT_KNOWN])
        self.assertIn(WARNING + self.NOT_KNOWN, r["notes"])
        paint.assert_not_called()
        self.mc.GetImage.assert_not_called()

    def test_omit_only_names_a_stale_overlay(self):
        self.stale(self.source_image("dirt.png"), 1.0, 1.0)
        r = self.export("omit")
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["not_carried"],
                         ["an overlay image on Std_Skin_Arm (Diffuse Blend overlay at 100%)"])
        self.assertEqual(r["injuries"]["failed"], [])
        self.assertEqual(r["notes"], ["target_tool=Unity preset applied"])

    def test_a_record_written_again_after_the_undo_is_trusted_again(self):
        self.stale(self.source_image("dirt.png"), 1.0, 1.0)
        self.record(self.source_image(), 1.0)  # apply_skin_overlay or load_texture again: a fresh record
        r = self.export("separate")
        self.assertEqual(r["injuries"]["failed"], [])
        self.assertIn("Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, 100%)", r["injuries"]["done"])
        with open(os.path.join(self.folder, "Injuries", "Std_Skin_Arm_DiffuseBlend.png"), "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG the bruise")


class TintTest(InjuryTestCase):
    def setUp(self):
        super().setUp()
        for mat in SKIN:  # cyanotic: (0.80, 0.86, 0.98)
            self.colors[(BODY, mat)] = (204, 219, 250)

    def test_a_tint_alone_exports_and_is_reported_as_not_verified(self):
        with mock.patch.object(self.skin, "_paint_bake") as paint:
            r = self.export()
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["unverified"], [
            "skin colour (0.80, 0.86, 0.98) on Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg: CC5 writes it "
            "as the FBX material colour, not yet checked in Unity"])
        self.assertEqual((r["injuries"]["not_carried"], r["injuries"]["done"]), ([], []))
        paint.assert_not_called()

    def test_a_tint_known_not_to_reach_unity_needs_a_choice_and_bake_bakes_it(self):
        with mock.patch.object(self.skin, "TINT_REACHES_UNITY", False):
            r = self.export()
            self.assertTrue(r["needs_choice"])
            self.assertEqual(r["injuries"]["not_carried"], [
                "skin colour (0.80, 0.86, 0.98) on Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg"])
            with mock.patch.object(self.skin, "_paint_bake", return_value=None) as paint:
                r = self.export("bake")
        self.assertTrue(r["success"])
        self.assertEqual(paint.call_count, 4)
        for call in paint.call_args_list:
            self.assertIsNone(call.args[1])
            self.assertEqual(call.args[2], [("tint", (0.8, 0.86, 0.98))])
        self.assertIn("P1.fbm/Std_Skin_Arm_Diffuse.jpg: tint (0.80, 0.86, 0.98)", r["injuries"]["done"])
        self.assertEqual(r["injuries"]["failed"], [])


class TintRecordTest(InjuryTestCase):
    """Review #0 (F-90, live): CC5 reports a skin colour only after it renders, so right after set_skin_condition its read
    still gave the colour from before. The export's tint read takes a colour the bridge set since then from the bridge's
    record (cc5_api._writes_since_render), as the F-34 comparison does."""

    UNVERIFIED = ("skin colour (0.80, 0.86, 0.98) on Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg: CC5 "
                  "writes it as the FBX material colour, not yet checked in Unity")

    def sidecar(self):
        with open(os.path.join(self.folder, "P1_injuries.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_a_tint_just_set_is_listed_and_written_to_the_sidecar(self):
        # CC5 still reports white (self.colors is empty): no render since set_skin_condition, as in a batch variant
        # whose last step before the export is skin_condition.
        self.assertTrue(self.skin.set_skin_condition("cyanotic")["success"])
        r = self.export("separate")
        self.assertTrue(r["success"], r)
        self.assertEqual(r["injuries"]["unverified"], [self.UNVERIFIED])
        self.assertEqual(self.sidecar()["tints"],
                         [{"mesh": BODY, "material": mat, "rgb": [0.8, 0.86, 0.98]} for mat in SKIN])
        self.mc.GetDiffuseColor.assert_not_called()  # the record stands in for CC5's read

    def test_a_tint_just_cleared_is_not_listed(self):
        for mat in SKIN:  # cyanotic when CC5 last rendered, so that is what it still reads
            self.colors[(BODY, mat)] = (204, 219, 250)
        self.assertTrue(self.skin.set_skin_condition("normal")["success"])
        r = self.export("separate")
        self.assertTrue(r["success"], r)
        self.assertEqual(r["injuries"]["unverified"], [])
        self.assertFalse(os.path.exists(os.path.join(self.folder, "P1_injuries.json")))

    def test_a_record_of_another_material_or_character_leaves_cc5s_read(self):
        for mat in SKIN:
            self.colors[(BODY, mat)] = (204, 219, 250)
        api = self.pipe.cc5_api
        api._writes_since_render[("someone-else", BODY, "Std_Skin_Head")] = {"diffuse": [255, 255, 255]}
        api._writes_since_render[(AVATAR_ID, BODY, "Std_Nails")] = {"diffuse": [255, 255, 255]}
        api._writes_since_render[(AVATAR_ID, BODY, "Std_Skin_Arm")] = {"opacity": 0.5}  # no colour recorded
        state = self.skin.skin_export_state(self.avatar)
        self.assertEqual([t["material"] for t in state["tints"]], SKIN)


class TintLateReadTest(InjuryTestCase):
    """Batch F review #3: CC5's colour reads of a character in cc5_api._colours_late_since_undo may still give its last
    render: after an undo or redo with it in the scene (review #20), or after a load whose comparison found CC5 still
    reporting a colour the bridge had set as before (cc5_changes). The bridge has no record of its own there, so the
    tint list and the sidecar come from CC5's read, and a WARNING in the injuries notes (export_for_unity's reply shows
    them) says the read may be late, once. A colour from the bridge's record needs none."""

    LATE = ("WARNING: Kevin's skin colours were read with no capture since an undo or redo, or since a load after which "
            "CC5 still reported a colour or opacity from before the bridge set it, so CC5 may report them late: run "
            "capture_viewport, then export again.")

    def marks(self):
        return self.pipe.cc5_api._colours_late_since_undo

    def test_a_tint_cc5_may_report_late_comes_with_a_warning(self):
        # The finding's first case: cyanotic set and captured, then an undo: CC5 holds white again, but its reads still
        # give cyanotic, which the export lists and writes to the sidecar as this patient's skin colour.
        for mat in SKIN:
            self.colors[(BODY, mat)] = (204, 219, 250)
        self.marks().add(AVATAR_ID)
        r = self.export("separate")
        self.assertTrue(r["success"], r)
        self.assertEqual(r["injuries"]["notes"], [self.LATE])  # once for the character, not once per material
        self.assertEqual(r["injuries"]["unverified"], [TintRecordTest.UNVERIFIED])  # still listed, now with the doubt

    def test_a_white_read_cc5_may_report_late_comes_with_the_warning_too(self):
        # The finding's second case: cyanotic, then an undo and a redo with no capture: CC5 holds cyanotic, its reads
        # still give white, so no tint is listed or written and only the WARNING says the read may be late.
        self.marks().add(AVATAR_ID)
        r = self.export("separate")
        self.assertTrue(r["success"], r)
        self.assertEqual((r["injuries"]["unverified"], r["injuries"]["notes"]), ([], [self.LATE]))
        self.assertFalse(os.path.exists(os.path.join(self.folder, "P1_injuries.json")))

    def test_no_warning_for_a_character_that_is_not_marked(self):
        for mat in SKIN:
            self.colors[(BODY, mat)] = (204, 219, 250)
        for marks in (set(), {"someone-else"}):
            with self.subTest(marks=marks):
                self.marks().clear()
                self.marks().update(marks)
                state = self.skin.skin_export_state(self.avatar)
                self.assertEqual(state["notes"], [])
                self.assertEqual([t["material"] for t in state["tints"]], SKIN)

    def test_colours_from_the_bridges_record_need_no_warning(self):
        # Set again after the undo: the record says what CC5 holds, whatever CC5 still reads.
        self.marks().add(AVATAR_ID)
        self.assertTrue(self.skin.set_skin_condition("cyanotic")["success"])
        state = self.skin.skin_export_state(self.avatar)
        self.assertEqual(state["notes"], [])
        self.mc.GetDiffuseColor.assert_not_called()
        # One skin material read from CC5 is enough for the WARNING.
        del self.pipe.cc5_api._writes_since_render[(AVATAR_ID, BODY, "Std_Skin_Leg")]
        self.assertEqual(self.skin.skin_export_state(self.avatar)["notes"], [self.LATE])

    def test_an_undo_marks_the_character_for_the_export_until_a_capture_clears_the_mark(self):
        # Through cc5_api: undo() marks the characters in the scene by id (review #20).
        self.rl.RScene.GetAvatars.return_value = [self.avatar]
        self.assertTrue(self.pipe.cc5_api.undo()["success"])
        self.assertEqual(self.export()["injuries"]["notes"], [self.LATE])
        self.marks().clear()  # what a capture whose RenderImage wrote the file does (cc5_api._clear_colours_late)
        self.assertEqual(self.export()["injuries"]["notes"], [])

    def test_a_colour_cc5_could_not_read_is_named_as_unread_not_as_late(self):
        self.marks().add(AVATAR_ID)
        self.mc.GetDiffuseColor.side_effect = RuntimeError("SWIG")
        state = self.skin.skin_export_state(self.avatar)
        self.assertEqual(state["notes"], [f"{mat}: CC5 could not read its diffuse colour (SWIG)" for mat in SKIN])

    def test_a_character_whose_name_cannot_be_read_is_the_character(self):
        self.marks().add(AVATAR_ID)
        self.avatar.GetName.side_effect = RuntimeError("SWIG")
        self.assertEqual(self.skin.skin_export_state(self.avatar)["notes"],
                         [self.LATE.replace("WARNING: Kevin's", "WARNING: the character's")])


class OmitTest(InjuryTestCase):
    def test_omit_lists_what_was_left_out_and_writes_nothing_else(self):
        self.overlay()
        self.pale()
        r = self.export("omit")
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["choice"], "omit")
        self.assertEqual(len(r["injuries"]["not_carried"]), 2)
        self.assertEqual(r["injuries"]["done"], [])
        self.assertEqual(r["notes"], ["target_tool=Unity preset applied"])
        self.assertFalse(os.path.exists(os.path.join(self.folder, "P1_injuries.json")))
        self.assertFalse(os.path.exists(os.path.join(self.folder, "Injuries")))
        self.assertFalse(r["remove_tearline_occlusion"])
        self.assertFalse(self.export_fbx.call_args.kwargs["remove_tearline_occlusion"])


class SeparateTest(InjuryTestCase):
    def test_separate_copies_the_loaded_image_and_writes_the_sidecar(self):
        image = self.source_image()
        self.overlay()
        self.record(image, 0.6)
        self.pale()
        r = self.export("separate")
        self.assertTrue(r["success"])
        shipped = os.path.join(self.folder, "Injuries", "Std_Skin_Arm_DiffuseBlend.png")
        with open(shipped, "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG the bruise")
        self.mc.GetImage.assert_not_called()  # the exact file the bridge loaded, no RLPy call
        report = r["injuries"]
        self.assertEqual(report["done"], [
            "Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, 60%)",
            "P1_injuries.json: skin-condition values for Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg"])
        sidecar_path = os.path.join(self.folder, "P1_injuries.json")
        self.assertEqual(report["sidecar"], os.path.abspath(sidecar_path))
        with open(sidecar_path, encoding="utf-8") as f:
            sidecar = json.load(f)
        self.assertEqual((sidecar["format"], sidecar["character"], sidecar["fbx"], sidecar["blend"]),
                         (1, "P1", "P1.fbx", "Multiply"))
        self.assertTrue(sidecar["created"])
        self.assertEqual(sidecar["overlays"], [{"mesh": BODY, "material": "Std_Skin_Arm",
                                                "image": "Injuries/Std_Skin_Arm_DiffuseBlend.png", "strength": 0.6,
                                                "diffuse": "P1.fbm/Std_Skin_Arm_Diffuse.jpg"}])
        self.assertEqual(sidecar["pallor"], [{"mesh": BODY, "material": mat, "brightness": 0.036, "saturation": -0.15}
                                             for mat in SKIN])
        self.assertEqual(sidecar["tints"], [])
        # Written by this export, so its file list has them.
        listed = {os.path.relpath(f["path"], self.folder).replace("\\", "/") for f in r["files"]}
        self.assertTrue({"Injuries/Std_Skin_Arm_DiffuseBlend.png", "P1_injuries.json"} <= listed)

    def test_separate_keeps_the_loaded_image_extension(self):
        self.overlay()
        self.record(self.source_image("bruise.tga", b"TGA"), 0.6)
        r = self.export("separate")
        self.assertIn("Injuries/Std_Skin_Arm_DiffuseBlend.tga (Std_Skin_Arm, 60%)", r["injuries"]["done"])

    def test_separate_saves_cc5s_image_when_the_bridge_did_not_load_it(self):
        self.overlay()
        self.mc.GetImage.return_value.SaveFile.side_effect = _write
        r = self.export("separate")
        self.assertTrue(os.path.isfile(os.path.join(self.folder, "Injuries", "Std_Skin_Arm_DiffuseBlend.png")))
        self.mc.GetImage.assert_called_once_with(BODY, "Std_Skin_Arm", DIFFUSE_BLEND)
        self.assertIn("Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, 60%)", r["injuries"]["done"])

    def test_separate_uses_a_qimage_save_when_cc5_gives_one(self):
        self.overlay()
        self.mc.GetImage.return_value = types.SimpleNamespace(save=_write)
        r = self.export("separate")
        self.assertEqual(r["injuries"]["failed"], [])
        self.assertTrue(os.path.isfile(os.path.join(self.folder, "Injuries", "Std_Skin_Arm_DiffuseBlend.png")))

    def test_two_materials_with_one_name_get_numbered_files(self):
        self.materials = {"Shirt": ["M_Shirt"], "Jacket": ["M_Shirt"]}
        self.overlay("M_Shirt", 0.4, mesh="Shirt")
        self.overlay("M_Shirt", 0.4, mesh="Jacket")
        self.mc.GetImage.return_value.SaveFile.side_effect = _write
        r = self.export("separate")
        self.assertEqual(r["injuries"]["done"], ["Injuries/M_Shirt_DiffuseBlend.png (M_Shirt, 40%)",
                                                 "Injuries/M_Shirt_DiffuseBlend_0001.png (M_Shirt, 40%)"])
        with open(os.path.join(self.folder, "P1_injuries.json"), encoding="utf-8") as f:
            overlays = json.load(f)["overlays"]
        self.assertEqual([(o["mesh"], o["image"]) for o in overlays],
                         [("Shirt", "Injuries/M_Shirt_DiffuseBlend.png"), ("Jacket", "Injuries/M_Shirt_DiffuseBlend_0001.png")])

    def test_an_overlay_that_cannot_be_read_fails_with_a_warning_and_keeps_the_export(self):
        self.overlay()
        self.mc.GetImage.side_effect = RuntimeError("no image")
        r = self.export("separate")
        self.assertTrue(r["success"])
        self.assertTrue(os.path.isfile(r["fbx"]))
        failed = "Std_Skin_Arm: the overlay image could not be read from CC5 and was not loaded by this bridge"
        self.assertEqual(r["injuries"]["failed"], [failed])
        self.assertIn(WARNING + failed, r["notes"])
        self.assertFalse(os.path.exists(os.path.join(self.folder, "Injuries")))
        self.assertFalse(os.path.exists(os.path.join(self.folder, "P1_injuries.json")))


class BakeTest(InjuryTestCase):
    def test_bake_paints_this_exports_diffuse_with_the_pallor_and_the_overlay(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        self.pale()
        blends = []
        with mock.patch.object(self.skin, "_paint_bake", side_effect=lambda p, b, o: blends.append(b)) as paint:
            r = self.export("bake")
        self.assertTrue(r["success"])
        self.assertEqual(paint.call_count, 4)
        calls = {os.path.basename(c.args[0]): c.args for c in paint.call_args_list}
        arm = calls["Std_Skin_Arm_Diffuse.jpg"]
        self.assertEqual(arm[0], os.path.join(self.folder, "P1.fbm", "Std_Skin_Arm_Diffuse.jpg"))
        self.assertTrue(arm[1].endswith(".png"))
        self.assertEqual(arm[2], [("desaturate", 0.15), ("brighten", 0.036), ("overlay", "Multiply", 0.6)])
        self.assertEqual(calls["Std_Skin_Head_Diffuse.jpg"][1:], (None, [("desaturate", 0.15), ("brighten", 0.036)]))
        self.assertFalse(os.path.exists(arm[1]))  # the temp overlay copy is gone
        self.assertIn("P1.fbm/Std_Skin_Arm_Diffuse.jpg: overlay 60%, pale", r["injuries"]["done"])
        self.assertIn("P1.fbm/Std_Skin_Head_Diffuse.jpg: pale", r["injuries"]["done"])
        self.assertEqual(r["injuries"]["failed"], [])
        self.assertEqual(r["notes"], ["target_tool=Unity preset applied"])

    def _bake_fails(self, failed):
        with mock.patch.object(self.skin, "_paint_bake") as paint:
            r = self.export("bake")
        self.assertTrue(r["success"])
        self.assertEqual(r["injuries"]["failed"], [failed])
        self.assertIn(WARNING + failed, r["notes"])
        paint.assert_not_called()
        return r

    def test_bake_fails_closed_when_this_export_wrote_no_diffuse(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        self.diffuse_files = []
        self._bake_fails("Std_Skin_Arm: this export wrote no Std_Skin_Arm_Diffuse image, so nothing was baked into it")

    def test_bake_never_paints_an_older_file(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        self.diffuse_files = []
        old = os.path.join(self.folder, "P1.fbm", "Std_Skin_Arm_Diffuse.jpg")
        os.makedirs(os.path.dirname(old))
        _write(old, b"from an earlier export")
        os.utime(old, (1_000_000_000, 1_000_000_000))
        self._bake_fails("Std_Skin_Arm: this export wrote no Std_Skin_Arm_Diffuse image, so nothing was baked into it")
        with open(old, "rb") as f:
            self.assertEqual(f.read(), b"from an earlier export")

    def test_bake_fails_closed_when_the_diffuse_is_ambiguous(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        self.diffuse_files = ["Std_Skin_Arm_Diffuse.jpg", "Std_Skin_Arm_Diffuse_0001.jpg"]
        self._bake_fails("Std_Skin_Arm: this export wrote 2 diffuse images for materials named Std_Skin_Arm "
                         "(Std_Skin_Arm_Diffuse.jpg, Std_Skin_Arm_Diffuse_0001.jpg), and which one is this mesh's is "
                         "unknown, so nothing was baked")

    def test_bake_fails_closed_on_what_it_cannot_bake_or_read(self):
        self.pale(["Std_Skin_Arm"], {"_BaseColorMap Brightness": -0.05, "_BaseColorMap Saturation": 0.0})
        self._bake_fails("Std_Skin_Arm: Brightness below 0 cannot be baked")

    def test_bake_fails_closed_when_the_overlay_image_cannot_be_read(self):
        self.overlay()
        self.mc.GetImage.side_effect = RuntimeError("no image")
        self._bake_fails("Std_Skin_Arm: the overlay image could not be read from CC5 and was not loaded by this bridge")

    def test_bake_leaves_a_diffuse_with_an_alpha_channel_and_warns(self):
        # P-7: a cutout diffuse (lace, hair) would get its transparent pixels filled.
        modules, qt, _image = _fake_qt()
        self.diffuse_files = ["Std_Skin_Arm_Diffuse.png"]
        diffuse = os.path.join(self.folder, "P1.fbm", "Std_Skin_Arm_Diffuse.png")
        qt.files[diffuse] = ((150, 109, 91, 255), (64, 32))
        qt.alpha.add(diffuse)
        self.pale(["Std_Skin_Arm"])
        with mock.patch.dict(sys.modules, modules):
            r = self.export("bake")
        self.assertTrue(r["success"])
        failed = ("Std_Skin_Arm_Diffuse.png has an alpha channel (transparency), which a bake would change: use "
                  "separate for this character")
        self.assertEqual(r["injuries"]["failed"], [failed])
        self.assertIn(WARNING + failed, r["notes"])
        self.assertEqual(r["injuries"]["done"], [])
        self.assertNotIn("save", [entry[0] for entry in qt.log])
        with open(diffuse, "rb") as f:
            self.assertEqual(f.read(), b"jpg Std_Skin_Arm_Diffuse.png")

    def test_a_failed_paint_is_reported(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        reason = ("Std_Skin_Arm_Diffuse.jpg: the painted result differs from the bake formula by 9/255, so the file was "
                  "left as CC5 wrote it")
        with mock.patch.object(self.skin, "_paint_bake", return_value=reason):
            r = self.export("bake")
        self.assertEqual(r["injuries"]["failed"], [reason])
        with mock.patch.object(self.skin, "_paint_bake", side_effect=RuntimeError("Qt boom")):
            r = self.export("bake")
        self.assertEqual(r["injuries"]["failed"],
                         ["Std_Skin_Arm: the bake failed (Qt boom), so the file was left as CC5 wrote it"])


class CarryFailureTest(InjuryTestCase):
    def test_a_failed_injuries_step_keeps_the_export_and_warns(self):
        self.overlay()
        with mock.patch.object(self.skin, "carry_injuries", side_effect=RuntimeError("boom")):
            r = self.export("omit")
        self.assertTrue(r["success"])
        self.assertTrue(os.path.isfile(r["fbx"]))
        self.assertEqual(r["injuries"]["failed"], ["injuries step failed: boom"])
        self.assertEqual(r["injuries"]["choice"], "omit")
        self.assertIn(WARNING + "injuries step failed: boom", r["notes"])


class EarlierExportTest(InjuryTestCase):
    def test_a_later_export_removes_the_earlier_injuries_files_and_nothing_outside_injuries(self):
        injuries = os.path.join(self.folder, "Injuries")
        os.makedirs(injuries)
        os.makedirs(os.path.join(self.folder, "P1.fbm"))
        image = os.path.join(injuries, "Std_Skin_Arm_DiffuseBlend.png")
        keep = os.path.join(self.folder, "P1.fbm", "keep.jpg")
        precious = os.path.join(self.root, "precious.png")
        for path in (image, image + ".meta", injuries + ".meta", keep, precious):
            _write(path)
        sidecar = os.path.join(self.folder, "P1_injuries.json")
        with open(sidecar, "w", encoding="utf-8") as f:
            json.dump({"format": 1, "overlays": [
                {"image": "Injuries/Std_Skin_Arm_DiffuseBlend.png"}, {"image": "Injuries/../P1.fbm/keep.jpg"},
                {"image": "P1.fbm/keep.jpg"}, {"image": precious}, {"image": 42}, "not an overlay"]}, f)
        _write(sidecar + ".meta")
        r = self.export("omit")
        self.assertTrue(r["success"])
        for gone in (image, image + ".meta", sidecar, sidecar + ".meta", injuries, injuries + ".meta"):
            self.assertFalse(os.path.exists(gone), gone)
        for kept in (keep, precious):
            self.assertTrue(os.path.isfile(kept), kept)
        self.assertIn("Removed the injuries files of an earlier export: Injuries/Std_Skin_Arm_DiffuseBlend.png, "
                      "P1_injuries.json", r["injuries"]["notes"])

    def test_an_unreadable_earlier_sidecar_is_removed_and_its_folder_left_alone(self):
        os.makedirs(os.path.join(self.folder, "Injuries"))
        image = os.path.join(self.folder, "Injuries", "x.png")
        _write(image)
        sidecar = os.path.join(self.folder, "P1_injuries.json")
        _write(sidecar, b"not json")
        r = self.export("omit")
        self.assertFalse(os.path.exists(sidecar))
        self.assertTrue(os.path.isfile(image))
        self.assertIn("Removed the injuries files of an earlier export: P1_injuries.json", r["injuries"]["notes"])

    def _separate_with_metas(self):
        """A 'separate' export, then the .meta files Unity writes when it imports its files: {path: .meta content}."""
        self.assertEqual(self.export("separate")["injuries"]["failed"], [])
        injuries = os.path.join(self.folder, "Injuries")
        written = [os.path.join(injuries, name) for name in sorted(os.listdir(injuries))]
        metas = {}
        for path in written + [os.path.join(self.folder, "P1_injuries.json"), injuries]:
            metas[path + ".meta"] = b"guid: " + os.path.basename(path).encode()
            _write(path + ".meta", metas[path + ".meta"])
        return metas

    def test_a_second_separate_export_keeps_the_meta_of_each_file_it_writes_again(self):
        # P-6: Unity keeps an asset's GUID in its .meta, so deleting the .meta of a file this export writes again at
        # once breaks every Unity material that uses it. Only the files it does not write again go, with their .meta.
        self.overlay()
        self.record(self.source_image(), 0.6)
        self.overlay("M_Shirt", 0.4, mesh="Shirt")
        self.record(self.source_image("blood.png", b"\x89PNG blood"), 0.4, mat="M_Shirt", mesh="Shirt")
        metas = self._separate_with_metas()
        injuries = os.path.join(self.folder, "Injuries")
        arm = os.path.join(injuries, "Std_Skin_Arm_DiffuseBlend.png")
        shirt = os.path.join(injuries, "M_Shirt_DiffuseBlend.png")
        sidecar = os.path.join(self.folder, "P1_injuries.json")
        self.assertEqual(sorted(metas), sorted(p + ".meta" for p in (arm, shirt, sidecar, injuries)))
        self.images.discard(("Shirt", "M_Shirt"))  # the shirt's overlay is removed before the second export
        del self.pipe.BLEND_SOURCES[(AVATAR_ID, "Shirt", "M_Shirt")]
        r = self.export("separate")
        self.assertEqual(r["injuries"]["failed"], [])
        self.assertEqual(r["injuries"]["done"], ["Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, 60%)"])
        for meta in (arm + ".meta", sidecar + ".meta", injuries + ".meta"):
            with open(meta, "rb") as f:
                self.assertEqual(f.read(), metas[meta], meta)
        with open(arm, "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG the bruise")
        with open(sidecar, encoding="utf-8") as f:
            self.assertEqual([o["image"] for o in json.load(f)["overlays"]], ["Injuries/Std_Skin_Arm_DiffuseBlend.png"])
        for gone in (shirt, shirt + ".meta"):
            self.assertFalse(os.path.exists(gone), gone)
        self.assertIn("Removed the injuries files of an earlier export: Injuries/M_Shirt_DiffuseBlend.png",
                      r["injuries"]["notes"])

    def test_a_separate_export_with_nothing_to_write_removes_the_earlier_files_with_their_meta(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        metas = self._separate_with_metas()
        self.images.clear()
        self.pipe.BLEND_SOURCES.clear()
        r = self.export("separate")
        self.assertTrue(r["success"])
        for meta in metas:
            self.assertFalse(os.path.exists(meta), meta)
            self.assertFalse(os.path.exists(meta[:-len(".meta")]), meta)
        self.assertIn("Removed the injuries files of an earlier export: Injuries/Std_Skin_Arm_DiffuseBlend.png, "
                      "P1_injuries.json", r["injuries"]["notes"])

    def test_omit_and_bake_still_remove_every_earlier_injuries_file_with_its_meta(self):
        self.overlay()
        self.record(self.source_image(), 0.6)
        for choice in ("omit", "bake"):
            with self.subTest(choice=choice):
                metas = self._separate_with_metas()
                with mock.patch.object(self.skin, "_paint_bake", return_value=None):
                    r = self.export(choice)
                self.assertTrue(r["success"])
                for meta in metas:
                    self.assertFalse(os.path.exists(meta), meta)
                    self.assertFalse(os.path.exists(meta[:-len(".meta")]), meta)

    def test_a_sidecar_that_cannot_be_written_takes_the_earlier_one_with_it(self):
        # P-6: the earlier sidecar now stays until this export has written its own, so a write that fails must not
        # leave it behind to pass for this export's: it goes, with its .meta. The overlay image written again stays.
        self.overlay()
        self.record(self.source_image(), 0.6)
        metas = self._separate_with_metas()
        arm = os.path.join(self.folder, "Injuries", "Std_Skin_Arm_DiffuseBlend.png")
        sidecar = os.path.join(self.folder, "P1_injuries.json")
        with mock.patch.object(self.skin.json, "dumps", side_effect=TypeError("not serializable")):
            r = self.export("separate")
        self.assertTrue(r["success"])
        failed = "P1_injuries.json could not be written (not serializable)"
        self.assertEqual(r["injuries"]["failed"], [failed])
        self.assertIn(WARNING + failed, r["notes"])
        self.assertEqual(r["injuries"]["done"], ["Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, 60%)"])
        self.assertNotIn("sidecar", r["injuries"])
        for gone in (sidecar, sidecar + ".meta"):
            self.assertFalse(os.path.exists(gone), gone)
        with open(arm + ".meta", "rb") as f:
            self.assertEqual(f.read(), metas[arm + ".meta"])
        with open(arm, "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG the bruise")


class RefreshTest(InjuryTestCase):
    def test_no_refresh_while_refresh_method_is_off(self):
        self.overlay()
        self.export("omit")
        self.rl.RGlobal.SetTime.assert_not_called()

    def test_set_time_refreshes_once_before_the_reads(self):
        self.overlay()
        order = []
        self.rl.RGlobal.GetTime.return_value = "frame 12"
        self.rl.RGlobal.SetTime.side_effect = lambda t: order.append(("SetTime", t))
        weights = self.mc.GetTextureWeights.side_effect

        def read(mesh, mat):
            order.append(("GetTextureWeights", mat))
            return weights(mesh, mat)
        self.mc.GetTextureWeights.side_effect = read
        with mock.patch.object(self.pipe, "REFRESH_METHOD", "set_time"):
            self.export("omit")
        self.rl.RGlobal.SetTime.assert_called_once_with("frame 12")
        self.assertEqual(order[0], ("SetTime", "frame 12"))
        self.assertIn(("GetTextureWeights", "Std_Skin_Arm"), order[1:])


class ActionsTest(InjuryTestCase):
    def test_the_job_action_forwards_injuries_and_remove_tearline_occlusion(self):
        with mock.patch.object(self.pipe, "export_for_unity", return_value={"success": True}) as exp:
            self.pipe.ACTIONS["export_for_unity"]({"unity_dir": "D:/U/Assets", "character_name": "P1",
                                                   "injuries": "bake", "remove_tearline_occlusion": True})
            exp.assert_called_once_with("D:/U/Assets", "P1", None, None, False, "bake", True)
            exp.reset_mock()
            self.pipe.ACTIONS["export_for_unity"]({"unity_dir": "D:/U/Assets", "character_name": "P1"})
            exp.assert_called_once_with("D:/U/Assets", "P1", None, None, False, None, False)


def _fake_qt():
    """A PySide2 stand-in: QImage of one colour everywhere (built from a path, it reads that colour from state.files,
    else it is null; it has an alpha channel when the path is in state.alpha), and a QPainter that logs its calls.
    Returns (sys.modules entries, state, the QImage class)."""
    state = types.SimpleNamespace(files={}, alpha=set(), log=[], save_result=True)

    class Color:
        def __init__(self, *rgba):
            self.rgba = rgba

        @staticmethod
        def fromRgbF(r, g, b):
            return Color(r, g, b)

        def red(self):
            return self.rgba[0]

        def green(self):
            return self.rgba[1]

        def blue(self):
            return self.rgba[2]

        def alpha(self):
            return self.rgba[3] if len(self.rgba) > 3 else 255

    class Image:
        Format_ARGB32_Premultiplied = "ARGB32_Premultiplied"
        Format_Grayscale8 = "Grayscale8"

        def __init__(self, source=None, rgba=(0, 0, 0, 255), size=(64, 32), name="image"):
            self.name, self.rgba, self.size, self.null, self.alpha_channel = name, rgba, size, False, False
            if isinstance(source, str):
                self.name = os.path.basename(source)
                entry = state.files.get(source)
                self.null = entry is None
                self.rgba, self.size = entry if entry else (rgba, (0, 0))
                self.alpha_channel = source in state.alpha

        def isNull(self):
            return self.null

        def hasAlphaChannel(self):
            return self.alpha_channel

        def width(self):
            return self.size[0]

        def height(self):
            return self.size[1]

        def rect(self):
            return ("rect",) + tuple(self.size)

        def pixelColor(self, x, y):
            return Color(*self.rgba)

        def convertToFormat(self, fmt):
            state.log.append(("convert", self.name, fmt))
            return Image(rgba=self.rgba, size=self.size, name=f"{self.name}>{fmt}")

        def scaled(self, w, h, aspect, mode):
            state.log.append(("scaled", self.name, w, h, aspect, mode))
            return Image(rgba=self.rgba, size=(w, h), name=f"{self.name}>scaled")

        def save(self, path, fmt, quality):
            state.log.append(("save", self.name, path, fmt, quality))
            return state.save_result

    class Painter:
        CompositionMode_SourceOver = "SourceOver"
        CompositionMode_Plus = "Plus"
        CompositionMode_Multiply = "Multiply"
        CompositionMode_Screen = "Screen"
        CompositionMode_Overlay = "Overlay"

        def __init__(self, device):
            state.log.append(("paint", device.name))

        def setCompositionMode(self, mode):
            state.log.append(("mode", mode))

        def setOpacity(self, value):
            state.log.append(("opacity", value))

        def drawImage(self, x, y, image):
            state.log.append(("draw", x, y, image.name))

        def fillRect(self, rect, color):
            state.log.append(("fill", rect, color.rgba))

        def end(self):
            state.log.append(("end",))

    gui = types.ModuleType("PySide2.QtGui")
    gui.QImage, gui.QPainter, gui.QColor = Image, Painter, Color
    core = types.ModuleType("PySide2.QtCore")
    core.Qt = types.SimpleNamespace(IgnoreAspectRatio="IgnoreAspectRatio", SmoothTransformation="SmoothTransformation")
    pkg = types.ModuleType("PySide2")
    pkg.QtGui, pkg.QtCore = gui, core
    return {"PySide2": pkg, "PySide2.QtGui": gui, "PySide2.QtCore": core}, state, Image


class BakeFormulaTest(unittest.TestCase):
    def setUp(self):
        _support.install_fake_rlpy()
        self.skin = _support.fresh_import("cc5_skin")
        self.dir = tempfile.mkdtemp()

    def test_baked_pixel_multiplies_the_overlay_in_at_its_strength(self):
        self.assertEqual(self.skin.baked_pixel((150, 109, 91), (128, 48, 48, 255), [("overlay", "Multiply", 0.6)]),
                         (105, 56, 47))
        self.assertEqual(self.skin.baked_pixel((150, 109, 91), (128, 48, 48, 0), [("overlay", "Multiply", 0.6)]),
                         (150, 109, 91))
        self.assertEqual(self.skin.baked_pixel((150, 109, 91), None, [("overlay", "Multiply", 0.6)]), (150, 109, 91))
        self.assertEqual(self.skin.baked_pixel((150, 109, 91), (128, 48, 48), [("overlay", "Multiply", 1.0)]),
                         (75, 21, 17))  # 150*128/255 = 75.3, 109*48/255 = 20.5, 91*48/255 = 17.1

    def test_baked_pixel_pale(self):
        # qGray(200, 160, 120) = (200*11 + 160*16 + 120*5) // 32 = 5360 // 32 = 167. Desaturate 0.15: 200*0.85 +
        # 167*0.15 = 195.05 -> 195, 160*0.85 + 25.05 = 161.05 -> 161, 120*0.85 + 25.05 = 127.05 -> 127. Brighten
        # 0.036 adds 255*0.036 = 9.18: 204.18 -> 204, 170.18 -> 170, 136.18 -> 136.
        self.assertEqual(self.skin.baked_pixel((200, 160, 120), None, [("desaturate", 0.15), ("brighten", 0.036)]),
                         (204, 170, 136))

    def test_baked_pixel_tint_screen_and_overlay(self):
        # 200*0.8 = 160, 160*0.86 = 137.6 -> 138, 120*0.98 = 117.6 -> 118
        self.assertEqual(self.skin.baked_pixel((200, 160, 120), None, [("tint", (0.8, 0.86, 0.98))]), (160, 138, 118))
        # Screen: 100 + 100 - 100*100/255 = 160.8 -> 161
        self.assertEqual(self.skin.baked_pixel((100, 100, 100), (100, 100, 100, 255), [("overlay", "Screen", 1.0)]),
                         (161, 161, 161))
        # Overlay: 2*100*100/255 = 78.4 -> 78 (dark); 255 - 2*55*155/255 = 188.1 -> 188 (light)
        self.assertEqual(self.skin.baked_pixel((100, 200, 100), (100, 100, 100, 255), [("overlay", "Overlay", 1.0)]),
                         (78, 188, 78))
        self.assertEqual(self.skin.baked_pixel((255, 255, 255), None, [("brighten", 0.5)]), (255, 255, 255))
        with self.assertRaises(ValueError):
            self.skin.baked_pixel((1, 2, 3), (1, 2, 3, 255), [("overlay", "Dissolve", 1.0)])
        with self.assertRaises(ValueError):
            self.skin.baked_pixel((1, 2, 3), None, [("sharpen", 1.0)])

    def test_bake_plan_order_and_problems(self):
        self.assertEqual(self.skin.bake_plan(0.6, 0.036, -0.15, None),
                         ([("desaturate", 0.15), ("brighten", 0.036), ("overlay", "Multiply", 0.6)], []))
        self.assertEqual(self.skin.bake_plan(1.0, 0.06, -0.25, (1.0, 0.82, 0.8)),
                         ([("desaturate", 0.25), ("brighten", 0.06), ("tint", (1.0, 0.82, 0.8)),
                           ("overlay", "Multiply", 1.0)], []))
        self.assertEqual(self.skin.bake_plan(None, -0.05, 0.1, None),
                         ([], ["Brightness below 0 cannot be baked", "Saturation above 0 cannot be baked"]))
        self.assertEqual(self.skin.bake_plan(None, 0.0, 0.0, None), ([], []))
        with mock.patch.object(self.skin, "OVERLAY_BAKE_GAIN", 2.0):
            self.assertEqual(self.skin.bake_plan(0.6, 0.0, 0.0, None)[0], [("overlay", "Multiply", 1.0)])

    def test_max_bake_error_flags_a_painted_image_that_differs(self):
        _modules, _state, Image = _fake_qt()
        original = Image(rgba=(150, 109, 91, 255))
        blend = Image(rgba=(128, 48, 48, 255))
        ops = [("overlay", "Multiply", 0.6)]
        self.assertEqual(self.skin._max_bake_error(original, Image(rgba=(105, 56, 47, 255)), blend, ops), 0)
        self.assertEqual(self.skin._max_bake_error(original, Image(rgba=(105, 61, 47, 255)), blend, ops), 5)
        self.assertEqual(self.skin._max_bake_error(original, original, None, []), 0)

    def test_paint_draws_each_step_with_its_own_painter(self):
        modules, state, Image = _fake_qt()
        diffuse = Image(rgba=(150, 109, 91, 255), size=(64, 32), name="diffuse")
        blend = Image(rgba=(128, 48, 48, 255), size=(16, 16), name="blend")
        with mock.patch.dict(sys.modules, modules):
            painted = self.skin._paint(diffuse, blend, [("desaturate", 0.15), ("brighten", 0.036),
                                                        ("tint", (0.8, 0.86, 0.98)), ("overlay", "Multiply", 0.6)])
        work = "diffuse>ARGB32_Premultiplied"
        self.assertEqual(painted.name, work)
        rect = ("rect", 64, 32)
        self.assertEqual(state.log, [
            ("convert", "diffuse", "ARGB32_Premultiplied"),
            ("convert", work, "Grayscale8"),
            ("paint", work), ("opacity", 0.15), ("draw", 0, 0, f"{work}>Grayscale8"), ("end",),
            ("paint", work), ("mode", "Plus"), ("opacity", 0.036), ("fill", rect, (255, 255, 255)), ("end",),
            ("paint", work), ("mode", "Multiply"), ("fill", rect, (0.8, 0.86, 0.98)), ("end",),
            ("scaled", "blend", 64, 32, "IgnoreAspectRatio", "SmoothTransformation"),
            ("paint", work), ("mode", "Multiply"), ("opacity", 0.6), ("draw", 0, 0, "blend>scaled"), ("end",),
        ])

    def test_paint_draws_a_same_size_overlay_unscaled_and_refuses_an_unknown_step(self):
        modules, state, Image = _fake_qt()
        diffuse = Image(size=(64, 32), name="diffuse")
        with mock.patch.dict(sys.modules, modules):
            self.skin._paint(diffuse, Image(size=(64, 32), name="blend"), [("overlay", "Screen", 0.5)])
            self.assertNotIn("scaled", [entry[0] for entry in state.log])
            self.assertIn(("draw", 0, 0, "blend"), state.log)
            self.assertIn(("mode", "Screen"), state.log)
            with self.assertRaises(ValueError):
                self.skin._paint(diffuse, None, [("sharpen", 1.0)])

    def _paint_bake(self, painted_rgba, diffuse_name="Std_Skin_Arm_Diffuse.jpg", diffuse_known=True, blend_known=True,
                    save_result=True, alpha=False):
        modules, state, Image = _fake_qt()
        state.save_result = save_result
        diffuse = os.path.join(self.dir, diffuse_name)
        blend = os.path.join(self.dir, "overlay_0.png")
        _write(diffuse, b"jpg")
        _write(blend)
        if diffuse_known:
            state.files[diffuse] = ((150, 109, 91, 255), (64, 32))
        if alpha:
            state.alpha.add(diffuse)
        if blend_known:
            state.files[blend] = ((128, 48, 48, 255), (16, 16))
        painted = Image(rgba=painted_rgba, size=(64, 32), name="painted")
        with mock.patch.dict(sys.modules, modules), \
                mock.patch.object(self.skin, "_paint", return_value=painted) as paint:
            reason = self.skin._paint_bake(diffuse, blend, [("overlay", "Multiply", 0.6)])
        self.assertFalse(os.path.exists(blend))  # the temp overlay copy goes in every case
        return reason, state, paint, diffuse

    def test_paint_bake_saves_over_the_diffuse_when_the_result_matches_the_formula(self):
        reason, state, paint, diffuse = self._paint_bake((105, 56, 47, 255))
        self.assertIsNone(reason)
        self.assertIn(("save", "painted", diffuse, "jpg", 95), state.log)
        self.assertEqual(paint.call_args.args[1].size, (64, 32))  # the overlay is scaled to the diffuse size
        self.assertEqual(paint.call_args.args[2], [("overlay", "Multiply", 0.6)])
        reason, state, _paint, diffuse = self._paint_bake((105, 56, 47, 255), diffuse_name="Std_Skin_Arm_Diffuse.png")
        self.assertIn(("save", "painted", diffuse, "png", -1), state.log)

    def test_paint_bake_leaves_the_file_when_the_result_differs_from_the_formula(self):
        reason, state, _paint, _diffuse = self._paint_bake((120, 56, 47, 255))
        self.assertEqual(reason, "Std_Skin_Arm_Diffuse.jpg: the painted result differs from the bake formula by "
                                 "15/255, so the file was left as CC5 wrote it")
        self.assertNotIn("save", [entry[0] for entry in state.log])

    def test_paint_bake_reports_what_qt_could_not_read_or_write(self):
        self.assertEqual(self._paint_bake((105, 56, 47, 255), save_result=False)[0],
                         "Qt could not write Std_Skin_Arm_Diffuse.jpg")
        self.assertEqual(self._paint_bake((105, 56, 47, 255), diffuse_known=False)[0],
                         "Qt could not read Std_Skin_Arm_Diffuse.jpg")
        self.assertEqual(self._paint_bake((105, 56, 47, 255), blend_known=False)[0],
                         "Qt could not read the overlay image for Std_Skin_Arm_Diffuse.jpg")

    def test_paint_bake_leaves_an_image_with_an_alpha_channel_as_cc5_wrote_it(self):
        # P-7: Multiply, Plus and SourceOver write alpha where the diffuse is transparent, so a bake would fill its
        # cutouts, and the self-check compares colour only. (A JPG, like the skin diffuses, has no alpha channel.)
        reason, state, paint, _diffuse = self._paint_bake((105, 56, 47, 255), diffuse_name="M_Lace_Diffuse.png",
                                                          alpha=True)
        self.assertEqual(reason, "M_Lace_Diffuse.png has an alpha channel (transparency), which a bake would change: "
                                 "use separate for this character")
        paint.assert_not_called()
        self.assertNotIn("save", [entry[0] for entry in state.log])


if __name__ == "__main__":
    unittest.main()

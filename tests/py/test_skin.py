import os
import tempfile
import unittest
from unittest import mock

import _support


def _avatar():
    a = mock.MagicMock()
    a.GetMeshNames.return_value = ["CC_Base_Body", "CC_Base_Eye"]
    mats = {"CC_Base_Body": ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg", "Std_Eyelash"],
            "CC_Base_Eye": ["Std_Eye_R"]}
    a.GetMaterialComponent.return_value.GetMaterialNames.side_effect = lambda m: mats[m]
    # Live CC5 5.13 Digital Human skin shader: both pallor offsets exist and hold one value, 0 by default.
    a.GetMaterialComponent.return_value.GetShaderParameterNames.return_value = [
        "SSS Radius", "_BaseColorMap Brightness", "_BaseColorMap Saturation"]
    a.GetMaterialComponent.return_value.GetShaderParameter.return_value = [0.0]
    return a


class SkinTest(unittest.TestCase):
    def _assert_rgb(self, r, g, b):
        # Colours go to CC5 on its 0-255 steps (cc5_api._cc5_rgb, F-14): equal within one step.
        sent = self.rl.RRgb.call_args.args
        for got, want in zip(sent, (r, g, b)):
            self.assertAlmostEqual(got, want, delta=1 / 255)

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.skin = _support.fresh_import("cc5_skin")
        self.avatar = _avatar()
        self.png = os.path.join(tempfile.mkdtemp(), "bruise.png")
        open(self.png, "wb").close()
        p = mock.patch.object(self.skin.cc5_api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_targets_skip_eyelash_and_filter_region(self):
        self.assertEqual(len(self.skin.skin_targets(self.avatar, "all")), 4)
        self.assertEqual(self.skin.skin_targets(self.avatar, "arms"), [("CC_Base_Body", "Std_Skin_Arm")])

    def test_overlay_loads_diffuse_blend_and_weight(self):
        r = self.skin.apply_skin_overlay(self.png, "head", 60)
        self.assertTrue(r["success"])
        mc = self.avatar.GetMaterialComponent.return_value
        mc.LoadImageToTexture.assert_called_once_with(
            "CC_Base_Body", "Std_Skin_Head", self.rl.EMaterialTextureChannel_DiffuseBlend, self.png)
        self.assertAlmostEqual(mc.AddTextureWeightKey.call_args.args[4], 0.6)

    def test_overlay_rejects_bad_strength(self):
        self.assertFalse(self.skin.apply_skin_overlay(self.png, "all", 150)["success"])

    def test_condition_tint(self):
        r = self.skin.set_skin_condition("cyanotic", 0.5, "all")
        self.assertTrue(r["success"])
        self._assert_rgb(0.9, 0.93, 0.99)

    def test_condition_docstring_says_it_replaces_hand_made_brightness_and_saturation(self):
        doc = " ".join(self.skin.set_skin_condition.__doc__.split())
        self.assertIn("Every condition sets the Digital Human skin shader's base-colour Brightness and Saturation "
                      "(pale raises Brightness and lowers Saturation; the other conditions set both back to 0), so a "
                      "Brightness or Saturation change made by hand in CC5 is replaced.", doc)

    def test_condition_tints_base_skin_tone(self):
        r = self.skin.set_skin_condition("cyanotic", 0.5, "all", (0.4, 0.3, 0.25))
        self.assertTrue(r["success"])
        self._assert_rgb(0.36, 0.279, 0.2475)
        self.assertEqual(self.skin.ACTIONS["set_skin_condition"]({"condition": "normal", "base_rgb": [0.4, 0.3, 0.25]})["rgb"], [0.4, 0.3, 0.25])
        self.assertFalse(self.skin.set_skin_condition("pale", 1.0, "all", [0.1, 0.2])["success"])

    def test_pale_lightens_and_desaturates_through_the_skin_shader(self):
        # Live CC5 5.13 (Task 18): the old pale tint (0.93, 0.90, 0.88) made the face darker and MORE saturated;
        # +0.048 brightness and -0.2 saturation (pale 0.8) took Camila's cheeks from lightness 0.42 to 0.54 and
        # saturation 0.27 to 0.12.
        r = self.skin.set_skin_condition("pale", 0.8, "all", (0.4, 0.3, 0.25))
        self.assertTrue(r["success"])
        self._assert_rgb(0.4, 0.3, 0.25)  # pale keeps the skin tone: no darkening tint
        mc = self.avatar.GetMaterialComponent.return_value
        for mat in ("Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"):
            mc.SetShaderParameter.assert_any_call("CC_Base_Body", mat, "_BaseColorMap Brightness", [0.048])
            mc.SetShaderParameter.assert_any_call("CC_Base_Body", mat, "_BaseColorMap Saturation", [-0.2])
        self.assertEqual(r["shader"], {"_BaseColorMap Brightness": 0.048, "_BaseColorMap Saturation": -0.2})

    def test_other_conditions_clear_the_pallor(self):
        for condition in ("normal", "cyanotic"):
            with self.subTest(condition=condition):
                mc = self.avatar.GetMaterialComponent.return_value
                mc.SetShaderParameter.reset_mock()
                r = self.skin.set_skin_condition(condition, 1.0, "head")
                self.assertTrue(r["success"])
                mc.SetShaderParameter.assert_any_call("CC_Base_Body", "Std_Skin_Head", "_BaseColorMap Brightness", [0.0])
                mc.SetShaderParameter.assert_any_call("CC_Base_Body", "Std_Skin_Head", "_BaseColorMap Saturation", [0.0])

    def test_pale_fails_when_the_skin_shader_has_no_pallor_offsets(self):
        mc = self.avatar.GetMaterialComponent.return_value
        mc.GetShaderParameterNames.return_value = ["SSS Radius"]
        r = self.skin.set_skin_condition("pale", 0.8, "all")
        self.assertFalse(r["success"])
        self.assertIn("_BaseColorMap Brightness", r["error"])
        mc.SetShaderParameter.assert_not_called()
        self.assertTrue(self.skin.set_skin_condition("cyanotic", 0.8, "all")["success"])  # a tint needs no offsets

    def test_pallor_offsets_are_not_written_with_the_wrong_value_count(self):
        mc = self.avatar.GetMaterialComponent.return_value
        mc.GetShaderParameter.return_value = [0.0, 0.0]
        r = self.skin.set_skin_condition("pale", 0.8, "all")
        self.assertFalse(r["success"])
        mc.SetShaderParameter.assert_not_called()

    def test_unknown_condition(self):
        self.assertFalse(self.skin.set_skin_condition("glowing", 1.0, "all")["success"])

    def test_browse_image_folders_keep_images(self):
        self.rl.RApplication.GetContentFilesInFolder.return_value = ["C:/l/Bruise.PNG", "C:/l/notes.txt", "C:/l/x.ccShoes"]
        self.assertEqual(self.skin.cc5_api.browse_content("image_layer"), ["C:/l/Bruise.PNG", "C:/l/x.ccShoes"])
        self.assertEqual(self.skin.cc5_api.browse_content("shoes"), ["C:/l/x.ccShoes"])

    def test_wrinkle_sets_every_face_part_and_clamps(self):
        self.rl.EWrinkleFacePart_Blink = "blink"
        self.rl.EWrinkleFacePart_Neck = "neck"
        r = self.skin.set_wrinkle_strength(1.7)
        self.assertTrue(r["success"])
        self.assertEqual(sorted(r["parts"]), ["EWrinkleFacePart_Blink", "EWrinkleFacePart_Neck"])
        mc = self.avatar.GetMaterialComponent.return_value
        self.assertEqual(sorted(c.args for c in mc.SetWrinkleDetailStrength.call_args_list),
                         [("blink", 1.0), ("neck", 1.0)])
        self.avatar.UpdateWrinkle.assert_called_once_with()
        self.rl.RGlobal.ObjectModified.assert_called_once_with(self.avatar, self.skin.cc5_api._EOMTYPE_MATERIAL)

    def test_wrinkle_without_wrinkle_api_is_a_failure(self):
        r = self.skin.set_wrinkle_strength(0.5)
        self.assertFalse(r["success"])
        self.assertIn("EWrinkleFacePart", r["error"])

    # CC5 reports these failures as an RStatus, not an exception (same check as cc5_pipeline.load_texture).

    def _refuse(self, method, on_call=1):
        """Make the material component's `method` return an error RStatus from its `on_call`-th call on."""
        mc = self.avatar.GetMaterialComponent.return_value
        calls = []

        def status(*args):
            calls.append(args)
            st = mock.MagicMock()
            st.IsError.return_value = len(calls) >= on_call
            return st
        getattr(mc, method).side_effect = status
        return mc

    def test_overlay_fails_when_cc5_refuses_the_image(self):
        mc = self._refuse("LoadImageToTexture")
        r = self.skin.apply_skin_overlay(self.png, "all", 50)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "LoadImageToTexture on Std_Skin_Head reported an error status")  # nothing applied
        self.assertEqual(r["applied_to"], [])
        mc.AddTextureWeightKey.assert_not_called()
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_overlay_fails_part_way_when_cc5_refuses_a_weight_key(self):
        self._refuse("AddTextureWeightKey", on_call=2)
        r = self.skin.apply_skin_overlay(self.png, "all", 50)
        self.assertFalse(r["success"])
        # TS-2: a failed direct call reaches the agent as its error text alone (HTTP 400), so the text names what
        # changed; the structured field stays.
        self.assertEqual(r["error"], "AddTextureWeightKey on Std_Skin_Body reported an error status. Applied to: "
                                     "Std_Skin_Head.")
        self.assertEqual(r["applied_to"], ["Std_Skin_Head"])
        # The first material did change, so the viewport is still told.
        self.rl.RGlobal.ObjectModified.assert_called_once_with(self.avatar, self.skin.cc5_api._EOMTYPE_MATERIAL)
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_remove_overlay_reports_materials_cc5_refused(self):
        mc = self._refuse("RemoveMaterialTexture", on_call=3)
        r = self.skin.remove_skin_overlay("all")
        self.assertFalse(r["success"])
        self.assertEqual(r["removed_from"], ["Std_Skin_Head", "Std_Skin_Body"])
        self.assertEqual(r["reset"], [])  # each material had an image
        # TS-2: the error text says what was removed too (a failed direct call reaches the agent as that text alone).
        self.assertEqual(r["error"], "Overlay not removed from: Std_Skin_Arm (RemoveMaterialTexture reported an error "
                                     "status); Std_Skin_Leg (RemoveMaterialTexture reported an error status). Removed "
                                     "from: Std_Skin_Head, Std_Skin_Body.")
        self.assertEqual(mc.RemoveMaterialTexture.call_count, 4)
        mc.RemoveMaterialTexture.assert_called_with("CC_Base_Body", "Std_Skin_Leg", self.rl.EMaterialTextureChannel_DiffuseBlend)
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_remove_overlay_skips_materials_without_an_overlay(self):
        # Live CC5: RemoveMaterialTexture returns an error status (Failure) on a material whose Diffuse
        # Blend channel is empty, so 'all' failed whenever only some regions had an overlay.
        mc = self.avatar.GetMaterialComponent.return_value
        mc.HasImage.side_effect = lambda mesh, mat, ch: mat == "Std_Skin_Head"
        mc.RemoveMaterialTexture.return_value.IsError.return_value = False
        r = self.skin.remove_skin_overlay("all")
        self.assertTrue(r["success"])
        self.assertEqual(r["removed_from"], ["Std_Skin_Head"])
        self.assertEqual(r["no_overlay"], ["Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"])
        mc.RemoveMaterialTexture.assert_called_once_with(
            "CC_Base_Body", "Std_Skin_Head", self.rl.EMaterialTextureChannel_DiffuseBlend)
        mc.HasImage.assert_called_with("CC_Base_Body", "Std_Skin_Leg", self.rl.EMaterialTextureChannel_DiffuseBlend)

    def test_remove_overlay_removes_from_every_region_material(self):
        r = self.skin.remove_skin_overlay("all")
        self.assertTrue(r["success"])
        self.assertEqual(r["removed_from"], ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"])

    def test_condition_fails_when_cc5_refuses_a_diffuse_key(self):
        self._refuse("AddDiffuseKey", on_call=2)
        r = self.skin.set_skin_condition("pale", 1.0, "all")
        self.assertFalse(r["success"])
        self.assertIn("AddDiffuseKey on Std_Skin_Body", r["error"])
        self.assertEqual(r["applied_to"], ["Std_Skin_Head"])
        self.rl.RGlobal.ObjectModified.assert_called_once()
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_wrinkle_fails_when_cc5_refuses_a_face_part(self):
        self.rl.EWrinkleFacePart_Blink = "blink"
        self.rl.EWrinkleFacePart_Neck = "neck"
        self._refuse("SetWrinkleDetailStrength")
        r = self.skin.set_wrinkle_strength(0.5)
        self.assertFalse(r["success"])
        self.assertIn("SetWrinkleDetailStrength on EWrinkleFacePart_", r["error"])
        self.assertEqual(r["parts"], [])
        self.rl.RGlobal.EndAction.assert_called_once()
        self.avatar.UpdateWrinkle.assert_not_called()


class MakeupBrowseTest(unittest.TestCase):
    FOLDERS = {
        "makeup_full": "EContentRootFolder_FullMakeup",
        "makeup_foundation": "EContentRootFolder_FoundationMakeup",
        "makeup_eye": "EContentRootFolder_EyeMakeup",
        "makeup_lip": "EContentRootFolder_LipMakeup",
        "image_layer": "EContentRootFolder_ImageLayer",
        "skingen": "EContentRootFolder_SkinGenTools",
        "wrinkle_mask": "EContentRootFolder_WrinkleMasks",
        "texture": "EContentRootFolder_Texture",
    }

    def test_new_folder_types_resolve_and_list(self):
        rl = _support.install_fake_rlpy()
        api = _support.fresh_import("cc5_api")
        app = rl.RApplication
        app.GetDefaultContentFolder.return_value = "$/Content"
        app.GetCustomContentFolder.return_value = None
        app.GetContentFilesInFolder.return_value = ["$/Content/item.ccTemplate"]
        for key, enum_name in self.FOLDERS.items():
            with self.subTest(folder_type=key):
                app.GetDefaultContentFolder.reset_mock()
                self.assertEqual(api.browse_content(key), ["$/Content/item.ccTemplate"])
                app.GetDefaultContentFolder.assert_called_once_with(getattr(rl, enum_name))


class WrinkleDocTest(unittest.TestCase):
    def test_wrinkle_docstring_says_expression_wrinkles_that_do_not_age_a_resting_face(self):
        # F-70, live: a neutral face did not change.
        _support.install_fake_rlpy()
        skin = _support.fresh_import("cc5_skin")
        doc = " ".join(skin.set_wrinkle_strength.__doc__.split())
        self.assertIn("expression wrinkles", doc)
        self.assertIn("does not age", doc)


class OverlayReadBackTest(unittest.TestCase):
    """F-65: CC5 reads a new Diffuse Blend strength back only after it renders; F-66: removing resets it to 0."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.rl.EMaterialTextureChannel_DiffuseBlend = 7
        self.skin = _support.fresh_import("cc5_skin")
        self.avatar = _avatar()
        self.avatar.GetID.return_value = "kevin-1"
        self.mc = self.avatar.GetMaterialComponent.return_value
        self.reads = {}  # material -> the Diffuse Blend weight CC5 reads (missing: unreadable)

        def weights(mesh, mat):
            if mat not in self.reads:
                raise RuntimeError("unreadable")
            return [0.0] * 7 + [self.reads[mat]]
        self.mc.GetTextureWeights.side_effect = weights
        self.png = os.path.join(tempfile.mkdtemp(), "bruise.png")
        open(self.png, "wb").close()
        p = mock.patch.object(self.skin.cc5_api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def key(self, mat):
        return ("kevin-1", "CC_Base_Body", mat)

    def test_apply_returns_what_cc5_reads_back_and_which_reads_are_stale(self):
        self.reads = {"Std_Skin_Head": 0.0, "Std_Skin_Body": 0.6, "Std_Skin_Arm": 0.6004}  # Std_Skin_Leg unreadable
        r = self.skin.apply_skin_overlay(self.png, "all", 60)
        self.assertTrue(r["success"])
        self.assertEqual(r["strengths"], {"Std_Skin_Head": 0.0, "Std_Skin_Body": 0.6, "Std_Skin_Arm": 0.6})
        self.assertEqual(r["stale"], ["Std_Skin_Head"])
        self.assertEqual(r["applied_to"], ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"])

    def test_apply_records_each_material_it_changed_also_before_a_failure(self):
        calls = []

        def weight_key(*args):
            calls.append(args)
            status = mock.MagicMock()
            status.IsError.return_value = len(calls) == 3  # refused on Std_Skin_Arm
            return status
        self.mc.AddTextureWeightKey.side_effect = weight_key
        r = self.skin.apply_skin_overlay(self.png, "all", 60)
        self.assertFalse(r["success"])
        self.assertEqual(self.skin.cc5_pipeline.BLEND_SOURCES, {
            self.key("Std_Skin_Head"): {"image": self.png, "strength": 0.6},
            self.key("Std_Skin_Body"): {"image": self.png, "strength": 0.6}})
        self.rl.RGlobal.ObjectModified.assert_called_once_with(self.avatar, self.skin.cc5_api._EOMTYPE_MATERIAL)
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_apply_marks_the_old_record_stale_where_the_image_went_in_but_not_its_strength(self):
        # CC5 took the new image on Std_Skin_Arm but refused its strength: that material's record still names the old
        # image, which an export must not ship or bake (P-1). The materials before it got fresh records.
        self.skin.cc5_pipeline.BLEND_SOURCES[self.key("Std_Skin_Arm")] = {"image": "C:/o/dirt.png", "strength": 1.0}

        def weight_key(*args):
            status = mock.MagicMock()
            status.IsError.return_value = args[2] == "Std_Skin_Arm"
            return status
        self.mc.AddTextureWeightKey.side_effect = weight_key
        r = self.skin.apply_skin_overlay(self.png, "all", 60)
        self.assertFalse(r["success"])
        self.assertEqual(self.skin.cc5_pipeline.BLEND_SOURCES, {
            self.key("Std_Skin_Head"): {"image": self.png, "strength": 0.6},
            self.key("Std_Skin_Body"): {"image": self.png, "strength": 0.6},
            self.key("Std_Skin_Arm"): {"image": "C:/o/dirt.png", "strength": 1.0, "stale": True}})

    def test_apply_records_every_material_on_success(self):
        self.skin.apply_skin_overlay(self.png, "arms", 35)
        self.assertEqual(self.skin.cc5_pipeline.BLEND_SOURCES,
                         {self.key("Std_Skin_Arm"): {"image": self.png, "strength": 0.35}})

    def test_apply_writes_a_fresh_record_over_a_stale_one(self):
        # P-1: an undo or redo marks the records stale; applying again makes the material's record trusted again.
        self.skin.cc5_pipeline.BLEND_SOURCES[self.key("Std_Skin_Arm")] = {"image": "C:/o/dirt.png", "strength": 1.0}
        self.skin.cc5_pipeline.mark_blend_sources_stale()
        self.skin.apply_skin_overlay(self.png, "arms", 35)
        self.assertEqual(self.skin.cc5_pipeline.BLEND_SOURCES,
                         {self.key("Std_Skin_Arm"): {"image": self.png, "strength": 0.35}})

    def test_a_read_that_is_not_a_number_counts_as_unread(self):
        # P-8: a NaN or infinite read would reach the JSON reply, which the MCP server cannot parse.
        self.reads = {"Std_Skin_Head": float("nan"), "Std_Skin_Body": 0.6, "Std_Skin_Arm": float("inf"),
                      "Std_Skin_Leg": 0.6}
        r = self.skin.apply_skin_overlay(self.png, "all", 60)
        self.assertTrue(r["success"])
        self.assertEqual((r["strengths"], r["stale"]), ({"Std_Skin_Body": 0.6, "Std_Skin_Leg": 0.6}, []))

    def test_no_refresh_call_while_refresh_method_is_off(self):
        self.reads = {m: 0.6 for m in ("Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg")}
        self.skin.apply_skin_overlay(self.png, "all", 60)
        self.rl.RGlobal.SetTime.assert_not_called()

    def test_set_time_refresh_and_reads_happen_inside_the_action(self):
        order = []
        self.reads = {"Std_Skin_Head": 0.6}
        self.rl.RGlobal.GetTime.return_value = "now"
        self.rl.RGlobal.SetTime.side_effect = lambda t: order.append(("SetTime", t))
        read = self.mc.GetTextureWeights.side_effect
        self.mc.GetTextureWeights.side_effect = lambda mesh, mat: order.append("GetTextureWeights") or read(mesh, mat)
        self.rl.RGlobal.EndAction.side_effect = lambda: order.append("EndAction")
        with mock.patch.object(self.skin.cc5_pipeline, "REFRESH_METHOD", "set_time"):
            r = self.skin.apply_skin_overlay(self.png, "head", 60)
        self.assertEqual(order, [("SetTime", "now"), "GetTextureWeights", "EndAction"])
        self.assertEqual(r["stale"], [])

    def test_remove_resets_the_strength_of_removed_and_image_less_materials_and_drops_their_records(self):
        for mat in ("Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"):
            self.skin.cc5_pipeline.BLEND_SOURCES[self.key(mat)] = {"image": self.png, "strength": 0.6}
        self.mc.HasImage.side_effect = lambda mesh, mat, ch: mat != "Std_Skin_Body"

        def remove(mesh, mat, ch):
            status = mock.MagicMock()
            status.IsError.return_value = mat == "Std_Skin_Arm"  # CC5 refuses this one
            return status
        self.mc.RemoveMaterialTexture.side_effect = remove
        r = self.skin.remove_skin_overlay("all")
        self.assertFalse(r["success"])
        self.assertEqual(r["removed_from"], ["Std_Skin_Head", "Std_Skin_Leg"])
        self.assertEqual(r["no_overlay"], ["Std_Skin_Body"])
        self.assertEqual(r["reset"], ["Std_Skin_Body"])  # X-5: the image-less material's strength was set to 0
        self.assertEqual(r["error"], "Overlay not removed from: Std_Skin_Arm (RemoveMaterialTexture reported an error "
                                     "status). Removed from: Std_Skin_Head, Std_Skin_Leg. Strength set to 0 on: "
                                     "Std_Skin_Body (no overlay image there).")
        zeroed = [(c.args[2], c.args[3], c.args[4]) for c in self.mc.AddTextureWeightKey.call_args_list]
        self.assertEqual(zeroed, [("Std_Skin_Head", 7, 0.0), ("Std_Skin_Body", 7, 0.0), ("Std_Skin_Leg", 7, 0.0)])
        # The refused material still shows its overlay: its strength and its record stay.
        self.assertEqual(list(self.skin.cc5_pipeline.BLEND_SOURCES), [self.key("Std_Skin_Arm")])
        self.assertNotIn("notes", r)

    def test_a_failure_puts_each_warning_on_its_own_line_of_the_error(self):
        # TS-2: a failed direct call reaches the agent as its error text alone (HTTP 400); the fields stay too.
        self.mc.HasImage.side_effect = lambda mesh, mat, ch: mat in ("Std_Skin_Head", "Std_Skin_Arm")

        def remove(mesh, mat, ch):
            status = mock.MagicMock()
            status.IsError.return_value = mat == "Std_Skin_Arm"
            return status

        def weight_key(key, mesh, mat, ch, weight):
            status = mock.MagicMock()
            status.IsError.return_value = mat == "Std_Skin_Head"
            return status
        self.mc.RemoveMaterialTexture.side_effect = remove
        self.mc.AddTextureWeightKey.side_effect = weight_key
        r = self.skin.remove_skin_overlay("all")
        warning = "WARNING: Std_Skin_Head: strength not reset to 0 (AddTextureWeightKey reported an error status)"
        self.assertEqual(r, {
            "success": False,
            "error": ("Overlay not removed from: Std_Skin_Arm (RemoveMaterialTexture reported an error status). Removed "
                      "from: Std_Skin_Head. Strength set to 0 on: Std_Skin_Body, Std_Skin_Leg (no overlay image "
                      f"there).\n{warning}"),
            "removed_from": ["Std_Skin_Head"], "no_overlay": ["Std_Skin_Body", "Std_Skin_Leg"],
            "reset": ["Std_Skin_Body", "Std_Skin_Leg"], "notes": [warning]})

    def test_a_remove_without_any_image_lists_the_strengths_it_set_to_0(self):
        # X-5: setting a strength to 0 is a change (one CC5 undo step with the call), so the result names it. A reset
        # CC5 refuses is a WARNING note instead, and stale records go as any other.
        for mat in ("Std_Skin_Head", "Std_Skin_Body"):
            self.skin.cc5_pipeline.BLEND_SOURCES[self.key(mat)] = {"image": self.png, "strength": 0.6}
        self.skin.cc5_pipeline.mark_blend_sources_stale()
        self.mc.HasImage.return_value = False
        skin = ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"]
        r = self.skin.remove_skin_overlay("all")
        self.assertEqual(r, {"success": True, "removed_from": [], "no_overlay": skin, "reset": skin})
        self.mc.RemoveMaterialTexture.assert_not_called()
        self.assertEqual(self.skin.cc5_pipeline.BLEND_SOURCES, {})
        self.mc.AddTextureWeightKey.return_value.IsError.return_value = True
        r = self.skin.remove_skin_overlay("head")
        self.assertEqual(r, {"success": True, "removed_from": [], "no_overlay": ["Std_Skin_Head"], "reset": [],
                             "notes": ["WARNING: Std_Skin_Head: strength not reset to 0 (AddTextureWeightKey reported an "
                                       "error status)"]})

    def test_a_strength_cc5_will_not_reset_is_a_warning(self):
        self.mc.HasImage.side_effect = lambda mesh, mat, ch: mat == "Std_Skin_Head"
        self.mc.RemoveMaterialTexture.return_value.IsError.return_value = False
        self.mc.AddTextureWeightKey.return_value.IsError.return_value = True
        r = self.skin.remove_skin_overlay("head")
        self.assertTrue(r["success"])
        self.assertEqual(r["removed_from"], ["Std_Skin_Head"])
        self.assertEqual(r["notes"], ["WARNING: Std_Skin_Head: strength not reset to 0 "
                                      "(AddTextureWeightKey reported an error status)"])

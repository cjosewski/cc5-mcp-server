from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class TextureTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()
        self.png = os.path.join(self.dir, "bruise.png")
        open(self.png, "wb").close()
        self.avatar = mock.MagicMock()
        self.avatar.GetMeshNames.return_value = ["CC_Base_Body"]
        self.avatar.GetMaterialComponent.return_value.GetMaterialNames.return_value = ["Std_Skin_Body"]

    def test_unknown_channel(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.load_texture("CC_Base_Body", "Std_Skin_Body", "sparkle", self.png)
        self.assertFalse(r["success"])

    def test_unknown_material(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.load_texture("CC_Base_Body", "Nope", "diffuse", self.png)
        self.assertFalse(r["success"])
        self.assertIn("Std_Skin_Body", r["error"])

    def test_loads_into_channel(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.load_texture("CC_Base_Body", "Std_Skin_Body", "normal", self.png)
        self.assertTrue(r["success"])
        self.avatar.GetMaterialComponent.return_value.LoadImageToTexture.assert_called_once_with(
            "CC_Base_Body", "Std_Skin_Body", self.rl.EMaterialTextureChannel_Normal, self.png)

    def test_substance_import_needs_folder(self):
        r = self.pipe.load_substance_textures(os.path.join(self.dir, "missing"))
        self.assertFalse(r["success"])

    def test_export_textures_keeps_the_source_image_formats(self):
        # Live CC5 5.13 crashes right after an export with Convert Image Format (Task 18), so it is never asked for.
        def fake_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": True, "notes": []}
        with mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            r = self.pipe.export_textures(self.dir, "P1")
        self.assertTrue(r["success"])
        self.assertFalse(exp.call_args.kwargs.get("convert_image_format", False))
        self.assertFalse(exp.call_args.kwargs["export_motion"])
        self.assertFalse(exp.call_args.kwargs["allow_fallback"])

    def test_export_textures_fails_when_no_fbx_was_written_or_settings_were_dropped(self):
        for fake in ({"success": True, "flags_applied": True, "notes": []},
                     {"success": True, "flags_applied": False, "notes": ["WARNING: x"]}):
            with self.subTest(result=fake), \
                    mock.patch.object(self.pipe.cc5_api, "export_fbx", return_value=fake):
                r = self.pipe.export_textures(tempfile.mkdtemp(), "P1")
            self.assertFalse(r["success"])

    def test_load_texture_error_status_fails(self):
        mat_comp = self.avatar.GetMaterialComponent.return_value
        mat_comp.LoadImageToTexture.return_value.IsError.return_value = True
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.load_texture("CC_Base_Body", "Std_Skin_Body", "diffuse", self.png)
        self.assertFalse(r["success"])
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_substance_import_applies_folder(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.load_substance_textures(self.dir)
        self.assertTrue(r["success"])
        self.rl.RFileIO.LoadSubstancePainterTextures.assert_called_once_with(self.avatar, self.dir)

    def test_substance_import_error_status_fails(self):
        self.rl.RFileIO.LoadSubstancePainterTextures.return_value.IsError.return_value = True
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.load_substance_textures(self.dir)
        self.assertFalse(r["success"])
        self.assertIn("Substance import failed", r["error"])

    def test_export_textures_needs_avatar(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=None), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx") as exp:
            r = self.pipe.export_textures(self.dir, "P1")
        self.assertFalse(r["success"])
        exp.assert_not_called()
        self.assertFalse(os.path.exists(os.path.join(self.dir, "P1")))


class DiffuseBlendTextureTest(unittest.TestCase):
    """load_texture('diffuse_blend') also sets the layer's strength (F-66): CC5 shows a Diffuse Blend image only above
    0, and a new image keeps the layer's old strength (0 on a fresh layer)."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.rl.EMaterialTextureChannel_DiffuseBlend = 7
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.png = os.path.join(tempfile.mkdtemp(), "overlay.png")
        open(self.png, "wb").close()
        self.avatar = mock.MagicMock()
        self.avatar.GetID.return_value = "kevin-1"
        self.avatar.GetMeshNames.return_value = ["CC_Base_Body"]
        self.mc = self.avatar.GetMaterialComponent.return_value
        self.mc.GetMaterialNames.return_value = ["Std_Skin_Leg"]
        self.read = 0.0  # what GetTextureWeights reports for Diffuse Blend
        self.mc.GetTextureWeights.side_effect = lambda mesh, mat: [0.0] * 7 + [self.read, 0.0]
        p = mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def load(self, channel="diffuse_blend", strength=None):
        return self.pipe.load_texture("CC_Base_Body", "Std_Skin_Leg", channel, self.png, strength)

    def test_sets_the_strength_to_100_by_default_in_the_same_action(self):
        self.read = 1.0
        r = self.load()
        self.assertEqual(r, {"success": True, "strength": 1.0, "read": 1.0, "stale": False})
        key, mesh, mat, channel, weight = self.mc.AddTextureWeightKey.call_args.args
        self.assertEqual((mesh, mat, channel, weight), ("CC_Base_Body", "Std_Skin_Leg", 7, 1.0))
        self.rl.RGlobal.BeginAction.assert_called_once_with("Load Texture")
        self.rl.RGlobal.EndAction.assert_called_once()

    def test_a_strength_of_30_sets_0_3(self):
        self.read = 0.3
        r = self.load(strength=30)
        self.assertAlmostEqual(self.mc.AddTextureWeightKey.call_args.args[4], 0.3)
        self.assertAlmostEqual(r["strength"], 0.3)
        self.assertFalse(r["stale"])

    def test_the_weight_key_comes_after_the_image_and_before_the_redraw_and_the_read(self):
        order = []
        self.mc.LoadImageToTexture.side_effect = lambda *a: order.append("LoadImageToTexture")
        self.mc.AddTextureWeightKey.side_effect = lambda *a: order.append("AddTextureWeightKey")
        self.rl.RGlobal.ObjectModified.side_effect = lambda *a: order.append("ObjectModified")
        self.mc.GetTextureWeights.side_effect = lambda *a: order.append("GetTextureWeights") or [0.0] * 8
        self.rl.RGlobal.EndAction.side_effect = lambda *a: order.append("EndAction")
        self.load()
        self.assertEqual(order, ["LoadImageToTexture", "AddTextureWeightKey", "ObjectModified", "GetTextureWeights",
                                 "EndAction"])

    def test_reports_a_stale_read_apart_from_the_strength_set(self):
        self.read = 0.0  # CC5 reads the old strength until it renders
        r = self.load(strength=60)
        self.assertEqual((r["strength"], r["read"], r["stale"]), (0.6, 0.0, True))
        self.mc.GetTextureWeights.side_effect = RuntimeError("unreadable")
        r = self.load(strength=60)
        self.assertEqual((r["strength"], r["read"], r["stale"]), (0.6, None, True))

    def test_records_the_image_and_strength_and_makes_no_refresh_call(self):
        self.load(strength=60)
        self.assertEqual(self.pipe.BLEND_SOURCES[("kevin-1", "CC_Base_Body", "Std_Skin_Leg")],
                         {"image": self.png, "strength": 0.6})
        self.rl.RGlobal.SetTime.assert_not_called()

    def test_a_read_that_is_not_a_number_counts_as_unread(self):
        # P-8: a NaN or infinite read would reach the JSON reply, which the MCP server cannot parse.
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(read=bad):
                self.read = bad
                self.assertEqual(self.load(strength=60),
                                 {"success": True, "strength": 0.6, "read": None, "stale": True})
                self.assertIsNone(self.pipe.read_blend_strength(self.mc, "CC_Base_Body", "Std_Skin_Leg"))
        self.read = 0.6
        self.assertEqual(self.pipe.read_blend_strength(self.mc, "CC_Base_Body", "Std_Skin_Leg"), 0.6)

    def test_a_load_writes_a_fresh_record_over_a_stale_one(self):
        # P-1: an undo or redo marks every record stale (cc5_api calls mark_blend_sources_stale); a new load of the
        # material makes its record trusted again.
        key = ("kevin-1", "CC_Base_Body", "Std_Skin_Leg")
        self.pipe.BLEND_SOURCES[key] = {"image": "C:/o/dirt.png", "strength": 1.0}
        self.pipe.mark_blend_sources_stale()
        self.assertEqual(self.pipe.BLEND_SOURCES[key], {"image": "C:/o/dirt.png", "strength": 1.0, "stale": True})
        self.load(strength=30)
        self.assertEqual(self.pipe.BLEND_SOURCES, {key: {"image": self.png, "strength": 0.3}})

    def test_an_image_that_went_in_without_its_strength_marks_the_old_record_stale(self):
        # CC5 took the new image but refused its strength: the record still names the old image, which an export must
        # not ship or bake (P-1). A failure before the image went in leaves the record as it was.
        key = ("kevin-1", "CC_Base_Body", "Std_Skin_Leg")
        refused = mock.MagicMock()
        refused.IsError.return_value = True
        self.pipe.BLEND_SOURCES[key] = {"image": "C:/o/dirt.png", "strength": 1.0}
        self.mc.LoadImageToTexture.return_value = refused
        self.assertFalse(self.load(strength=60)["success"])
        self.assertEqual(self.pipe.BLEND_SOURCES[key], {"image": "C:/o/dirt.png", "strength": 1.0})
        self.mc.LoadImageToTexture.return_value = mock.MagicMock(**{"IsError.return_value": False})
        self.mc.AddTextureWeightKey.return_value = refused
        r = self.load(strength=60)
        self.assertFalse(r["success"])
        self.assertIn("the image is loaded but its strength was not set", r["error"])
        self.assertEqual(self.pipe.BLEND_SOURCES[key], {"image": "C:/o/dirt.png", "strength": 1.0, "stale": True})

    def test_other_channels_set_no_strength(self):
        r = self.load("normal")
        self.assertEqual(r, {"success": True})
        self.mc.AddTextureWeightKey.assert_not_called()
        self.mc.GetTextureWeights.assert_not_called()
        self.assertEqual(self.pipe.BLEND_SOURCES, {})

    def test_refuses_a_bad_strength_before_cc5_is_asked(self):
        cases = [("normal", 30, "strength is only for channel 'diffuse_blend'")] + [
            ("diffuse_blend", s, "strength must be 0-100") for s in (150, -1, True, "x", float("nan"))]
        for channel, strength, error in cases:
            with self.subTest(channel=channel, strength=strength):
                self.assertEqual(self.load(channel, strength), {"success": False, "error": error})
        self.mc.LoadImageToTexture.assert_not_called()
        self.rl.RGlobal.BeginAction.assert_not_called()

    def test_a_refused_weight_key_says_the_strength_was_not_set(self):
        self.mc.AddTextureWeightKey.return_value.IsError.return_value = True
        r = self.load(strength=30)
        self.assertFalse(r["success"])
        self.assertIn("strength was not set", r["error"])
        self.assertIn("CC5 shows a Diffuse Blend image only above 0", r["error"])
        self.rl.RGlobal.EndAction.assert_called_once()
        # The image did go in, so the viewport is still told.
        self.rl.RGlobal.ObjectModified.assert_called_once()
        self.assertEqual(self.pipe.BLEND_SOURCES, {})

    def test_the_job_action_forwards_the_strength(self):
        with mock.patch.object(self.pipe, "load_texture", return_value={"success": True}) as load:
            self.pipe.ACTIONS["load_texture"]({"mesh_name": "m", "material_name": "x", "channel": "diffuse_blend",
                                               "image_path": self.png, "strength": 30})
            load.assert_called_once_with("m", "x", "diffuse_blend", self.png, 30)
            load.reset_mock()
            self.pipe.ACTIONS["load_texture"]({"mesh_name": "m", "material_name": "x", "channel": "normal",
                                               "image_path": self.png})
            load.assert_called_once_with("m", "x", "normal", self.png, None)

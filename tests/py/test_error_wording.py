"""Errors name what was not found and say where to look (F-21); smaller wording fixes (F-15, F-16)."""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


class ErrorWordingTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")

    def test_load_asset_points_images_fbx_and_obj_to_their_tools(self):
        # Live P5-29: "Disallowed file extension: .png" alone.
        for ext, tool in ((".png", "load_texture"), (".jpg", "apply_skin_overlay"), (".fbx", "import_fbx"),
                          (".obj", "replace_mesh_from_obj")):
            with self.subTest(ext=ext):
                r = self.api.load_asset(os.path.join(tempfile.gettempdir(), f"x{ext}"))
                self.assertIn(f"Disallowed file extension: {ext}", r["error"])
                self.assertIn(tool, r["error"])
        self.assertEqual(self.api._load_asset_hint(".zip"), "")

    def test_unknown_shader_parameter_suggests_close_matches(self):
        avatar = mock.MagicMock()
        mat = avatar.GetMaterialComponent.return_value
        mat.GetShaderParameterNames.return_value = ["Original Roughness Strength", "_Specular"]
        with mock.patch.object(self.api, "get_first_avatar", return_value=avatar), \
                mock.patch.object(self.api, "_get_valid_mesh_material", return_value=(mat, None)):
            r = self.api.set_shader_parameter("CC_Base_Body", "Std_Skin_Head", "Original Roughnes Strength", [0.4])
        self.assertIn("Shader parameter not found: Original Roughnes Strength", r["error"])
        self.assertIn("Close matches: Original Roughness Strength", r["error"])
        self.assertIn("get_shader_parameters", r["error"])

    def _set_unknown(self, names, parameter_name):
        avatar = mock.MagicMock()
        mat = avatar.GetMaterialComponent.return_value
        mat.GetShaderParameterNames.return_value = names
        with mock.patch.object(self.api, "get_first_avatar", return_value=avatar), \
                mock.patch.object(self.api, "_get_valid_mesh_material", return_value=(mat, None)):
            r = self.api.set_shader_parameter("CC_Base_Body", "Std_Skin_Head", parameter_name, [0.4])
        mat.SetShaderParameter.assert_not_called()
        return r["error"]

    def test_close_matches_keep_only_the_real_match(self):
        # F-64 (live): at difflib's default cutoff the typo also offered Keep Original Roughness (ratio 0.69) and
        # Chin Roughness Scale (0.61) next to Original Roughness Strength (0.98).
        error = self._set_unknown(["Original Roughness Strength", "Keep Original Roughness", "Chin Roughness Scale",
                                   "_Specular"], "Original Roughnes Strength")
        self.assertEqual(error, "Shader parameter not found: Original Roughnes Strength on CC_Base_Body / "
                                "Std_Skin_Head. Close matches: Original Roughness Strength. get_shader_parameters "
                                "shows the parameter names.")

    def test_padding_is_never_suggested(self):
        # F-69: padding entries are shader filler, not settings ('paddin1' is 0.93 like 'padding1').
        error = self._set_unknown(["padding1", "padding Last4", "SSS Radius"], "paddin1")
        self.assertNotIn("Close matches", error)
        self.assertNotIn("padding", error)

    def test_remove_scene_item_says_what_is_worn(self):
        # Live P5-70: "Item not found: nope" alone.
        boxers = mock.MagicMock()
        boxers.GetName.return_value = "Boxers"
        avatar = mock.MagicMock()
        avatar.GetClothes.return_value = [boxers]
        avatar.GetHairs.return_value = []
        avatar.GetAccessories.return_value = []
        with mock.patch.object(self.api, "get_first_avatar", return_value=avatar):
            r = self.api.remove_scene_item("nope")
        self.assertEqual(r["error"], "Item not found: nope. Worn now: Boxers.")

    def test_delete_avatar_on_an_empty_scene(self):
        # Live P2-2 / P2-16: an error, and a named delete said "No avatars in scene".
        self.rl.RScene.GetAvatars.return_value = []
        r = self.api.delete_avatar("")
        self.assertTrue(r["success"])
        self.assertEqual(r["removed"], [])
        r = self.api.delete_avatar("Kevin")
        self.assertEqual(r["error"], "Avatar not found: Kevin (the scene has no characters)")
        self.rl.RScene.RemoveObject.assert_not_called()


if __name__ == "__main__":
    unittest.main()

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

    def test_export_textures_uses_png_conversion(self):
        def fake_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True}
        with mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            r = self.pipe.export_textures(self.dir, "P1")
        self.assertTrue(r["success"])
        self.assertTrue(exp.call_args.kwargs["convert_image_format"])


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

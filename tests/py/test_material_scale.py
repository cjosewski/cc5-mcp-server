"""Material opacity, glossiness and specular: the tools use 0-1, CC5 uses 0-100."""
from __future__ import annotations

import unittest
from unittest import mock

import _support


class MaterialScaleTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.mat = self.avatar.GetMaterialComponent.return_value
        self.avatar.GetMeshNames.return_value = ["CC_Base_Body"]
        self.mat.GetMaterialNames.return_value = ["Std_Skin_Body"]
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_setters_send_cc5_its_0_to_100_scale(self):
        # Live: opacity 1.0 was sent as 1 (1%), and Kevin's torso vanished.
        cases = (("set_material_opacity", "AddOpacityKey", 1.0, 100.0),
                 ("set_material_opacity", "AddOpacityKey", 0.3, 30.0),
                 ("set_material_glossiness", "AddGlossinessKey", 0.2, 20.0),
                 ("set_material_specular", "AddSpecularKey", 0.0, 0.0))
        for setter, add, value, sent in cases:
            with self.subTest(setter=setter, value=value):
                getattr(self.mat, add).reset_mock()
                r = getattr(self.api, setter)("CC_Base_Body", "Std_Skin_Body", value)
                self.assertTrue(r["success"], r)
                self.assertAlmostEqual(getattr(self.mat, add).call_args.args[3], sent)

    def test_setters_clamp_to_0_1_before_scaling(self):
        self.api.set_material_opacity("CC_Base_Body", "Std_Skin_Body", 7)
        self.assertEqual(self.mat.AddOpacityKey.call_args.args[3], 100.0)

    def test_get_reports_0_to_1(self):
        # A fresh CC4 Kevin skin reads 100 / 20 / 100 from CC5.
        self.mat.GetOpacity.return_value = 100
        self.mat.GetGlossinessWeight.return_value = 20
        self.mat.GetSpecularWeight.return_value = 100
        r = self.api.get_material_properties("CC_Base_Body", "Std_Skin_Body")
        self.assertEqual((r["opacity"], r["glossiness"], r["specular"]), (1.0, 0.2, 1.0))

    def test_get_rounds_float32_noise(self):
        self.mat.GetOpacity.return_value = 30.000001192092896
        r = self.api.get_material_properties("CC_Base_Body", "Std_Skin_Body")
        self.assertEqual(r["opacity"], 0.3)


if __name__ == "__main__":
    unittest.main()

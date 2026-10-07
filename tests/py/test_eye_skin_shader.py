"""set_eye_color writes the cornea iris shader (F-10); set_skin_shader writes all four skin materials (F-38);
get_shader_parameters lists only settings (F-69)."""
from __future__ import annotations

import json
import unittest
from unittest import mock

import _support


class FakeShaders:
    """GetShaderParameterNames / GetShaderParameter / SetShaderParameter over a dict of (mesh, material) -> params."""

    def __init__(self, mat, params):
        self.params = params
        mat.GetShaderParameterNames.side_effect = lambda mesh, m: list(self.params.get((mesh, m), {}))
        mat.GetShaderParameter.side_effect = lambda mesh, m, n: list(self.params[(mesh, m)][n])
        mat.SetShaderParameter.side_effect = self.set

    def set(self, mesh, m, name, values):
        self.params[(mesh, m)][name] = list(values)


# Live CC4 Kevin (CC5 5.13): the corneas carry the iris colour; Std_Eye_R/L are plain PBR.
def _kevin_eyes():
    iris = {"Iris Color": [0.11, 0.133, 0.188], "Iris Inner Color": [0.192, 0.231, 0.216], "Iris Depth Scale": [0.743]}
    return {("CC_Base_Eye", "Std_Cornea_R"): dict(iris), ("CC_Base_Eye", "Std_Cornea_L"): dict(iris),
            ("CC_Base_Eye", "Std_Eye_R"): {}}


class EyeColorTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.mat = self.avatar.GetMaterialComponent.return_value
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_sets_both_iris_colours_on_both_corneas_in_one_undo_step(self):
        # Live: a diffuse colour on Std_Eye_R/L did nothing visible; the cornea's Iris Color is what shows.
        shaders = FakeShaders(self.mat, _kevin_eyes())
        r = self.api.set_eye_color(0.1, 0.5, 0.2)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["applied_to"], ["CC_Base_Eye/Std_Cornea_L", "CC_Base_Eye/Std_Cornea_R"])
        for side in ("Std_Cornea_R", "Std_Cornea_L"):
            for name in ("Iris Color", "Iris Inner Color"):
                self.assertEqual(shaders.params[("CC_Base_Eye", side)][name], [0.1, 0.5, 0.2])
        self.rl.RGlobal.BeginAction.assert_called_once_with("Set Eye Color")
        self.rl.RGlobal.EndAction.assert_called_once()
        self.mat.AddDiffuseKey.assert_not_called()

    def test_values_are_clamped(self):
        shaders = FakeShaders(self.mat, _kevin_eyes())
        self.api.set_eye_color(2, -1, 0.5)
        self.assertEqual(shaders.params[("CC_Base_Eye", "Std_Cornea_R")]["Iris Color"], [1.0, 0.0, 0.5])

    def test_eyes_without_the_iris_shader_are_refused_and_untouched(self):
        FakeShaders(self.mat, {("CC_Base_Eye", "Std_Eye_R"): {}})
        r = self.api.set_eye_color(0.1, 0.5, 0.2)
        self.assertFalse(r["success"])
        self.assertIn("eye preset", r["error"])
        self.mat.SetShaderParameter.assert_not_called()
        self.rl.RGlobal.BeginAction.assert_not_called()


class SkinShaderTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.mat = self.avatar.GetMaterialComponent.return_value
        self.mat.GetMaterialNames.return_value = ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg",
                                                  "Std_Nails"]
        skin = {"Original Roughness Strength": [0.85], "_BaseColorMap Brightness": [1.0]}
        self.shaders = FakeShaders(self.mat, {("CC_Base_Body", m): dict(skin) for m in
                                              ("Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg")})
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_sets_every_skin_material_in_one_undo_step(self):
        # Live: roughness 0.4 on Std_Skin_Head alone left a seam at the shoulders.
        r = self.api.set_skin_shader("Original Roughness Strength", [0.4])
        self.assertTrue(r["success"], r)
        self.assertEqual(r["materials"], ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"])
        for m in r["materials"]:
            self.assertEqual(self.shaders.params[("CC_Base_Body", m)]["Original Roughness Strength"], [0.4])
        self.rl.RGlobal.BeginAction.assert_called_once_with("Set Skin Shader")

    def test_unknown_parameter_or_wrong_count_changes_nothing(self):
        for name, values in (("Not_A_Param", [1]), ("Original Roughness Strength", [0.1, 0.2])):
            with self.subTest(name=name):
                r = self.api.set_skin_shader(name, values)
                self.assertFalse(r["success"])
                self.assertIn("get_shader_parameters", r["error"])
        self.mat.SetShaderParameter.assert_not_called()

    def test_bad_values_are_refused(self):
        for values in ([], ["a"], [float("nan")], "0.4"):
            with self.subTest(values=values):
                self.assertFalse(self.api.set_skin_shader("Original Roughness Strength", values)["success"])


class ShaderParameterListTest(unittest.TestCase):
    """F-69 (P6-6): get_shader_parameters listed 'SSS Metallic Threshold = []' and the padding entries as settings."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.mat = self.avatar.GetMaterialComponent.return_value
        self.mat.GetShader.return_value = "Digital_Human Head"
        # Live CC4 Kevin (CC5 5.13) Std_Skin_Head holds each kind; the lists keep CC5's order.
        self.params = {"SSS Radius": [1.5], "SSS Metallic Threshold": [], "padding1": [0, 0, 0],
                       "padding Last4": [0], "Bad": [float("nan")], "Broken": RuntimeError("SWIG")}
        self.mat.GetShaderParameterNames.side_effect = lambda mesh, m: list(self.params)
        self.mat.GetShaderParameter.side_effect = self._read
        first = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        self.get_first_avatar = first.start()
        self.addCleanup(first.stop)
        # A bare MagicMock avatar fails the mesh check (MagicMock's `in` is False), as in test_error_wording.py.
        valid = mock.patch.object(self.api, "_get_valid_mesh_material", return_value=(self.mat, None))
        valid.start()
        self.addCleanup(valid.stop)

    def _read(self, mesh, material, name):
        value = self.params[name]
        if isinstance(value, Exception):
            raise value
        return list(value)

    def test_only_settings_are_listed_and_the_rest_are_named_apart(self):
        r = self.api.get_shader_parameters("CC_Base_Body", "Std_Skin_Head")
        self.assertTrue(r["success"], r)
        self.assertEqual(r["parameters"], {"SSS Radius": [1.5]})
        self.assertEqual(r["no_value"], ["SSS Metallic Threshold"])
        self.assertEqual(r["filler"], ["padding1", "padding Last4"])
        self.assertEqual(r["unreadable"], ["Bad", "Broken"])
        read = [c.args[2] for c in self.mat.GetShaderParameter.call_args_list]
        self.assertNotIn("padding1", read)  # filler is never read
        self.assertNotIn("padding Last4", read)
        json.dumps(r, allow_nan=False)  # the NaN never reaches the bridge's JSON reply

    def test_a_parameter_with_no_value_is_refused_with_its_reason(self):
        # Before: "'SSS Metallic Threshold' expects 0 value(s), got 1".
        r = self.api.set_shader_parameter("CC_Base_Body", "Std_Skin_Head", "SSS Metallic Threshold", [0.5])
        self.assertEqual(r["error"], "'SSS Metallic Threshold' has no value CC5 can read on CC_Base_Body / "
                                     "Std_Skin_Head, so it cannot be set.")
        self.mat.SetShaderParameter.assert_not_called()
        self.rl.RGlobal.BeginAction.assert_not_called()

    def test_padding_is_refused_before_cc5_is_asked(self):
        r = self.api.set_shader_parameter("CC_Base_Body", "Std_Skin_Head", "padding1", [0, 0, 0])
        self.assertEqual(r, {"success": False,
                             "error": "'padding1' is shader padding (filler), not a setting, so it is not set."})
        self.get_first_avatar.assert_not_called()
        self.mat.GetShaderParameterNames.assert_not_called()

    def test_a_wrong_count_on_a_real_parameter_still_names_the_count(self):
        r = self.api.set_shader_parameter("CC_Base_Body", "Std_Skin_Head", "SSS Radius", [1, 2])
        self.assertEqual(r["error"], "'SSS Radius' expects 1 value(s), got 2")
        self.mat.SetShaderParameter.assert_not_called()

    def test_a_real_parameter_is_still_set(self):
        self.mat.SetShaderParameter.side_effect = lambda mesh, m, name, values: self.params.update({name: values})
        r = self.api.set_shader_parameter("CC_Base_Body", "Std_Skin_Head", "SSS Radius", [2.0])
        self.assertTrue(r["success"], r)
        self.assertEqual(r["values"], [2.0])


if __name__ == "__main__":
    unittest.main()

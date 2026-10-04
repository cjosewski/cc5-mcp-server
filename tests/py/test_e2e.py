"""Unit tests for the pure parts of scripts/e2e/run_e2e.py (no CC5, Blender or Unity needed)."""
from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest

SCRIPT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "e2e", "run_e2e.py"))


def load_e2e():
    spec = importlib.util.spec_from_file_location("run_e2e", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bones(offset_y: float = 0.0) -> list[dict]:
    names = ["CC_Base_Head", "CC_Base_L_Hand", "CC_Base_R_Hand", "CC_Base_L_Foot", "CC_Base_R_Foot"]
    return [{"name": n, "x": 0.1 * i, "y": 1.0 + offset_y, "z": 0.0} for i, n in enumerate(names)]


def unity_model(path="Assets/E2E/E2E_Patient/E2E_Patient.fbx", **kw) -> dict:
    model = {"path": path, "imported": True, "errors": [], "warnings": [], "animationType": "Generic",
             "skinnedRenderers": 2, "meshRenderers": 0, "triangles": 30000,
             "renderers": [{"name": "CC_Base_Body", "triangles": 28000}, {"name": "CC_Base_Eye", "triangles": 2000}],
             "materials": [{"name": "Std_Skin_Body", "mainTexture": "Std_Skin_Body_Diffuse"},
                           {"name": "Std_Eye_L", "mainTexture": "Std_Eye_L_Diffuse"}],
             "materialCount": 2, "materialsWithMainTexture": 2, "missingTextures": [], "bones": 101, "clips": [],
             "bonesStatic": bones(), "sampled": False, "bonesSampled": [], "seconds": 3.0}
    model.update(kw)
    return model


class JobTextTest(unittest.TestCase):
    def setUp(self):
        self.e2e = load_e2e()

    def test_job_id_comes_from_the_pending_text(self):
        text = ('Still running in CC5 (job cmd_1a2b3c4d_17). Call job_status with job_id "cmd_1a2b3c4d_17" '
                "to get the result. Do not start the same operation again.")
        self.assertEqual(self.e2e.job_id_from_text(text), "cmd_1a2b3c4d_17")
        self.assertIsNone(self.e2e.job_id_from_text("Exported C:/x.fbx (3 files, 9.7 MB total)."))


class TriangleTest(unittest.TestCase):
    def setUp(self):
        self.e2e = load_e2e()

    def test_equal_meshes_give_no_differences(self):
        cc5 = [{"mesh": "CC_Base_Body", "triangles": 28000}, {"mesh": "CC_Base_Eye", "triangles": 2000}]
        self.assertEqual(self.e2e.mesh_triangle_differences(cc5, unity_model()["renderers"]), [])

    def test_differences_name_each_mesh(self):
        cc5 = [{"mesh": "CC_Base_Body", "triangles": 28010}, {"mesh": "CC_Base_Teeth", "triangles": 500}]
        diffs = self.e2e.mesh_triangle_differences(cc5, unity_model()["renderers"])
        self.assertIn("CC_Base_Body: CC5 28,010, Unity 28,000", diffs)
        self.assertIn("CC_Base_Teeth: CC5 500, Unity (missing)", diffs)
        self.assertIn("CC_Base_Eye: CC5 (missing), Unity 2,000", diffs)

    def test_within_percent(self):
        self.assertTrue(self.e2e.within_percent(10_400, 10_000, 5))
        self.assertFalse(self.e2e.within_percent(10_600, 10_000, 5))
        self.assertFalse(self.e2e.within_percent(0, 10_000, 5))


class PoseTest(unittest.TestCase):
    def setUp(self):
        self.e2e = load_e2e()

    def test_bind_pose_import_fails(self):
        status, detail, dist = self.e2e.pose_check(unity_model(), unity_model(bonesStatic=bones()))
        self.assertEqual(status, "FAIL")
        self.assertIn("bind pose", detail)
        self.assertEqual(dist["static"]["CC_Base_Head"], 0.0)

    def test_pose_after_sampling_the_clip_passes(self):
        posed = unity_model(clips=["Take 001"], sampled=True, bonesSampled=bones(offset_y=-0.8))
        status, detail, dist = self.e2e.pose_check(unity_model(), posed)
        self.assertEqual(status, "PASS")
        self.assertIn("after sampling", detail)
        self.assertAlmostEqual(dist["sampled"]["CC_Base_L_Foot"], 0.8, places=5)

    def test_posed_as_imported_passes(self):
        status, detail, _ = self.e2e.pose_check(unity_model(), unity_model(bonesStatic=bones(offset_y=0.3)))
        self.assertEqual(status, "PASS")
        self.assertIn("as imported", detail)

    def test_missing_bones_fail(self):
        status, detail, _ = self.e2e.pose_check(unity_model(bonesStatic=[]), unity_model())
        self.assertEqual(status, "FAIL")
        self.assertIn("bones not found", detail)


class TextureTest(unittest.TestCase):
    def setUp(self):
        self.e2e = load_e2e()

    def test_unity_skin_materials_need_a_main_texture(self):
        ok, _ = self.e2e.unity_skin_texture_check(unity_model())
        self.assertTrue(ok)
        model = unity_model(materials=[{"name": "Std_Skin_Body", "mainTexture": ""},
                                       {"name": "Std_Eye_L", "mainTexture": "x"}])
        ok, detail = self.e2e.unity_skin_texture_check(model)
        self.assertFalse(ok)
        self.assertIn("Std_Skin_Body", detail)

    def test_unity_model_without_skin_materials_fails(self):
        ok, detail = self.e2e.unity_skin_texture_check(unity_model(materials=[{"name": "Std_Eye_L", "mainTexture": "x"}]))
        self.assertFalse(ok)
        self.assertIn("no skin material", detail)

    def test_blender_needs_every_image_resolved_and_textured_skin(self):
        report = {"images": [{"name": "a", "resolved": True}, {"name": "b", "resolved": True}],
                  "materials": [{"name": "Std_Skin_Body", "images": ["a"]}, {"name": "Std_Eye_L", "images": []}]}
        self.assertTrue(self.e2e.blender_texture_check(report)[0])
        report["images"][1]["resolved"] = False
        ok, detail = self.e2e.blender_texture_check(report)
        self.assertFalse(ok)
        self.assertIn("b", detail)
        report["images"][1]["resolved"] = True
        report["materials"][0]["images"] = []
        ok, detail = self.e2e.blender_texture_check(report)
        self.assertFalse(ok)
        self.assertIn("Std_Skin_Body", detail)


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.e2e = load_e2e()

    def run_data(self, status="PASS") -> dict:
        run = self.e2e.new_run({"scratch": "C:/s"})
        self.e2e.record(run, "CC5", "apply_character_recipe", True, "All 5 steps succeeded.", 12.3, "MCP")
        self.e2e.record(run, "Unity", "pose", status == "PASS", "posed after sampling", 0.0, "analysis")
        run["cc5"]["budget"] = "PASS — Quest budget\nOK   Triangles: 35,366 / 65,000"
        run["pose"] = {"static": {"CC_Base_Head": 0.0}, "sampled": {"CC_Base_Head": 0.912}}
        run["unity"]["models"] = [unity_model()]
        return run

    def test_report_has_overall_result_tables_budget_and_pose(self):
        text = self.e2e.render_report(self.run_data())
        self.assertIn("**Overall: PASS**", text)
        self.assertIn("| CC5 | apply_character_recipe | PASS | MCP | 12.3 s | All 5 steps succeeded. |", text)
        self.assertIn("OK   Triangles: 35,366 / 65,000", text)
        self.assertIn("| CC_Base_Head | 0.000 | 0.912 |", text)
        self.assertIn("| E2E_Patient.fbx | yes | 2 / 0 | 30,000 | 2 | 2 |", text)

    def test_any_failed_step_fails_the_run(self):
        run = self.run_data(status="FAIL")
        self.assertIn("**Overall: FAIL**", self.e2e.render_report(run))
        self.assertEqual(self.e2e.exit_code(run), 1)
        self.assertEqual(self.e2e.exit_code(self.run_data()), 0)

    def test_pipes_in_details_do_not_break_the_table(self):
        run = self.e2e.new_run({})
        self.e2e.record(run, "CC5", "x", False, "a | b\nc", 1.0, "MCP")
        self.assertIn("| a \\| b c |", self.e2e.render_report(run))


class UnityProjectGuardTest(unittest.TestCase):
    def setUp(self):
        self.e2e = load_e2e()
        self.dir = tempfile.mkdtemp()

    def test_an_existing_folder_without_the_marker_is_refused(self):
        error = self.e2e.unity_project_error(self.dir)
        self.assertIn("not a project this script created", error)

    def test_a_missing_folder_or_a_marked_project_is_accepted(self):
        self.assertIsNone(self.e2e.unity_project_error(os.path.join(self.dir, "new")))
        with open(os.path.join(self.dir, self.e2e.PROJECT_MARKER), "w", encoding="utf-8") as f:
            f.write("x")
        self.assertIsNone(self.e2e.unity_project_error(self.dir))


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import _support


def mark_unity_project(project: str) -> str:
    """Write <project>/ProjectSettings/ProjectVersion.txt, the file that makes a folder a Unity project."""
    marker = os.path.join(project, "ProjectSettings", "ProjectVersion.txt")
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, "w", encoding="utf-8") as f:
        f.write("m_EditorVersion: 6000.2.10f1\n")
    return marker


class ExportForUnityTest(unittest.TestCase):
    def setUp(self):
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.root = tempfile.mkdtemp()
        mark_unity_project(os.path.join(self.root, "MyGame"))
        self.assets = os.path.join(self.root, "MyGame", "Assets", "Characters")

    def test_rejects_folder_outside_assets(self):
        r = self.pipe.export_for_unity(os.path.join(self.root, "Elsewhere"), "Patient_01")
        self.assertFalse(r["success"])
        self.assertIn("Assets", r["error"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "Elsewhere")))

    def test_rejects_network_path(self):
        r = self.pipe.export_for_unity("//fileserver/share/Game/Assets/Characters", "P")
        self.assertFalse(r["success"])
        self.assertIn("UNC", r["error"])

    def test_rejects_unsafe_name(self):
        for name in ("Patient 01!", "Patient 01", "Пациент_01", "Patiënt", "", "Patient_01\n", "A" * 65):
            with self.subTest(name=name):
                r = self.pipe.export_for_unity(self.assets, name)
                self.assertFalse(r["success"])
                self.assertIn("letters, digits", r["error"])
                self.assertFalse(os.path.exists(self.assets))

    def test_rejects_traversal(self):
        r = self.pipe.export_for_unity(self.assets + "\\..\\..", "P")
        self.assertFalse(r["success"])

    def test_no_avatar_leaves_no_folder(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=None):
            r = self.pipe.export_for_unity(self.assets, "Patient_01")
        self.assertFalse(r["success"])
        self.assertFalse(os.path.exists(os.path.join(self.assets, "Patient_01")))

    def test_rejects_out_of_range_sub_d_level(self):
        for level in (3, -1, 99):
            with self.subTest(level=level):
                with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                        mock.patch.object(self.pipe.cc5_api, "export_fbx") as exp:
                    r = self.pipe.export_for_unity(self.assets, "Patient_01", sub_d_level=level)
                self.assertFalse(r["success"])
                self.assertIn("sub_d_level", r["error"])
                exp.assert_not_called()
                self.assertFalse(os.path.exists(os.path.join(self.assets, "Patient_01")))

    def test_rejects_unsupported_texture_size(self):
        for size in (7, 0, 300, 8192):
            with self.subTest(size=size):
                with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                        mock.patch.object(self.pipe.cc5_api, "export_fbx") as exp:
                    r = self.pipe.export_for_unity(self.assets, "Patient_01", texture_size=size)
                self.assertFalse(r["success"])
                self.assertIn("texture_size", r["error"])
                exp.assert_not_called()
                self.assertFalse(os.path.exists(os.path.join(self.assets, "Patient_01")))

    def test_exports_into_named_subfolder_with_unity_preset(self):
        def fake_export(path, flags, **kw):
            with open(path, "wb") as f:
                f.write(b"fbx")
            return {"success": True, "path": path, "flags_applied": True, "export_level": 0, "texture_size": 2048,
                    "notes": ["target_tool=Unity preset applied"]}

        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            r = self.pipe.export_for_unity(self.assets, "Patient_01", sub_d_level=0, texture_size=2048)
        self.assertTrue(r["success"])
        self.assertEqual(r["fbx"], os.path.join(self.assets, "Patient_01", "Patient_01.fbx"))
        kwargs = exp.call_args.kwargs
        self.assertEqual(kwargs["target_tool"], "Unity")
        self.assertFalse(kwargs["embed_textures"])
        self.assertFalse(kwargs["export_motion"])
        self.assertEqual(kwargs["texture_size"], 2048)
        # Live CC5 5.13 crashes right after an export with Convert Image Format (Task 18), so it is never asked for.
        self.assertFalse(kwargs.get("convert_image_format", False))
        self.assertIsNone(kwargs.get("motion_range"))
        self.assertFalse(kwargs["allow_fallback"])
        self.assertEqual(r["files"][0]["bytes"], 3)
        self.assertEqual((r["export_level"], r["texture_size"]), (0, 2048))
        self.assertEqual(r["notes"], ["target_tool=Unity preset applied"])

    def test_a_posed_export_carries_the_pose_in_a_one_frame_animation_take(self):
        # Live CC5 5.13 (Task 18): a mesh-only export is in the bind pose whatever pose the scene shows, while a
        # one-frame motion export without the T-pose bit carries the current pose.
        def fake_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": True, "notes": []}

        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()),                 mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            r = self.pipe.export_for_unity(self.assets, "Patient_01", include_current_pose=True)
        self.assertTrue(r["success"])
        kwargs = exp.call_args.kwargs
        self.assertTrue(kwargs["include_current_pose"])
        self.assertTrue(kwargs["export_motion"])
        self.assertEqual(kwargs["motion_range"], [0, 0])

    def _export_with(self, fake_export):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export):
            return self.pipe.export_for_unity(self.assets, "Patient_01", texture_size=2048)

    def test_fails_when_cc5_reports_success_but_writes_no_fbx(self):
        r = self._export_with(lambda path, flags, **kw: {"success": True, "flags_applied": True, "notes": []})
        self.assertFalse(r["success"])
        self.assertIn("did not write", r["error"])

    def test_fails_when_only_an_old_fbx_is_there(self):
        fbx = os.path.join(self.assets, "Patient_01", "Patient_01.fbx")
        os.makedirs(os.path.dirname(fbx))
        with open(fbx, "wb") as f:
            f.write(b"from an earlier run")
        os.utime(fbx, (1_000_000_000, 1_000_000_000))
        r = self._export_with(lambda path, flags, **kw: {"success": True, "flags_applied": True, "notes": []})
        self.assertFalse(r["success"])
        self.assertIn("did not write", r["error"])

    def test_fails_when_the_fbx_settings_were_not_applied(self):
        def fallback_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": False,
                    "notes": ["WARNING: option flags (target-tool preset / axis / etc.) were NOT applied"]}
        r = self._export_with(fallback_export)
        self.assertFalse(r["success"])
        self.assertIn("without the requested FBX settings", r["error"])
        self.assertTrue(r["notes"][0].startswith("WARNING"))

    def test_passes_export_fbx_failure_and_notes_through(self):
        r = self._export_with(lambda path, flags, **kw: {
            "success": False, "error": "ExportFbxFile reported an error status", "notes": ["n"]})
        self.assertEqual(r, {"success": False, "error": "ExportFbxFile reported an error status", "notes": ["n"]})

    # F-76: an Assets folder with no Unity project around it is refused; the export never creates that folder.

    def test_refuses_an_assets_folder_without_a_unity_project(self):
        project = os.path.join(self.root, "NotAProject")
        folder = os.path.join(project, "Assets", "Patients")
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx") as exp:
            r = self.pipe.export_for_unity(folder, "Patient_01")
        marker = os.path.join(project, "ProjectSettings", "ProjectVersion.txt")
        self.assertEqual(r, {"success": False, "error": (
            f"Folder is not inside a Unity project: {folder}. {marker} does not exist (a Unity project has "
            "ProjectSettings\\ProjectVersion.txt beside its Assets folder)")})
        exp.assert_not_called()
        self.assertFalse(os.path.exists(project))

    def test_accepts_a_project_nested_in_another_folders_assets(self):
        inner = os.path.join(self.root, "Outer", "Assets", "Inner")
        mark_unity_project(inner)
        self.assertIsNone(self.pipe.unity_folder_error(os.path.join(inner, "Assets", "Patients")))
        self.assertIsNone(self.pipe.unity_folder_error(self.assets))
        self.assertEqual(self.pipe.unity_folder_error(os.path.join(self.root, "Elsewhere")),
                         f"Folder must be inside a Unity project's Assets folder: {os.path.join(self.root, 'Elsewhere')}")
        # The plain segment check stays as it was (batch.ts and the TS tools still use it for their own checks).
        self.assertTrue(self.pipe.is_in_unity_assets(os.path.join(self.root, "NotAProject", "Assets")))

    def test_refusal_names_the_innermost_missing_marker(self):
        folder = os.path.join(self.root, "A", "Assets", "B", "Assets", "C")
        error = self.pipe.unity_folder_error(folder)
        self.assertIn(os.path.join(self.root, "A", "Assets", "B", "ProjectSettings", "ProjectVersion.txt") + " does not "
                      "exist", error)
        # An enclosing project counts too.
        mark_unity_project(os.path.join(self.root, "A"))
        self.assertIsNone(self.pipe.unity_folder_error(folder))

    def test_remove_tearline_occlusion_is_passed_only_when_asked(self):
        def fake_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": True, "notes": []}

        for asked in (False, True):
            with self.subTest(asked=asked), \
                    mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                    mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
                r = self.pipe.export_for_unity(self.assets, "Patient_01", remove_tearline_occlusion=asked)
            self.assertIs(exp.call_args.kwargs["remove_tearline_occlusion"], asked)
            self.assertIs(r["remove_tearline_occlusion"], asked)
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            self.pipe.export_for_unity(self.assets, "Patient_02")
        self.assertIs(exp.call_args.kwargs["remove_tearline_occlusion"], False)

    def test_an_export_reports_injuries_even_when_there_are_none(self):
        def fake_export(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": True, "notes": []}

        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export):
            r = self.pipe.export_for_unity(self.assets, "Patient_01")
        self.assertTrue(r["success"])
        self.assertEqual({k: r["injuries"][k] for k in ("choice", "not_carried", "unverified", "done", "failed")},
                         {"choice": None, "not_carried": [], "unverified": [], "done": [], "failed": []})

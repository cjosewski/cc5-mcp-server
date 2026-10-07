from __future__ import annotations

import importlib
import os
import re
import tempfile
import unittest
from unittest import mock

import _support


class ExportFbxTest(unittest.TestCase):
    """cc5_api.export_fbx: RStatus checks, the flags-overload fallback, and the texture-size enum."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        # export_fbx ORs RLPy flag enums together; give every one it names a real int.
        with open(os.path.join(_support.PLUGIN_DIR, "cc5_api.py"), encoding="utf-8") as f:
            names = sorted(set(re.findall(r"EExportFbxOptions\w+", f.read())))
        for i, name in enumerate(names):
            setattr(self.rl, name, 1 << (i % 30))
        self.api = _support.fresh_import("cc5_api")
        self.setting = self.rl.RExportFbxSetting.return_value
        self.export = self.rl.RFileIO.ExportFbxFile
        self.fbx = os.path.join(tempfile.mkdtemp(), "P.fbx")
        self.avatar = mock.MagicMock()
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_texture_size_is_passed_as_the_enum(self):
        self.rl.EExportTextureSize_Size_2048 = 4
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", texture_size=2048)
        self.setting.SetTextureSize.assert_called_once_with(self.rl.EExportTextureSize_Size_2048)
        self.assertEqual(r["texture_size"], 2048)

    def test_texture_size_zero_means_original(self):
        self.rl.EExportTextureSize_Original = 0
        self.api.export_fbx(self.fbx, 0, texture_size=0)
        self.setting.SetTextureSize.assert_called_once_with(self.rl.EExportTextureSize_Original)

    def test_unknown_texture_size_is_a_warning_not_a_raw_pixel_count(self):
        r = self.api.export_fbx(self.fbx, 0, texture_size=300)
        self.setting.SetTextureSize.assert_not_called()
        self.assertNotIn("texture_size", r)
        self.assertTrue(any(n.startswith("WARNING") and "300px" in n for n in r["notes"]))

    def test_error_status_from_the_settings_export_fails_without_a_2_arg_retry(self):
        self.export.return_value.IsError.return_value = True
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity")
        self.assertFalse(r["success"])
        self.assertIn("ExportFbxFile reported an error status", r["error"])
        self.assertEqual(self.export.call_count, 1)

    def test_without_fallback_a_settings_failure_fails_the_export(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertIn("requested FBX settings", r["error"])
        self.export.assert_not_called()

    def test_by_default_a_settings_failure_falls_back_to_the_flags_overload(self):
        # Live CC5 5.13 has no 2-argument ExportFbxFile(obj, path) (TypeError). Its other overload is
        # ExportFbxFile(obj, path, EExportFbxOptions, EExportFbxOptions2, EExportFbxOptions3).
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", texture_size=1024)
        self.assertTrue(r["success"])
        self.assertTrue(r["flags_applied"])
        self.export.assert_called_once()
        avatar, path, flags, flags2, flags3 = self.export.call_args.args
        self.assertEqual((path, flags, flags2, flags3), (self.fbx, r["flags"], r["flags2"], r["flags3"]))
        self.assertNotEqual(flags2, 0)  # the Unity preset bits reach CC5
        self.assertFalse(any(n.startswith("WARNING: option flags") for n in r["notes"]))
        self.assertTrue(any(n.startswith("WARNING") and "texture" in n for n in r["notes"]))
        self.assertNotIn("texture_size", r)

    def test_flags_fallback_keeps_flag_based_texture_options(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, embed_textures=True)
        self.assertTrue(r["embed_textures"])
        flags = self.export.call_args.args[2]
        self.assertTrue(flags & self.rl.EExportFbxOptions_EmbedTexture)

    def test_convert_image_format_is_refused_before_any_export(self):
        # Live CC5 5.13 (Task 18): every scripted export with Convert Image Format, with the Unity or the default
        # preset, wrote an ASCII FBX with a .json sidecar and PBR-split textures, then crashed CC5 (7 of 7).
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", convert_image_format=True)
        self.assertFalse(r["success"])
        self.assertIn("Convert Image Format", r["error"])
        self.assertIn("crash", r["error"])
        self.rl.RExportFbxSetting.assert_not_called()
        self.export.assert_not_called()

    def test_keeping_the_current_pose_clears_the_t_pose_bit(self):
        # export_for_unity's posed export (one frame of motion) depends on this to carry the pose.
        tpose = self.rl.EExportFbxOptions_TPoseOnMotionFirstFrame
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=True)
        self.assertTrue(self.setting.SetOption.call_args.args[0] & tpose)
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=True, include_current_pose=True,
                                motion_range=[0, 0])
        self.assertFalse(self.setting.SetOption.call_args.args[0] & tpose)
        self.assertEqual(r["motion_range"], [0, 0])

    def test_sub_d_level_above_the_characters_highest_level_is_refused(self):
        # Live CC5 5.13: the neutral CC3_Base_Plus reports GetMaxSubdivMeshLevel() == 0.
        self.avatar.GetMaxSubdivMeshLevel.return_value = 0
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", sub_d_level=1)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "sub_d_level 1 is above this character's highest subdivision level (0). "
                                     "Export with sub_d_level 0, or add subdivision (HD) levels to the character "
                                     "in Character Creator 5 first.")
        self.export.assert_not_called()

    def test_sub_d_level_within_the_characters_levels_is_set(self):
        self.avatar.GetMaxSubdivMeshLevel.return_value = 2
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", sub_d_level=1)
        self.assertTrue(r["success"])
        self.setting.SetExportLevel.assert_called_once_with(1)
        self.assertEqual(r["export_level"], 1)

    def test_error_status_from_the_flags_fallback_fails(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        self.export.return_value.IsError.return_value = True
        r = self.api.export_fbx(self.fbx, 0)
        self.assertFalse(r["success"])
        self.assertIn("ExportFbxFile reported an error status", r["error"])

    # F-86 (live CC5 5.13): an FBX export clears CC5's undo history, and undo still reports success afterwards.

    def test_a_successful_export_says_it_cleared_cc5s_undo_history(self):
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity")
        self.assertIs(r["undo_history_cleared"], True)
        self.assertFalse(any("undo" in n.lower() for n in r["notes"]))  # a field, not a note
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0)  # the flags fallback
        self.assertTrue(r["success"])
        self.assertIs(r["undo_history_cleared"], True)

    def test_a_failure_before_any_export_call_does_not_say_so(self):
        # Nothing reached CC5's exporter and no timeline setter ran: the undo history is still there.
        self.avatar.GetMaxSubdivMeshLevel.return_value = 0
        for kwargs in ({"convert_image_format": True}, {"sub_d_level": 1}):
            with self.subTest(**kwargs):
                r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", **kwargs)
                self.assertFalse(r["success"])
                self.assertNotIn("undo_history_cleared", r)
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertNotIn("undo_history_cleared", r)
        self.export.assert_not_called()

    def test_a_failed_export_call_says_cc5_may_have_cleared_its_undo_history(self):
        # P-5: once ExportFbxFile was called, the history may be gone, whether the call then reported an error status
        # or raised. The cautious choice: a false warning costs a save_character, a missed one the user's work.
        self.export.return_value.IsError.return_value = True
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity")
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "ExportFbxFile reported an error status")  # the sentence is the action's to add
        self.assertIs(r["undo_history_cleared"], True)
        self.export.return_value.IsError.return_value = False
        self.export.side_effect = RuntimeError("CC5 could not write the file")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "CC5 could not export with the requested FBX settings: CC5 could not write the "
                                     "file")
        self.assertIs(r["undo_history_cleared"], True)
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity")  # the flags fallback raises too
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "CC5 could not write the file")
        self.assertIs(r["undo_history_cleared"], True)


class _Time:
    """An RLPy.RTime. CC5 counts 6,000 per second, so one frame at 60 fps is 100.0."""

    def __init__(self, value):
        self.value = float(value)

    def ToFloat(self):
        return self.value


class OneFrameTimelineTest(unittest.TestCase):
    """F-82 (live CC5 5.13): apply_pose sets the project length and end time to 0, and a mesh-only FBX export then writes
    a zero-length "Default" take that Unity warns about. A mesh-only export runs with a one-frame timeline, set back
    afterwards."""

    LENGTHENED = [("SetProjectLength", 100.0), ("SetEndTime", 100.0)]
    RESTORED = [("SetEndTime", 0.0), ("SetProjectLength", 0.0)]

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        with open(os.path.join(_support.PLUGIN_DIR, "cc5_api.py"), encoding="utf-8") as f:
            names = sorted(set(re.findall(r"EExportFbxOptions\w+", f.read())))
        for i, name in enumerate(names):
            setattr(self.rl, name, 1 << (i % 30))
        self.api = _support.fresh_import("cc5_api")
        self.setting = self.rl.RExportFbxSetting.return_value
        self.fbx = os.path.join(tempfile.mkdtemp(), "P.fbx")
        p = mock.patch.object(self.api, "get_first_avatar", return_value=mock.MagicMock())
        p.start()
        self.addCleanup(p.stop)
        self.events: list = []
        self.timeline = {"length": 0.0, "end": 0.0}  # live, after apply_pose: both read 0.0
        self.export_errors: dict = {}  # number of ExportFbxFile arguments -> what that overload raises
        g = self.rl.RGlobal
        g.GetFps.return_value.IndexedFrameTime.side_effect = lambda n: _Time(100.0 * n)
        g.GetProjectLength.side_effect = lambda: _Time(self.timeline["length"])
        g.GetEndTime.side_effect = lambda: _Time(self.timeline["end"])
        g.SetProjectLength.side_effect = lambda t: self._set("SetProjectLength", "length", t)
        g.SetEndTime.side_effect = lambda t: self._set("SetEndTime", "end", t)
        self.rl.RFileIO.ExportFbxFile.side_effect = self._export

    def _set(self, name, key, t):
        self.events.append((name, t.ToFloat()))
        self.timeline[key] = t.ToFloat()

    def _export(self, *args):
        # 3 arguments: the RExportFbxSetting overload; 5: the flags overload.
        self.events.append(("ExportFbxFile", len(args)))
        if len(args) in self.export_errors:
            raise self.export_errors[len(args)]
        return mock.DEFAULT

    def test_a_mesh_only_export_of_a_0_frame_timeline_runs_with_one_frame_and_sets_it_back(self):
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, self.LENGTHENED + [("ExportFbxFile", 3)] + self.RESTORED)
        self.assertEqual(self.timeline, {"length": 0.0, "end": 0.0})
        self.assertIn(self.api.TIMELINE_LENGTHENED_NOTE, r["notes"])
        self.assertEqual(self.api.TIMELINE_LENGTHENED_NOTE,
                         "CC5's timeline was 0 frames long (applying a pose file sets it so); it was set to one frame "
                         "for this export and restored afterwards, so the FBX's animation take is not empty (F-82)")

    def test_a_timeline_of_one_frame_is_left_alone(self):
        self.timeline = {"length": 100.0, "end": 100.0}  # live: a standing character
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, [("ExportFbxFile", 3)])
        self.assertNotIn(self.api.TIMELINE_LENGTHENED_NOTE, r["notes"])

    def test_an_export_with_motion_is_left_alone(self):
        # include_current_pose exports a one-frame take of its own (motion_range [0, 0]).
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=True, include_current_pose=True,
                                motion_range=[0, 0])
        self.assertTrue(r["success"])
        self.assertEqual(self.events, [("ExportFbxFile", 3)])
        self.rl.RGlobal.GetEndTime.assert_not_called()
        self.assertNotIn(self.api.TIMELINE_LENGTHENED_NOTE, r["notes"])

    def test_the_timeline_is_set_back_when_the_export_raises(self):
        self.export_errors[3] = RuntimeError("CC5 could not export")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False, allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertEqual(self.events, self.LENGTHENED + [("ExportFbxFile", 3)] + self.RESTORED)
        self.assertEqual(self.timeline, {"length": 0.0, "end": 0.0})

    # F-86 (DT-1): the F-86 probe found that SetProjectLength / SetEndTime alone (set and restored, as this guard does)
    # clear CC5's undo history: six undos left a light change in place. A posed export that then fails says so too.

    def test_a_posed_mesh_only_export_that_fails_says_the_undo_history_is_gone(self):
        self.export_errors[3] = RuntimeError("CC5 could not export")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False, allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "CC5 could not export with the requested FBX settings: CC5 could not export")
        self.assertIs(r["undo_history_cleared"], True)
        self.export_errors.clear()
        self.rl.RFileIO.ExportFbxFile.return_value.IsError.return_value = True  # CC5 ran it and reported an error
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False, allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "ExportFbxFile reported an error status")
        self.assertIs(r["undo_history_cleared"], True)
        self.assertEqual(self.timeline, {"length": 0.0, "end": 0.0})

    def test_the_guard_records_that_it_changed_the_timeline(self):
        # The flag follows SetProjectLength, whatever the export inside the guard then does.
        history = {"cleared": False}
        with self.api._one_frame_timeline_for_export([], history):
            self.assertIs(history["cleared"], True)
        self.assertEqual(self.events, self.LENGTHENED + self.RESTORED)
        self.timeline = {"length": 100.0, "end": 100.0}  # one frame: left alone
        history = {"cleared": False}
        with self.api._one_frame_timeline_for_export([], history):
            pass
        self.assertIs(history["cleared"], False)
        self.timeline = {"length": 0.0, "end": 0.0}
        self.rl.RGlobal.SetProjectLength.side_effect = RuntimeError("SWIG")  # nothing was changed
        with self.api._one_frame_timeline_for_export([], history):
            pass
        self.assertIs(history["cleared"], False)

    def test_export_for_unity_passes_on_the_flag_of_a_posed_export_that_failed(self):
        # DT-1's scenario: apply_pose left the timeline at 0 frames, export_for_unity runs mesh-only (no
        # include_current_pose) and CC5 reports an error status. The reply's undo line comes from this flag.
        pipe = importlib.import_module("cc5_pipeline")  # imported here, so it uses this test's cc5_api
        root = tempfile.mkdtemp()
        marker = os.path.join(root, "ProjectSettings", "ProjectVersion.txt")
        os.makedirs(os.path.dirname(marker))
        with open(marker, "w", encoding="utf-8") as f:
            f.write("m_EditorVersion: 6000.2.10f1\n")
        self.rl.RFileIO.ExportFbxFile.return_value.IsError.return_value = True
        r = pipe.export_for_unity(os.path.join(root, "Assets", "Patients"), "P1")
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "ExportFbxFile reported an error status")  # no sentence: unity.ts adds the line
        self.assertIs(r["undo_history_cleared"], True)
        self.assertEqual(self.events, self.LENGTHENED + [("ExportFbxFile", 3)] + self.RESTORED)

    def test_the_flags_fallback_runs_with_one_frame_too(self):
        self.setting.SetOption.side_effect = TypeError("in method 'RExportFbxSetting_SetOption'")
        r = self.api.export_fbx(self.fbx, 0, export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, self.LENGTHENED + [("ExportFbxFile", 5)] + self.RESTORED)
        self.assertEqual(r["notes"].count(self.api.TIMELINE_LENGTHENED_NOTE), 1)

    def test_a_settings_export_that_raises_is_set_back_before_the_fallback_and_noted_once(self):
        self.export_errors[3] = TypeError("in method 'RFileIO_ExportFbxFile'")
        r = self.api.export_fbx(self.fbx, 0, export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, self.LENGTHENED + [("ExportFbxFile", 3)] + self.RESTORED
                         + self.LENGTHENED + [("ExportFbxFile", 5)] + self.RESTORED)
        self.assertEqual(r["notes"].count(self.api.TIMELINE_LENGTHENED_NOTE), 1)

    # X-2: a timeline that could not be lengthened is a problem with the FBX (re-export it); one that could not be set
    # back is a problem with the scene's timeline only, and has its own prefix. Its note never calls the FBX usable:
    # it is written whether or not the export worked (the tools add TIMELINE_USABLE_LINE after one that did).
    LENGTHEN_FAILED = ("WARNING: could not lengthen the 0-frame timeline ({}); the FBX may carry an empty animation "
                       "take: set the timeline's length to at least one frame in Character Creator 5, then re-export")

    def test_a_setter_that_fails_is_a_warning_and_the_export_still_runs(self):
        self.rl.RGlobal.SetProjectLength.side_effect = RuntimeError("SWIG: bad RTime")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, [("ExportFbxFile", 3)])
        self.assertIn(self.LENGTHEN_FAILED.format("SWIG: bad RTime"), r["notes"])
        self.assertNotIn(self.api.TIMELINE_LENGTHENED_NOTE, r["notes"])
        self.assertFalse(any(n.startswith(self.api.TIMELINE_NOT_RESTORED_PREFIX) for n in r["notes"]))

    def test_a_failed_end_time_setter_still_sets_the_project_length_back(self):
        self.rl.RGlobal.SetEndTime.side_effect = RuntimeError("SWIG")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, [("SetProjectLength", 100.0), ("ExportFbxFile", 3), ("SetProjectLength", 0.0)])
        self.assertIn(self.LENGTHEN_FAILED.format("SWIG"), r["notes"])

    def test_a_timeline_that_cannot_be_read_is_a_warning_and_the_export_still_runs(self):
        self.rl.RGlobal.GetFps.side_effect = RuntimeError("no frame rate")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        self.assertEqual(self.events, [("ExportFbxFile", 3)])
        self.assertTrue(any(n.startswith("WARNING: could not lengthen the 0-frame timeline (no frame rate)")
                            for n in r["notes"]))

    def test_a_timeline_that_cannot_be_set_back_is_a_warning(self):
        def set_end(t):
            if t.ToFloat() == 0.0:  # the restore
                raise RuntimeError("SWIG")
            self._set("SetEndTime", "end", t)

        self.rl.RGlobal.SetEndTime.side_effect = set_end
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        # The prefix the TypeScript tools look for (TIMELINE_NOT_RESTORED_PREFIX in src/tools/unity.ts).
        self.assertEqual(self.api.TIMELINE_NOT_RESTORED_PREFIX, "WARNING: CC5 timeline not restored: ")
        self.assertIn("WARNING: CC5 timeline not restored: it was set to one frame for this export and could not be "
                      "set back (end time: SWIG); set the timeline's length in Character Creator 5", r["notes"])
        self.assertNotIn(self.api.TIMELINE_LENGTHENED_NOTE, r["notes"])
        self.assertEqual(self.timeline["length"], 0.0)  # the project length still went back

    def test_both_restore_failures_are_named_in_the_one_note(self):
        def set_back_fails(name, key):
            def setter(t):
                if t.ToFloat() == 0.0:  # the restore
                    raise RuntimeError(f"{name} SWIG")
                self._set(name, key, t)
            return setter

        self.rl.RGlobal.SetEndTime.side_effect = set_back_fails("SetEndTime", "end")
        self.rl.RGlobal.SetProjectLength.side_effect = set_back_fails("SetProjectLength", "length")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False)
        self.assertTrue(r["success"])
        restored = [n for n in r["notes"] if n.startswith(self.api.TIMELINE_NOT_RESTORED_PREFIX)]
        self.assertEqual(restored, ["WARNING: CC5 timeline not restored: it was set to one frame for this export and "
                                    "could not be set back (end time: SetEndTime SWIG; project length: "
                                    "SetProjectLength SWIG); set the timeline's length in Character Creator 5"])
        self.assertIs(r["undo_history_cleared"], True)

    def test_a_failed_export_whose_timeline_was_not_set_back_never_calls_the_fbx_usable(self):
        # A failed export_for_unity and job_status show the plugin's notes as they are, so the note must not say the
        # FBX is usable when there may be none.
        def set_end(t):
            if t.ToFloat() == 0.0:  # the restore
                raise RuntimeError("SWIG")
            self._set("SetEndTime", "end", t)

        self.rl.RGlobal.SetEndTime.side_effect = set_end
        self.export_errors[3] = RuntimeError("CC5 could not export")
        r = self.api.export_fbx(self.fbx, 0, target_tool="Unity", export_motion=False, allow_fallback=False)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "CC5 could not export with the requested FBX settings: CC5 could not export")
        restored = [n for n in r["notes"] if n.startswith(self.api.TIMELINE_NOT_RESTORED_PREFIX)]
        self.assertEqual(restored, ["WARNING: CC5 timeline not restored: it was set to one frame for this export and "
                                    "could not be set back (end time: SWIG); set the timeline's length in Character "
                                    "Creator 5"])
        self.assertFalse(any("usable" in n for n in r["notes"]))
        self.assertIs(r["undo_history_cleared"], True)
        self.assertEqual(self.timeline["length"], 0.0)  # the project length still went back


class UndoHistoryPassThroughTest(unittest.TestCase):
    """F-86: export_for_unity passes export_fbx's undo_history_cleared on, also from an export that ran and then failed
    a check (the history is gone either way)."""

    def setUp(self):
        _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        root = tempfile.mkdtemp()
        marker = os.path.join(root, "ProjectSettings", "ProjectVersion.txt")
        os.makedirs(os.path.dirname(marker))
        with open(marker, "w", encoding="utf-8") as f:
            f.write("m_EditorVersion: 6000.2.10f1\n")
        self.unity_dir = os.path.join(root, "Assets", "Patients")
        p = mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock())
        p.start()
        self.addCleanup(p.stop)

    def _export(self, result, write=True):
        def fake(path, flags, **kw):
            if write:
                open(path, "wb").close()
            return dict(result)

        with mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake):
            return self.pipe.export_for_unity(self.unity_dir, "P1")

    def test_a_successful_export_passes_the_flag_on(self):
        r = self._export({"success": True, "flags_applied": True, "notes": [], "undo_history_cleared": True})
        self.assertTrue(r["success"])
        self.assertIs(r["undo_history_cleared"], True)

    def test_an_export_fbx_without_the_flag_passes_false(self):
        r = self._export({"success": True, "flags_applied": True, "notes": []})
        self.assertTrue(r["success"])
        self.assertIs(r["undo_history_cleared"], False)

    def test_an_export_that_ran_but_wrote_no_fbx_still_says_so(self):
        r = self._export({"success": True, "flags_applied": True, "notes": [], "undo_history_cleared": True},
                         write=False)
        self.assertFalse(r["success"])
        self.assertIn("did not write", r["error"])
        self.assertIs(r["undo_history_cleared"], True)

    def test_a_failed_export_does_not(self):
        r = self._export({"success": False, "error": "ExportFbxFile reported an error status", "notes": []})
        self.assertEqual(r, {"success": False, "error": "ExportFbxFile reported an error status", "notes": []})

    def test_a_failed_export_that_may_have_cleared_the_history_passes_the_flag_on(self):
        # P-5: the flag, not the sentence: the TypeScript reply adds the undo line from it (it would show twice).
        r = self._export({"success": False, "error": "ExportFbxFile reported an error status", "notes": [],
                          "undo_history_cleared": True}, write=False)
        self.assertEqual(r, {"success": False, "error": "ExportFbxFile reported an error status", "notes": [],
                             "undo_history_cleared": True})

    def test_export_textures_passes_the_flag_on_too(self):
        def fake(path, flags, **kw):
            open(path, "wb").close()
            return {"success": True, "flags_applied": True, "notes": [], "undo_history_cleared": True}

        with mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake):
            r = self.pipe.export_textures(tempfile.mkdtemp(), "P1")
        self.assertTrue(r["success"])
        self.assertIs(r["undo_history_cleared"], True)


class ExportFbxActionTest(unittest.TestCase):
    """P-5: the export_fbx tool reads a failed export's HTTP 400 for its `error` only, so the export_fbx action
    (server.ACTION_MAP, and the copy cc5_api._auto_patch_server installs on /reload) adds the undo sentence there when
    the failure says CC5's undo history may be gone. export_fbx itself does not: export_for_unity and export_textures
    print the line from the flag."""

    # UNDO_HISTORY_CLEARED in src/tools/unity.ts.
    SENTENCE = ("CC5 cleared its undo history with this export: changes made before it can no longer be undone "
                "(save_character first to keep a way back).")

    def setUp(self):
        _support.install_fake_rlpy()
        self.srv = _support.fresh_import("server")
        self.api = self.srv.cc5_api

    def _actions(self):
        """server.py's own export_fbx action, then the one a /reload installs."""
        yield "server", self.srv.ACTION_MAP["export_fbx"]
        self.api._auto_patch_server()
        yield "cc5_api", self.srv.ACTION_MAP["export_fbx"]

    def _run(self, action, result):
        with mock.patch.object(self.api, "export_fbx", return_value=dict(result)) as export:
            out = action({"output_path": "P.fbx", "export_motion": False})
        export.assert_called_once()
        self.assertIs(export.call_args.kwargs["export_motion"], False)
        return out

    def test_the_sentence_is_the_typescript_one(self):
        self.assertEqual(self.api.UNDO_HISTORY_CLEARED, self.SENTENCE)

    def test_a_failure_that_may_have_cleared_the_history_says_so_in_its_error(self):
        for module, action in self._actions():
            with self.subTest(action=module):
                self.assertEqual(action.__module__, module)
                out = self._run(action, {"success": False, "error": "ExportFbxFile reported an error status",
                                         "notes": ["n"], "undo_history_cleared": True})
                self.assertEqual(out, {"success": False, "notes": ["n"], "undo_history_cleared": True,
                                       "error": f"ExportFbxFile reported an error status\n{self.SENTENCE}"})

    def test_other_results_are_left_alone(self):
        unchanged = ({"success": False, "error": "Output path must end with .fbx"},
                     {"success": False, "error": "x", "notes": [], "undo_history_cleared": False},
                     {"success": True, "path": "P.fbx", "notes": [], "undo_history_cleared": True})
        for module, action in self._actions():
            for result in unchanged:
                with self.subTest(action=module, result=result):
                    self.assertEqual(self._run(action, result), result)

    def test_the_sentence_is_added_once_and_the_export_result_is_not_changed(self):
        failed = {"success": False, "error": "boom", "undo_history_cleared": True}
        once = self.api.with_undo_history_sentence(failed)
        self.assertEqual(once["error"], f"boom\n{self.SENTENCE}")
        self.assertEqual(self.api.with_undo_history_sentence(once), once)
        self.assertEqual(failed["error"], "boom")


if __name__ == "__main__":
    unittest.main()

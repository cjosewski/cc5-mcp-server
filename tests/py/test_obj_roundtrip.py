"""F-83: the OBJ round trip (export_obj, sculpt, replace_mesh_from_obj) in CC5's T-pose."""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from unittest import mock

import _support

BODY, TONGUE = "CC_Base_Body", "CC_Base_Tongue"
# Live CC5 5.13 (F-83 probe): without EExport3DFileOption_ResetToBindPose, ExportObjFile writes CC5's T-pose (arms
# horizontal, fingertips at x +-88.6 cm); with it, the bind pose (arms about 30 degrees down, x +-79.6 cm).
T_POSE = [(88.6, 140.0, 0.0), (-88.6, 140.0, 0.0), (0.0, 170.0, 0.0), (0.0, 90.0, 0.0)]
BIND_POSE = [(79.6, 112.5, 0.0), (-79.6, 112.5, 0.0), (0.0, 170.0, 0.0), (0.0, 90.0, 0.0)]
TONGUE_VERTICES = [(0.0, 160.0, 2.0), (0.5, 160.0, 2.5), (-0.5, 160.0, 2.5)]
BITS = {"EExport3DFileOption_FullBodyPart": 1, "EExport3DFileOption_AllClothes": 2,
        "EExport3DFileOption_ResetToBindPose": 4, "EExport3DFileOption_ExportMaterial": 8,
        "EExport3DFileOption_AxisYUp": 16}
ONE_FRAME = 100.0  # RTime units: CC5 counts 6,000 per second, so one frame at 60 fps


def write_obj(path, groups):
    """An OBJ laid out as CC5 writes it: each group's vertices, then its "g <name>" line, then its faces."""
    lines, first = ["# laid out like CC5 5.13's ExportObjFile"], 1
    for name, vertices in groups:
        lines += [f"v {x} {y} {z}" for x, y, z in vertices]
        lines += [f"g {name}", "f " + " ".join(str(first + i) for i in range(len(vertices)))]
        first += len(vertices)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path


def write_name_first_obj(path, groups, keyword="o"):
    """An OBJ laid out as Blender (and most other tools) write it: each object's "o <name>" (or "g <name>") line first,
    then its vertices, texture coordinate and normal, then its face in the v/vt/vn form."""
    lines, first = ["# Blender 4.2.0", "mtllib TestPatient.mtl"], 1
    for number, (name, vertices) in enumerate(groups, 1):
        lines += [f"{keyword} {name}"] + [f"v {x} {y} {z}" for x, y, z in vertices]
        lines += ["vt 0.5 0.5", "vn 0.0 1.0 0.0", "s 1", "usemtl Std_Skin_Body"]
        lines.append("f " + " ".join(f"{first + i}/{number}/{number}" for i in range(len(vertices))))
        first += len(vertices)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path


def group_vertices(path, group):
    """The fake CC5's own OBJ reading, written apart from read_obj_groups: the vertices the faces after a "g"/"o" line
    naming `group` use (a face counts its vertices from 1, or back from the latest one when negative), else those of
    the file's only group."""
    points, faces, name = [], {}, ""
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v":
                points.append(tuple(float(c) for c in parts[1:4]))
            elif parts[0] in ("g", "o"):
                name = " ".join(parts[1:])
            elif parts[0] == "f":
                for ref in parts[1:]:
                    n = int(ref.split("/")[0])
                    faces.setdefault(name, set()).add(n - 1 if n > 0 else len(points) + n)
    used = faces[group] if group in faces else next(iter(faces.values()))
    return [points[i] for i in sorted(used)]


class _Time:
    """An RLPy.RTime."""

    def __init__(self, value):
        self.value = float(value)

    def ToFloat(self):
        return self.value


class _Clip:
    """An RLPy.RIClip of `length` RTime units."""

    def __init__(self, length):
        self.length = length

    def GetClipLength(self):
        return _Time(self.length)


class FakeCC5:
    """What replace_mesh_from_obj touches: Kevin's rest shape (kept in the T-pose), his motion clips, OBJ export,
    ReplaceMesh, and one undo step per BeginAction."""

    def __init__(self, rl):
        self.mesh = {TONGUE: list(TONGUE_VERTICES), BODY: list(T_POSE)}
        self.clips = [_Clip(ONE_FRAME)]  # live: a freshly loaded character's one-frame arms-down stance
        self.events: list = []
        self.options: list = []  # the option of every ExportObjFile call
        self.failing_exports: set = set()  # 1-based numbers of the ExportObjFile calls that fail
        self.misread_cm = 0.0  # how far CC5 moves every vertex it reads in ReplaceMesh
        self.ignores_replace = False  # P-3: ReplaceMesh reports OK and leaves the mesh as it was
        self.snapshots: list = []
        self.avatar = mock.MagicMock(name="Kevin")
        self.avatar.GetName.return_value = "Kevin"
        self.avatar.GetMeshNames.return_value = [TONGUE, BODY, "Boxers"]
        self.avatar.ReplaceMesh.side_effect = self.replace_mesh
        self.skeleton = self.avatar.GetSkeletonComponent.return_value
        self.skeleton.GetClipCount.side_effect = lambda: len(self.clips)
        self.skeleton.GetClip.side_effect = lambda i: self.clips[i]
        self.skeleton.DeleteClip.side_effect = self.delete_clip
        g = rl.RGlobal
        g.GetFps.return_value.IndexedFrameTime.side_effect = lambda n: _Time(ONE_FRAME * n)
        g.BeginAction.side_effect = self.begin_action
        g.EndAction.side_effect = lambda: self.events.append(("EndAction",))
        g.ObjectModified.side_effect = lambda *a: self.events.append(("ObjectModified",))
        g.Undo.side_effect = self.undo
        rl.RFileIO.ExportObjFile.side_effect = self.export_obj
        for name, bit in BITS.items():
            setattr(rl, name, bit)

    def begin_action(self, name):
        self.events.append(("BeginAction", name))
        self.snapshots.append(({k: list(v) for k, v in self.mesh.items()}, list(self.clips)))

    def undo(self):
        self.events.append(("Undo",))
        self.mesh, self.clips = self.snapshots.pop()

    def delete_clip(self, clip):
        self.events.append(("DeleteClip", self.clips.index(clip)))
        self.clips.remove(clip)

    def export_obj(self, avatar, path, option):
        # Live: the T-pose, whatever pose the scene shows (the tests never ask for ResetToBindPose).
        self.options.append(option)
        self.events.append(("ExportObjFile",))
        if len(self.options) in self.failing_exports:
            raise RuntimeError("ExportObjFile reported an error status")
        write_obj(path, [(TONGUE, self.mesh[TONGUE]), (BODY, self.mesh[BODY])])

    def replace_mesh(self, mesh_name, obj_path, split_objects, auto_rig):
        # Live (F-83): CC5 reads the OBJ as the mesh in the character's CURRENT pose, so with a pose clip left the rest
        # shape comes out wrecked (here: 50 cm off).
        self.events.append(("ReplaceMesh", mesh_name))
        if self.ignores_replace:
            return
        offset = self.misread_cm + (50.0 if self.clips else 0.0)
        self.mesh[mesh_name] = [(x + offset, y, z) for x, y, z in group_vertices(obj_path, mesh_name)]


class ReadObjGroupsTest(unittest.TestCase):
    """read_obj_groups and compare_vertices: pure helpers, no RLPy."""

    def setUp(self):
        _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write(self, text):
        path = os.path.join(self.dir, "m.obj")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def test_cc5s_layout_gives_each_group_the_vertices_its_faces_use(self):
        # Live CC5 5.13: a group's vertices first, then its "g <name>" line, then its faces.
        path = self.write("mtllib m.mtl\nv 1 2 3\nv 4 5 6\nvt 0.5 0.5\nvn 0 1 0\ng CC_Base_Tongue\nusemtl Std_Tongue\n"
                          "f 1 2 1\nv 7 8 9\ng CC_Base_Body\ns 1\nf 3 3 3\n")
        self.assertEqual(self.pipe.read_obj_groups(path), {
            "CC_Base_Tongue": [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)], "CC_Base_Body": [(7.0, 8.0, 9.0)]})

    def test_a_name_first_file_gives_each_object_its_own_vertices(self):
        # P-2: Blender and most other tools write the name first ("o <name>", or "g <name>" with object groups), then
        # the object's vertices and faces. Before, each object got the vertices of the object before it.
        for keyword in ("o", "g"):
            with self.subTest(keyword=keyword):
                path = self.write(
                    f"# Blender 4.2.0\nmtllib m.mtl\n{keyword} CC_Base_Tongue\nv 1 2 3\nv 4 5 6\nvt 0.5 0.5\nvn 0 1 0\n"
                    f"s 1\nusemtl Std_Tongue\nf 1/1/1 2/1/1 1/1/1\n{keyword} CC_Base_Body\nv 7 8 9\nv 10 11 12\n"
                    "vt 0.5 0.5\nvn 0 1 0\nusemtl Std_Skin_Body\nf 3/2/2 4/2/2 3/2/2\n")
                self.assertEqual(self.pipe.read_obj_groups(path), {
                    "CC_Base_Tongue": [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)],
                    "CC_Base_Body": [(7.0, 8.0, 9.0), (10.0, 11.0, 12.0)]})

    def test_faces_before_any_group_line_go_to_an_unnamed_group_in_vertex_order(self):
        path = self.write("v 1 2 3\nv 4 5 6 1.0\nv 7 8 9\nf 3 1 2\n")
        self.assertEqual(self.pipe.read_obj_groups(path), {"": [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0), (7.0, 8.0, 9.0)]})

    def test_every_face_reference_form_and_negative_numbers(self):
        # v, v/vt, v//vn and v/vt/vn; a negative number counts back from the latest vertex (-1 is the one just read).
        path = self.write("g A\nv 1 1 1\nv 2 2 2\nv 3 3 3\nvt 0 0\nvn 0 1 0\nf 1 2/1 3//1\ng B\nv 4 4 4\nv 5 5 5\n"
                          "v 6 6 6\nf -3/1/1 -2 -1//1\nf -1 6/1/1 5\n")
        self.assertEqual(self.pipe.read_obj_groups(path), {
            "A": [(1.0, 1.0, 1.0), (2.0, 2.0, 2.0), (3.0, 3.0, 3.0)],
            "B": [(4.0, 4.0, 4.0), (5.0, 5.0, 5.0), (6.0, 6.0, 6.0)]})

    def test_a_name_that_comes_back_adds_to_its_group_and_a_name_without_faces_is_no_group(self):
        # Maya writes "g default" before the vertices; a vertex no face uses belongs to no group.
        path = self.write("g default\nv 1 1 1\nv 2 2 2\nv 3 3 3\nv 9 9 9\ng A\nf 1 1 1\ng B\nf 2 2 2\ng A\nf 3 3 3\n"
                          "g Empty\n")
        self.assertEqual(self.pipe.read_obj_groups(path), {"A": [(1.0, 1.0, 1.0), (3.0, 3.0, 3.0)],
                                                          "B": [(2.0, 2.0, 2.0)]})

    def test_a_malformed_face_line_raises(self):
        for bad in ("f", "f 1 x 2", "f 0 1 2", "f 1 2 4", "f -4 1 2", "f /1 2 3"):
            with self.subTest(line=bad):
                with self.assertRaises(ValueError) as caught:
                    self.pipe.read_obj_groups(self.write(f"v 0 0 0\nv 1 1 1\nv 2 2 2\n{bad}\n"))
                self.assertIn("line 4 is not a face of earlier vertices", str(caught.exception))

    def test_a_malformed_vertex_line_raises(self):
        for bad in ("v 1 2", "v 1 x 3", "v nan 0 0", "v inf 1 1"):
            with self.subTest(line=bad):
                with self.assertRaises(ValueError) as caught:
                    self.pipe.read_obj_groups(self.write(f"v 0 0 0\n{bad}\ng A\n"))
                self.assertIn("line 2 is not a vertex", str(caught.exception))

    def test_compare_vertices(self):
        self.assertEqual(self.pipe.compare_vertices([(0, 0, 0), (0, 0, 0), (3, 4, 0), (0, 20, 0)], [(0, 0, 0)] * 4),
                         {"count_a": 4, "count_b": 4, "max_cm": 20.0, "share_over_10cm": 0.25})
        self.assertEqual(self.pipe.compare_vertices([(0, 0, 0)], []),
                         {"count_a": 1, "count_b": 0, "max_cm": None, "share_over_10cm": None})
        self.assertEqual(self.pipe.compare_vertices([], []),
                         {"count_a": 0, "count_b": 0, "max_cm": 0.0, "share_over_10cm": 0.0})

    def test_the_limits(self):
        p = self.pipe
        self.assertEqual((p.POSE_CLIP_MAX_FRAMES, p.POSE_MISMATCH_CM, p.POSE_MISMATCH_SHARE, p.ROUND_TRIP_TOLERANCE_CM,
                          p.REPLACE_APPLIED_CM), (1, 10.0, 0.05, 0.5, 0.01))


class RoundTripTestCase(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.cc5 = FakeCC5(self.rl)
        p = mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.cc5.avatar)
        p.start()
        self.addCleanup(p.stop)
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        # Every temporary folder the plugin asks for is made under temp_root, so a test can see it was deleted.
        self.temp_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.temp_root, True)
        self.temp_folders: list = []
        t = mock.patch.object(self.pipe.tempfile, "mkdtemp", side_effect=self._mkdtemp)
        t.start()
        self.addCleanup(t.stop)

    def _mkdtemp(self, prefix="tmp", **_kw):
        folder = os.path.join(self.temp_root, f"{prefix}{len(self.temp_folders)}")
        os.makedirs(folder)
        self.temp_folders.append(folder)
        return folder

    def obj(self, body=None, groups=None, name="TestPatient.obj"):
        if groups is None:
            groups = [(TONGUE, TONGUE_VERTICES), (BODY, T_POSE if body is None else body)]
        return write_obj(os.path.join(self.dir, name), groups)

    def replace(self, path, mesh=BODY):
        return self.pipe.replace_mesh_from_obj(mesh, path)

    def calls(self):
        return [e[0] for e in self.cc5.events]

    def assertNothingChanged(self):
        for call in ("BeginAction", "DeleteClip", "ReplaceMesh", "Undo"):
            self.assertNotIn(call, self.calls())
        self.assertEqual(self.cc5.mesh[BODY], T_POSE)
        self.assertEqual(len(self.cc5.clips), 1)

    def assertTempFoldersDeleted(self):
        for folder in self.temp_folders:
            self.assertFalse(os.path.exists(folder), folder)


class ExportObjTest(RoundTripTestCase):
    def test_the_obj_is_cc5s_t_pose_with_its_materials_and_says_so(self):
        path = os.path.join(self.dir, "out", "TestPatient.obj")
        r = self.pipe.export_obj(path)
        self.assertTrue(r["success"])
        # Body and clothing parts, materials, Y-up; never ResetToBindPose (4), which writes the bind pose.
        self.assertEqual(self.cc5.options, [1 | 2 | 8 | 16])
        self.assertEqual(r["notes"], [self.pipe.OBJ_TPOSE_NOTE])
        self.assertEqual(self.pipe.OBJ_TPOSE_NOTE, "The OBJ is in CC5's T-pose (arms horizontal). Sculpt it without "
                                                   "changing the pose; replace_mesh_from_obj removes the character's "
                                                   "pose to read it back.")
        self.assertEqual(self.pipe.read_obj_groups(path)[BODY], T_POSE)

    def test_z_up_drops_only_the_axis_bit_and_says_replace_cannot_read_it_back(self):
        r = self.pipe.export_obj(os.path.join(self.dir, "z.obj"), y_up=False)
        self.assertEqual(self.cc5.options, [1 | 2 | 8])
        # P-9: asked for, so not a WARNING; but replace_mesh_from_obj reads only Y-up OBJs.
        self.assertTrue(r["success"])
        self.assertEqual(r["notes"], [self.pipe.OBJ_Z_UP_NOTE])
        self.assertEqual(self.pipe.OBJ_Z_UP_NOTE, "The OBJ is Z-up (y_up false), in CC5's T-pose. replace_mesh_from_obj "
                                                  "cannot bring it back, as it reads only Y-up OBJs: for the round trip, "
                                                  "export again with y_up true (the default).")

    def test_a_weaker_call_form_gets_its_warning_instead_of_the_t_pose_note(self):
        def export(avatar, path, *rest):
            if rest:
                raise TypeError("Wrong number or type of arguments for overloaded function 'RFileIO_ExportObjFile'.")
            open(path, "wb").close()

        self.rl.RFileIO.ExportObjFile.side_effect = export
        r = self.pipe.export_obj(os.path.join(self.dir, "weak.obj"))
        self.assertTrue(r["success"])
        self.assertEqual(r["notes"], ["WARNING: CC5 rejected (avatar, path, option) and (avatar, path) was used instead, "
                                      "so the OBJ options (Y-up axis, body and clothing parts, materials) were NOT "
                                      "applied, and the OBJ may not be in CC5's T-pose"])


class ReplaceMeshTest(RoundTripTestCase):
    def test_a_sculpt_is_read_in_the_t_pose_after_the_pose_is_removed_in_one_undo_step(self):
        sculpt = [T_POSE[0], T_POSE[1], (0.0, 171.5, 0.0), T_POSE[3]]  # the head raised 1.5 cm
        path = self.obj(body=sculpt)
        r = self.replace(path)
        self.assertEqual(r, {"success": True, "mesh": BODY, "pose_removed": True, "check_max_cm": 0.0,
                             "notes": [self.pipe.POSE_REMOVED_NOTE]})
        self.assertEqual(self.cc5.mesh[BODY], sculpt)
        self.assertEqual(self.cc5.clips, [])
        self.assertEqual(self.cc5.events, [
            ("ExportObjFile",),  # the character's T-pose before: the same vertex count, the same pose
            ("BeginAction", "Replace Mesh"), ("DeleteClip", 0), ("ReplaceMesh", BODY), ("ObjectModified",),
            ("EndAction",),
            ("ExportObjFile",),  # the check after
        ])
        self.cc5.avatar.ReplaceMesh.assert_called_once_with(BODY, path, False, False)
        # Both check exports: parts and Y-up, no materials (no textures written), never ResetToBindPose.
        self.assertEqual(self.cc5.options, [1 | 2 | 16, 1 | 2 | 16])
        self.assertEqual(len(self.temp_folders), 2)
        self.assertTempFoldersDeleted()
        self.assertEqual(self.pipe.POSE_REMOVED_NOTE, "The character's pose was removed so that CC5 reads the OBJ in "
                                                      "the T-pose; it stands in a T-pose now. Apply a pose again with "
                                                      "apply_pose if needed.")

    def test_pose_clips_are_deleted_last_first(self):
        self.cc5.clips = [_Clip(0.0), _Clip(ONE_FRAME)]  # live: after apply_pose the clip is 0 long
        r = self.replace(self.obj())
        self.assertTrue(r["success"], r)
        self.assertEqual([e for e in self.cc5.events if e[0] == "DeleteClip"], [("DeleteClip", 1), ("DeleteClip", 0)])

    def test_a_character_without_a_motion_clip_keeps_it_that_way(self):
        self.cc5.clips = []
        r = self.replace(self.obj())
        self.assertEqual((r["success"], r["pose_removed"], r["notes"], r["check_max_cm"]), (True, False, [], 0.0))
        self.assertNotIn("DeleteClip", self.calls())

    def test_an_obj_whose_only_group_has_another_name_is_used(self):
        for groups in ([("Body_sculpt", T_POSE)], [("", T_POSE)]):
            with self.subTest(groups=groups):
                self.cc5.clips = [_Clip(ONE_FRAME)]
                path = self.obj(groups=groups) if groups[0][0] else os.path.join(self.dir, "bare.obj")
                if not groups[0][0]:  # vertices and faces without a group line
                    with open(path, "w", encoding="utf-8") as f:
                        f.write("".join(f"v {x} {y} {z}\n" for x, y, z in T_POSE) + "f 1 2 3 4\n")
                r = self.replace(path)
                self.assertTrue(r["success"], r)
                self.assertEqual(r["check_max_cm"], 0.0)

    def test_a_multi_object_obj_from_blender_is_read_by_its_faces(self):
        # P-2: Blender writes "o <name>" first, then the object's vertices and faces, and exports every object. Before,
        # CC_Base_Body got the tongue's vertices and the sculpt was refused as another topology.
        sculpt = [T_POSE[0], T_POSE[1], (0.0, 171.5, 0.0), T_POSE[3]]  # the head raised 1.5 cm
        path = write_name_first_obj(os.path.join(self.dir, "TestPatient.obj"),
                                    [(TONGUE, TONGUE_VERTICES), (BODY, sculpt)])
        self.assertEqual(self.pipe.read_obj_groups(path), {TONGUE: TONGUE_VERTICES, BODY: sculpt})
        r = self.replace(path)
        self.assertEqual(r, {"success": True, "mesh": BODY, "pose_removed": True, "check_max_cm": 0.0,
                             "notes": [self.pipe.POSE_REMOVED_NOTE]})
        self.assertEqual(self.cc5.mesh[BODY], sculpt)
        self.assertEqual(self.cc5.mesh[TONGUE], TONGUE_VERTICES)

    def test_an_obj_without_that_group_among_several_is_refused(self):
        r = self.replace(self.obj(groups=[("A", T_POSE), ("B", TONGUE_VERTICES)]))
        self.assertEqual(r, {"success": False, "error": "TestPatient.obj has no group named CC_Base_Body (groups: A, B)"})
        self.assertNothingChanged()
        self.assertEqual(self.cc5.options, [])  # refused before any export

    def test_a_malformed_obj_is_refused(self):
        path = os.path.join(self.dir, "broken.obj")
        with open(path, "w", encoding="utf-8") as f:
            f.write("v 1 2\ng CC_Base_Body\n")
        r = self.replace(path)
        self.assertFalse(r["success"])
        self.assertTrue(r["error"].startswith("Could not read broken.obj: line 1 is not a vertex"), r["error"])
        self.assertNothingChanged()

    def test_a_character_with_an_animation_is_refused_and_nothing_changes(self):
        # DEC-9: the animation would have to be deleted for good, so it is left to the user.
        self.cc5.clips = [_Clip(ONE_FRAME * 6)]
        r = self.replace(self.obj())
        self.assertEqual(r, {"success": False, "error": (
            "Kevin has an animation (a motion clip of 6 frames). CC5 reads the OBJ in the character's current pose, so "
            "the animation would have to be deleted, and it cannot be restored. Remove it in Character Creator 5 first, "
            "then try again.")})
        self.assertNothingChanged()
        self.assertEqual(self.cc5.options, [])  # refused before the check export
        self.assertEqual(self.temp_folders, [])

    def test_clips_to_remove_returns_the_pose_clips_and_refuses_an_animation(self):
        clips = [_Clip(0.0), _Clip(ONE_FRAME)]
        self.cc5.clips = clips
        self.assertEqual(self.pipe._clips_to_remove(self.cc5.skeleton), clips)
        clips.append(_Clip(ONE_FRAME * 2.5))
        with self.assertRaises(ValueError) as caught:
            self.pipe._clips_to_remove(self.cc5.skeleton, "Kevin")
        self.assertTrue(str(caught.exception).startswith("Kevin has an animation (a motion clip of 2.5 frames)."))

    def test_a_skeleton_that_cannot_be_read_is_refused(self):
        self.cc5.avatar.GetSkeletonComponent.side_effect = RuntimeError("wrapped C/C++ object has been deleted")
        r = self.replace(self.obj())
        self.assertEqual(r, {"success": False, "error": "Could not read Kevin's motion clips, so nothing was replaced: "
                                                        "wrapped C/C++ object has been deleted"})
        self.assertNothingChanged()

    def test_an_obj_with_another_vertex_count_is_refused_before_any_change(self):
        r = self.replace(self.obj(body=T_POSE[:3]))
        self.assertEqual(r, {"success": False, "error": "TestPatient.obj's CC_Base_Body has 3 vertices, the character's "
                                                        "has 4: replace_mesh_from_obj needs the same topology"})
        self.assertNothingChanged()
        self.assertTempFoldersDeleted()

    def test_a_bind_pose_or_reordered_obj_is_refused_naming_the_likely_causes(self):
        # P-9: the refusal no longer blames the pose alone: another pose, another axis or a changed vertex order.
        for body, share in ((BIND_POSE, "50.0"), (list(reversed(T_POSE)), "100.0")):
            with self.subTest(share=share):
                r = self.replace(self.obj(body=body))
                self.assertEqual(r, {"success": False, "error": (
                    f"TestPatient.obj does not match the character's T-pose: {share}% of CC_Base_Body's vertices are "
                    "more than 10 cm from it. Likely causes: another pose (an OBJ from an older export_obj is in the "
                    "bind pose), another axis, or a changed vertex order. Export the OBJ again with export_obj (y_up "
                    "true), sculpt it without changing the pose or the vertex order, then replace.")})
                self.assertNothingChanged()
                self.assertTempFoldersDeleted()

    def test_a_z_up_obj_is_refused_naming_the_axis(self):
        # P-9: export_obj with y_up false writes a Z-up OBJ, which replace_mesh_from_obj cannot read back. Which sign
        # CC5's Z-up export uses is not verified, so both turns of the Y-up T-pose are recognised.
        sculpt = [T_POSE[0], T_POSE[1], (0.0, 171.5, 0.0), T_POSE[3]]
        turns = {"(x, -z, y)": lambda x, y, z: (x, -z, y), "(x, z, -y)": lambda x, y, z: (x, z, -y)}
        for label, turn in turns.items():
            with self.subTest(turn=label):
                r = self.replace(self.obj(groups=[(TONGUE, [turn(*v) for v in TONGUE_VERTICES]),
                                                  (BODY, [turn(*v) for v in sculpt])]))
                self.assertEqual(r, {"success": False, "error": (
                    "TestPatient.obj is a Z-up OBJ (export_obj with y_up false); replace_mesh_from_obj reads only Y-up "
                    "OBJs: export it with y_up true (the default), sculpt, then replace.")})
                self.assertNothingChanged()
                self.assertTempFoldersDeleted()

    def test_a_check_export_that_fails_beforehand_refuses_the_replace(self):
        self.cc5.failing_exports = {1}
        r = self.replace(self.obj())
        self.assertEqual(r, {"success": False, "error": (
            "Could not export Kevin's CC_Base_Body in the T-pose to check TestPatient.obj against it, so nothing was "
            "replaced: ExportObjFile reported an error status")})
        self.assertNothingChanged()
        self.assertTempFoldersDeleted()

    def test_a_replace_cc5_read_differently_is_undone_once_and_fails(self):
        self.cc5.misread_cm = 2.0
        r = self.replace(self.obj())
        self.assertEqual(r, {"success": False, "error": "CC5 did not read TestPatient.obj as expected (the mesh differs "
                                                        "by up to 2.00 cm from the OBJ); the replace was undone."})
        self.assertEqual(self.calls().count("Undo"), 1)
        self.assertEqual(self.cc5.mesh[BODY], T_POSE)  # one undo: the mesh and the pose are back
        self.assertEqual(len(self.cc5.clips), 1)
        self.assertTempFoldersDeleted()

    def test_an_undo_that_fails_says_to_undo_in_cc5(self):
        self.cc5.misread_cm = 2.0
        self.rl.RGlobal.Undo.side_effect = RuntimeError("SWIG")
        r = self.replace(self.obj())
        self.assertEqual(r["error"], "CC5 did not read TestPatient.obj as expected (the mesh differs by up to 2.00 cm "
                                     "from the OBJ); undoing the replace failed (SWIG): undo it in Character Creator 5.")

    # P-3: ReplaceMesh reports OK but the mesh keeps its old shape. A fine sculpt (0.3 cm) is within the 0.5 cm check
    # against the OBJ, so only the comparison with the mesh before the replace shows that nothing was applied.
    FINE_SCULPT = [T_POSE[0], T_POSE[1], (0.0, 170.3, 0.0), T_POSE[3]]

    def test_a_replace_cc5_did_not_apply_is_undone_once_and_fails(self):
        self.cc5.ignores_replace = True
        for groups in ([(TONGUE, TONGUE_VERTICES), (BODY, self.FINE_SCULPT)], [("Body_sculpt", self.FINE_SCULPT)]):
            with self.subTest(groups=[name for name, _vertices in groups]):  # the named group, the only-group fallback
                undos = self.calls().count("Undo")
                r = self.replace(self.obj(groups=groups))
                self.assertEqual(r, {"success": False, "error": "CC5 did not apply TestPatient.obj to CC_Base_Body; "
                                                                "nothing was changed (the replace was undone)"})
                self.assertEqual(self.calls().count("Undo"), undos + 1)
                self.assertEqual(self.cc5.mesh[BODY], T_POSE)
                self.assertEqual(len(self.cc5.clips), 1)  # the pose removed for the replace is back
                self.assertTempFoldersDeleted()

    def test_an_undo_that_fails_after_a_replace_cc5_did_not_apply_says_to_undo_in_cc5(self):
        self.cc5.ignores_replace = True
        self.rl.RGlobal.Undo.side_effect = RuntimeError("SWIG")
        r = self.replace(self.obj(body=self.FINE_SCULPT))
        self.assertEqual(r, {"success": False, "error": "CC5 did not apply TestPatient.obj to CC_Base_Body; undoing the "
                                                        "replace failed (SWIG): undo it in Character Creator 5"})

    def test_an_unedited_obj_needs_no_proof_that_cc5_applied_it(self):
        # The OBJ equals the mesh, so the replace changes nothing either way: no undo, and the check passes.
        self.cc5.ignores_replace = True
        r = self.replace(self.obj())
        self.assertEqual((r["success"], r["check_max_cm"]), (True, 0.0))
        self.assertNotIn("Undo", self.calls())

    def test_a_check_export_that_fails_afterwards_keeps_the_replace_with_a_warning(self):
        self.cc5.failing_exports = {2}
        r = self.replace(self.obj())
        self.assertTrue(r["success"])
        self.assertIsNone(r["check_max_cm"])
        self.assertEqual(r["notes"][0], self.pipe.POSE_REMOVED_NOTE)
        self.assertEqual(r["notes"][1], "WARNING: the new CC_Base_Body was not checked against TestPatient.obj: the "
                                        "T-pose export after the replace failed (ExportObjFile reported an error "
                                        "status). Look at the character in Character Creator 5; one undo takes the "
                                        "replace back.")
        self.assertNotIn("Undo", self.calls())
        self.assertTempFoldersDeleted()

    def test_a_failed_replace_says_the_pose_was_removed_and_does_not_undo_by_itself(self):
        self.cc5.avatar.ReplaceMesh.side_effect = RuntimeError("ReplaceMesh reported an error status")
        r = self.replace(self.obj())
        self.assertEqual(r, {"success": False, "error": (
            "ReplaceMesh reported an error status. The character's pose had already been removed for the replace: undo "
            "once to bring it back, or apply a pose again with apply_pose.")})
        self.assertEqual(self.calls(), ["ExportObjFile", "BeginAction", "DeleteClip", "ObjectModified", "EndAction"])
        self.assertTempFoldersDeleted()


if __name__ == "__main__":
    unittest.main()

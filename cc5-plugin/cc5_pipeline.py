"""
Export / import pipeline helpers: Unity export, mesh stats, poses, DCC round-trips.

Every function returns {"success": bool, ...}. All run on CC5's main thread via
the server queue. Arguments are validated before any RLPy call.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import tempfile
import time
import urllib.parse
from typing import Any

import RLPy

import cc5_api
from cc5_api import _raise_on_error  # also imported from here by cc5_skin and cc5_builder

SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")  # \Z, not $: $ also matches before a trailing newline
SUB_D_LEVELS = (0, 1, 2)  # same sets as the zod schema in src/tools/unity.ts
TEXTURE_SIZES = (512, 1024, 2048, 4096)
# How skin overlays and a skin condition reach Unity in one export (F-75): the user picks one per export, there is no
# default (cc5_skin.carry_injuries does the work).
INJURY_CHOICES = ("bake", "separate", "omit")  # same set as INJURY_CHOICES in src/tools/unity.ts; a test reads this line
# Starts each export note about an injury that did not reach the export: job_status and the tools treat it as a WARNING.
INJURY_WARNING_PREFIX = "WARNING: injuries not carried: "  # same text as INJURY_WARNING_PREFIX in src/tools/unity.ts


def check_path(path: str) -> str | None:
    """Reject empty, relative, NUL, '..', UNC/network and device paths. Returns an error message or None."""
    if not path or not isinstance(path, str):
        return "Path is required"
    decoded = urllib.parse.unquote(path)
    if "\x00" in path or "\x00" in decoded:
        return "Path contains null byte"
    if ".." in path or ".." in decoded:
        return "Path traversal ('..') is not allowed"
    if re.match(r"[\\/]{2}", path) or "?" in path:
        return "Network (UNC) and device paths are not allowed"
    if not os.path.isabs(path):
        return f"Path must be absolute: {path}"
    return None


def is_in_unity_assets(folder: str) -> bool:
    parts = os.path.normpath(folder).replace("/", "\\").split("\\")
    return any(p.lower() == "assets" for p in parts)


def unity_folder_error(folder: str) -> str | None:
    """None when `folder` is inside the Assets folder of a Unity project, else why not (F-76). A Unity project has
    ProjectSettings\\ProjectVersion.txt beside its Assets folder; each Assets folder in the path is tried, innermost
    first, so a project nested inside another project's Assets folder counts. Creates nothing."""
    if not is_in_unity_assets(folder):
        return f"Folder must be inside a Unity project's Assets folder: {folder}"
    markers: list[str] = []
    current = os.path.abspath(folder)
    while True:
        parent, name = os.path.split(current)
        if name.lower() == "assets" and parent:
            # A drive-root parent ("C:\\") keeps its separator, so the marker is C:\ProjectSettings\ProjectVersion.txt.
            marker = os.path.join(parent, "ProjectSettings", "ProjectVersion.txt")
            if os.path.isfile(marker):
                return None
            markers.append(marker)
        if not name or parent == current:
            break
        current = parent
    if not markers:  # os.path finds no Assets folder where the plain segment check did: still not inside one
        return f"Folder must be inside a Unity project's Assets folder: {folder}"
    return (f"Folder is not inside a Unity project: {folder}. {markers[0]} does not exist (a Unity project has "
            "ProjectSettings\\ProjectVersion.txt beside its Assets folder)")


def list_files(folder: str, since: float | None = None, max_entries: int = 2000) -> list[dict[str, Any]]:
    """Files under folder, skipping ones modified before `since`. Stops after `max_entries`
    folders + files so a broad folder (e.g. C:\\) cannot stall CC5's main thread or bloat the job record."""
    out: list[dict[str, Any]] = []
    scanned = 0
    for dirpath, _dirs, files in os.walk(folder):
        scanned += 1
        for name in sorted(files):
            scanned += 1
            if scanned > max_entries:
                return out
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            if since is None or st.st_mtime >= since:
                out.append({"path": full, "bytes": st.st_size})
    return out


def export_for_unity(
    unity_dir: str,
    character_name: str,
    sub_d_level: int | None = None,
    texture_size: int | None = None,
    include_current_pose: bool = False,
    injuries: str | None = None,
    remove_tearline_occlusion: bool = False,
) -> dict[str, Any]:
    """Export the current avatar with the Unity preset into <unity_dir>/<name>/<name>.fbx.

    Live CC5 5.13 (Task 18): a mesh-only export is in the bind pose whatever pose the scene shows, so
    include_current_pose exports one frame of motion, which carries the pose as a one-frame animation take.
    Convert Image Format is never asked for: CC5 crashes right after an export with it.

    Injuries (F-75): an FBX carries neither a Diffuse Blend overlay (on any material) nor the skin shader's pallor
    offsets, and CC5 has no FBX option that bakes Diffuse Blend. How they reach Unity is chosen per export, with no
    default: injuries 'bake' (burned into this export's diffuse textures), 'separate' (the overlay images and
    <name>_injuries.json beside the FBX) or 'omit'. A character that has them and no choice is not exported
    (needs_choice, with the list); every result lists what the FBX does not carry ('injuries'). A bake or copy that
    fails keeps the export, with an INJURY_WARNING_PREFIX note per failure.
    """
    error = check_path(unity_dir)
    if error:
        return {"success": False, "error": error}
    error = unity_folder_error(unity_dir)
    if error:
        return {"success": False, "error": error}
    if not SAFE_NAME.match(character_name or ""):
        return {"success": False, "error": "Character name must be 1-64 letters, digits, '_' or '-'"}
    if sub_d_level is not None and (isinstance(sub_d_level, bool) or sub_d_level not in SUB_D_LEVELS):
        return {"success": False, "error": "sub_d_level must be 0, 1 or 2"}
    if texture_size is not None and (isinstance(texture_size, bool) or texture_size not in TEXTURE_SIZES):
        return {"success": False, "error": "texture_size must be 512, 1024, 2048 or 4096"}
    if injuries is not None and injuries not in INJURY_CHOICES:
        return {"success": False, "error": "injuries must be one of: bake, separate, omit"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    import cc5_skin  # here, not at the top: cc5_skin imports this module
    state = cc5_skin.skin_export_state(avatar)
    if injuries is None and cc5_skin.needs_injury_choice(state):
        return {"success": False, "needs_choice": True,
                "error": "Not exported: this character has skin overlays or a skin condition that an FBX cannot "
                         "carry. Choose injuries 'bake', 'separate' or 'omit' for this export.",
                "injuries": cc5_skin.injury_report(state, None)}
    folder = os.path.join(unity_dir, character_name)
    os.makedirs(folder, exist_ok=True)
    fbx = os.path.join(folder, character_name + ".fbx")
    started = time.time() - 2  # mtime slack; report only files this export wrote
    result = cc5_api.export_fbx(
        fbx, 0,
        target_tool="Unity",
        sub_d_level=sub_d_level,
        include_current_pose=include_current_pose,
        remove_tearline_occlusion=bool(remove_tearline_occlusion),
        embed_textures=False,
        export_motion=bool(include_current_pose),
        motion_range=[0, 0] if include_current_pose else None,
        texture_size=texture_size,
        allow_fallback=False,  # without the settings it is not a Unity export (Z-up, full-size textures)
    )
    error = _check_export(result, fbx, started)
    if error:
        return error
    try:
        report = cc5_skin.carry_injuries(avatar, state, injuries, folder, character_name,
                                         list_files(folder, since=started))
    except Exception as e:
        report = cc5_skin.injury_report(state, injuries)
        report["failed"].append(f"injuries step failed: {e}")
    # WARNING notes: job_status and a batch then never show a failed bake or copy as a clean finish.
    notes = list(result.get("notes", [])) + [INJURY_WARNING_PREFIX + line for line in report["failed"]]
    # Listed again: a bake rewrites this export's textures, 'separate' adds the Injuries folder and the sidecar.
    return {"success": True, "fbx": fbx, "folder": folder, "files": list_files(folder, since=started),
            "notes": notes, "export_level": result.get("export_level"),
            "texture_size": result.get("texture_size"), "injuries": report,
            "remove_tearline_occlusion": bool(remove_tearline_occlusion)}


def _check_export(result: dict[str, Any], fbx: str, started: float) -> dict[str, Any] | None:
    """A failure result unless export_fbx applied its settings and wrote `fbx` during this export."""
    notes = result.get("notes", [])
    if not result.get("success"):
        return {"success": False, "error": result.get("error", "FBX export failed"), "notes": notes}
    if not result.get("flags_applied"):
        return {"success": False, "error": "CC5 exported without the requested FBX settings", "notes": notes}
    if not os.path.isfile(fbx) or os.stat(fbx).st_mtime < started:
        return {"success": False, "error": f"CC5 reported success but did not write {fbx}", "notes": notes}
    return None


def _parts(avatar) -> list[tuple[str, Any]]:
    parts: list[tuple[str, Any]] = [("body", avatar)]
    parts += [("clothing", c) for c in (avatar.GetClothes() or [])]
    parts += [("hair", h) for h in (avatar.GetHairs() or [])]
    parts += [("accessory", a) for a in (avatar.GetAccessories(True) or [])]
    return parts


def _triangle_count(mesh: Any, faces: int) -> tuple[int, bool]:
    """(triangles, estimated). GetFacesCount counts polygons: on live CC5 every CC3_Base_Plus face is a
    quad (GetFace(i) has 4 corners), and sum(corners - 2) matches Unity's triangle count exactly.
    If GetFace is unusable, count 2 triangles per polygon and say it is an estimate."""
    try:
        return sum(max(len(mesh.GetFace(i)) - 2, 0) for i in range(faces)), False
    except Exception:
        return faces * 2, True


def get_mesh_stats() -> dict[str, Any]:
    """Vertex, polygon ("faces"), triangle and material counts for the avatar and everything it wears."""
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    meshes: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    worn_mesh_names: set[str] = set()
    parts = _parts(avatar)
    # Worn items first, body last. Meshes are told apart by (object, mesh): two garments can both have a
    # mesh called "Mesh" (e.g. made in Blender). The body pass skips a name already counted under a worn
    # item, because avatar.GetMeshes(True) may also list worn-item meshes (LIVE-VERIFY in Task 18).
    for kind, obj in parts[1:] + parts[:1]:
        obj_name = obj.GetName()
        mat_comp = obj.GetMaterialComponent() if hasattr(obj, "GetMaterialComponent") else None
        for mesh in obj.GetMeshes(True) or []:
            name = mesh.GetName()
            if (obj_name, name) in seen or (kind == "body" and name in worn_mesh_names):
                continue
            seen.add((obj_name, name))
            if kind != "body":
                worn_mesh_names.add(name)
            try:
                mats = len(mat_comp.GetMaterialNames(name) or []) if mat_comp else 0
            except Exception:
                mats = 0
            faces = int(mesh.GetFacesCount())
            triangles, estimated = _triangle_count(mesh, faces)
            entry: dict[str, Any] = {
                "object": obj_name, "kind": kind, "mesh": name,
                "vertices": int(mesh.GetVerticesCount()), "faces": faces, "triangles": triangles,
                "materials": mats,
            }
            if estimated:
                entry["approximate"] = True
            meshes.append(entry)
    meshes.sort(key=lambda m: ("body", "clothing", "hair", "accessory").index(m["kind"]))
    totals = {k: sum(m[k] for m in meshes) for k in ("vertices", "faces", "triangles", "materials")}
    return {"success": True, "meshes": meshes, "totals": totals}


# LIVE-VERIFY (Task 18 prints the real extensions under browse_content('pose'/'motion')): .ccpose/.ccmotion
# are guesses for CC5-native content; keep in sync with POSE_EXTENSIONS in src/tools/pipeline.ts.
POSE_EXTENSIONS = {".rlmotion", ".imotion", ".rlpose", ".ipose", ".imotionplus", ".ccpose", ".ccmotion"}


def _check_existing(path: str, allowed: set[str]) -> str | None:
    error = check_path(path)
    if error:
        return error
    if os.path.splitext(path)[1].lower() not in allowed:
        return f"Unsupported file type. Allowed: {', '.join(sorted(allowed))}"
    if not os.path.isfile(path):
        return f"File not found: {path}"
    return None


def apply_pose(file_path: str) -> dict[str, Any]:
    """Apply a pose/motion file to the avatar: LoadFile aimed at the avatar, then LoadMotion as the fallback."""
    error = _check_existing(file_path, POSE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    RLPy.RGlobal.BeginAction("Apply Pose")
    try:
        RLPy.RScene.SelectObject(avatar)
        try:
            # Live signature: LoadFile(path, bRecordStep=True, spObject=0, kTime=-1, eOption=_None).
            # Pass the avatar so the pose lands on it whatever else is selected.
            _raise_on_error(RLPy.RFileIO.LoadFile(file_path, True, avatar), "LoadFile")
            method = "LoadFile"
        except Exception:
            _raise_on_error(RLPy.RFileIO.LoadMotion(file_path, RLPy.RTime(0), avatar), "LoadMotion")
            method = "LoadMotion"
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Transform)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "method": method}


EXPRESSION_NOT_READ = ("Could not read the facial expression; a .ccAvatar keeps neither the facial expression nor the "
                       "pose in any case.")
# F-88: how many set expression sliders export_obj's note and replace_mesh_from_obj's refusal name before the count.
# Both results also carry every set slider with its weight (expression_weights, review #5): setting the expression
# again after the round trip needs them all.
EXPRESSION_SLIDERS_NAMED = 3


def _active_expression(avatar: Any) -> list[dict[str, Any]]:
    """The facial expression sliders that are not at 0 ([] for a neutral face), by name, each weight rounded to 4
    places. Read only: no action, no key. Raises when they cannot be read, also when CC5 gives no face component.
    save_character lists them, as a .ccAvatar does not store them (F-77; nor the pose, which is not read here);
    export_obj warns about them and replace_mesh_from_obj refuses while there are any (F-88)."""
    face = avatar.GetFaceComponent()
    if not face:
        raise RuntimeError("CC5 gave no face component")
    names = sorted(cc5_api._collect_expression_names(face))
    if not names:
        return []
    weights = list(face.GetExpressionWeights(RLPy.RGlobal.GetTime(), names))
    return [{"name": n, "weight": round(float(w), 4)} for n, w in zip(names, weights) if abs(float(w)) > 1e-4]


def _slider_text(sliders: list[dict[str, Any]]) -> str:
    """The first EXPRESSION_SLIDERS_NAMED sliders with their weights, then how many more are set, as in
    'A 0.6, B 0.6, C 0.3 and 3 more'."""
    named = ", ".join(f"{s['name']} {s['weight']:g}" for s in sliders[:EXPRESSION_SLIDERS_NAMED])
    more = len(sliders) - EXPRESSION_SLIDERS_NAMED
    return f"{named} and {more} more" if more > 0 else named


def _expression_weights(sliders: list[dict[str, Any]]) -> dict[str, float]:
    """Every set slider with its weight rounded to 3 places, by name (review #5): what set_expression needs to set the
    expression again, which the texts' _slider_text names only in part."""
    return {s["name"]: round(float(s["weight"]), 3) for s in sliders}


def save_character(output_path: str) -> dict[str, Any]:
    """Save the avatar as a .ccAvatar so batch runs can reload a clean base.

    A .ccAvatar keeps neither the facial expression nor the pose: after loading it the face is neutral. The result's
    expression_not_saved lists the sliders that were set ([] for a neutral face); when they cannot be read the field
    is left out and a note says so. The save runs either way.
    """
    error = check_path(output_path)
    if error:
        return {"success": False, "error": error}
    if os.path.splitext(output_path)[1].lower() != ".ccavatar":
        return {"success": False, "error": "output_path must end with .ccAvatar"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    try:
        unsaved: list[dict[str, Any]] | None = _active_expression(avatar)
    except Exception:  # the save runs either way
        unsaved = None
    try:
        setting = RLPy.RSaveFileSetting()
        setting.SetSaveType(RLPy.ESaveFileType_Character)
        _raise_on_error(RLPy.RFileIO.SaveFile(avatar, setting, output_path), "SaveFile")
    except Exception as e:
        return {"success": False, "error": str(e)}
    if not os.path.isfile(output_path):
        return {"success": False, "error": f"CC5 did not write {output_path}"}
    result: dict[str, Any] = {"success": True, "path": output_path}
    if unsaved is None:
        result["notes"] = [EXPRESSION_NOT_READ]
    else:
        result["expression_not_saved"] = unsaved
    return result


# How SWIG says no overload matches the arguments ("Wrong number or type of arguments"); older SWIG
# builds raise NotImplementedError. Only these mean the call never ran.
SIGNATURE_MISMATCH = (TypeError, NotImplementedError)


def try_signatures(attempts: list[tuple[str, Any]]) -> tuple[str | None, str | None]:
    """Run each (label, fn) in order, for RLPy calls documented only as *args. Returns (label, None)
    for the form that worked, or (None, errors).

    Moves on to the next form only when SWIG rejected the arguments. Any other exception, including
    the RuntimeError _raise_on_error makes from an error RStatus, means CC5 ran the call and it failed:
    retrying a weaker form would repeat the operation or quietly drop its options, so it stops there.
    """
    errors: list[str] = []
    for label, fn in attempts:
        try:
            fn()
            return label, None
        except SIGNATURE_MISMATCH as e:
            errors.append(f"{label}: {e}")
        except Exception as e:
            errors.append(f"{label}: {e}")
            break
    return None, "; ".join(errors)


def _fallback_notes(label: str | None, attempts: list[tuple[str, Any]], consequence: str) -> list[str]:
    """A WARNING note when CC5 rejected the preferred call form and a weaker one was used."""
    if label is None or label == attempts[0][0]:
        return []
    return [f"WARNING: CC5 rejected {attempts[0][0]} and {label} was used instead, so {consequence}"]


# F-83 (live CC5 5.13): ExportObjFile cannot write the pose the scene shows. Without
# EExport3DFileOption_ResetToBindPose it writes CC5's T-pose (arms horizontal, fingertips at x +-88.6 cm), the pose a
# character with no motion clip stands in; with it, the bind pose (arms about 30 degrees down, x +-79.6 cm).
# RIAvatar.ReplaceMesh takes the OBJ as the mesh in the character's CURRENT pose and rebuilds the rest shape from it
# through the skeleton: a T-pose OBJ replaced while the character sat wrecked the body. So export_obj writes the
# T-pose, and replace_mesh_from_obj removes the character's pose (it then stands in the T-pose) before it replaces.
OBJ_PART_OPTIONS = ("EExport3DFileOption_FullBodyPart", "EExport3DFileOption_AllClothes")
OBJ_TPOSE_NOTE = ("The OBJ is in CC5's T-pose (arms horizontal). Sculpt it without changing the pose; "
                  "replace_mesh_from_obj removes the character's pose to read it back.")
# P-9 (DT-3): replace_mesh_from_obj checks the OBJ against a Y-up export, and RIAvatar.ReplaceMesh has no axis option,
# so a Z-up OBJ cannot come back. export_obj with y_up false says so in place of OBJ_TPOSE_NOTE (not a WARNING: it was
# asked for).
OBJ_Z_UP_NOTE = ("The OBJ is Z-up (y_up false), in CC5's T-pose. replace_mesh_from_obj cannot bring it back, as it "
                 "reads only Y-up OBJs: for the round trip, export again with y_up true (the default).")
# F-88 (live CC5 5.13): an OBJ carries the facial expression the character shows, and ReplaceMesh reads the OBJ as the
# mesh with no expression on it. Kevin with six expression sliders set: an unedited OBJ, replaced, made the expression
# part of the mesh, and the expression applied on top again (the head up to 0.36 cm off); with the expression reset
# first the round trip is exact. So export_obj warns while an expression is set (the note starts with
# OBJ_EXPRESSION_PREFIX, which src/tools/pipeline.ts tells apart from a call-form WARNING) and replace_mesh_from_obj
# refuses (EXPRESSION_REFUSED). The refusal sees only the expression the character has now (review #6): an OBJ exported
# with an expression and brought back after reset_expression passes every check, so the note says never to bring such
# an OBJ back, and the refusal covers an OBJ exported with the expression and one exported with a neutral face. Keep
# the wording in step with OBJ_NEUTRAL_FACE and OBJ_EXPRESSION_PREFIX in src/tools/pipeline.ts; a test reads the
# OBJ_EXPRESSION_PREFIX line.
OBJ_EXPRESSION_PREFIX = "WARNING: the OBJ carries the facial expression: "
OBJ_EXPRESSION_NOTE = (OBJ_EXPRESSION_PREFIX + "{sliders} (this reply lists every slider with its weight). Do not "
                       "bring this OBJ back with replace_mesh_from_obj, not even after reset_expression: the expression "
                       "is part of this OBJ, and the replace would make it part of the mesh without noticing (its check "
                       "would pass). For a round trip, run reset_expression, export again with export_obj and edit that "
                       "OBJ; after the replace, set the expression again with these weights.")
OBJ_EXPRESSION_NOT_READ = ("Could not read the facial expression: the OBJ carries any expression the face shows, and "
                           "replace_mesh_from_obj refuses while the expression cannot be read.")
EXPRESSION_REFUSED = ("{name}'s facial expression is set ({sliders}; this reply lists every slider with its weight), "
                      "so nothing was replaced: an OBJ exported with the expression set carries it, and the replace "
                      "would bake it into the mesh. If {file} was exported while this expression was set, run "
                      "reset_expression, export the OBJ again with export_obj and make the edit on that OBJ. If it was "
                      "exported with a neutral face, run reset_expression and replace it again. After the replace, set "
                      "the expression again with the weights listed.")
# replace_mesh_from_obj: a motion clip at most POSE_CLIP_MAX_FRAMES frames long is a pose, removed so that CC5 reads the
# OBJ in the T-pose; a longer clip is an animation (ANIMATION_REFUSED).
POSE_CLIP_MAX_FRAMES = 1
# An OBJ in another pose: more than POSE_MISMATCH_SHARE of the mesh's vertices more than POSE_MISMATCH_CM from the
# character's T-pose. Live, a bind-pose OBJ of the same body had its median vertex 0.00 cm away, but 29.7% of
# CC_Base_Body's vertices (the arms) more than 10 cm away, up to 36.5 cm.
POSE_MISMATCH_CM = 10.0
POSE_MISMATCH_SHARE = 0.05
# After the replace, a T-pose export must match the OBJ this closely. Live: an unedited round trip reads 0.00 cm, and a
# 2 cm edit to one vertex arrives as exactly 2.0 cm; an expression baked in and applied again read 0.36 cm, which the
# 0.5 cm allowed before passed (F-88).
ROUND_TRIP_TOLERANCE_CM = 0.05
# P-3: an OBJ more than this far from the character's mesh must move it. A mesh still within this of its old shape after
# the replace means CC5 did not apply the OBJ, whatever ReplaceMesh reported.
REPLACE_APPLIED_CM = 0.01


def _obj_option(y_up: bool, materials: bool = True) -> Any:
    """The EExport3DFileOption bits: the body and clothing parts, the materials (textures and .mtl) when asked, Y-up
    when asked. Never ResetToBindPose: the OBJ is in CC5's T-pose, the pose replace_mesh_from_obj reads it in."""
    option: Any = 0
    for name in OBJ_PART_OPTIONS + (("EExport3DFileOption_ExportMaterial",) if materials else ()):
        option |= getattr(RLPy, name, 0)
    if y_up:
        option |= RLPy.EExport3DFileOption_AxisYUp
    return option


def export_obj(output_path: str, y_up: bool = True) -> dict[str, Any]:
    """Export the avatar as OBJ for sculpting, in CC5's T-pose (LIVE-VERIFY: ExportObjFile is documented as *args).

    The T-pose (arms horizontal) is the pose a character with no motion clip stands in, which is the pose
    replace_mesh_from_obj reads the OBJ back in (F-83). A weaker call form applies none of the options, so its OBJ
    gets a WARNING note instead of OBJ_TPOSE_NOTE. A Z-up OBJ (y_up false) gets OBJ_Z_UP_NOTE instead:
    replace_mesh_from_obj reads only Y-up OBJs (P-9). The OBJ carries the facial expression the character shows
    (F-88): with one set the export still runs (an OBJ may be wanted for other uses), a WARNING note names the
    sliders and says not to bring this OBJ back (review #6), and the result lists every set slider with its weight
    (expression_weights, review #5); an expression that cannot be read gets OBJ_EXPRESSION_NOT_READ.
    """
    error = check_path(output_path)
    if error:
        return {"success": False, "error": error}
    if os.path.splitext(output_path)[1].lower() != ".obj":
        return {"success": False, "error": "output_path must end with .obj"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    expression_weights: dict[str, float] = {}
    try:
        sliders = _active_expression(avatar)
        expression_notes = [OBJ_EXPRESSION_NOTE.format(sliders=_slider_text(sliders))] if sliders else []
        expression_weights = _expression_weights(sliders)
    except Exception:  # read only: the export runs either way
        expression_notes = [OBJ_EXPRESSION_NOT_READ]
    option = _obj_option(y_up)
    attempts: list[tuple[str, Any]] = [
        ("(avatar, path, option)",
         lambda: _raise_on_error(RLPy.RFileIO.ExportObjFile(avatar, output_path, option), "ExportObjFile")),
        ("(avatar, path)",
         lambda: _raise_on_error(RLPy.RFileIO.ExportObjFile(avatar, output_path), "ExportObjFile")),
    ]
    label, err = try_signatures(attempts)
    if not label:
        return {"success": False, "error": f"ExportObjFile failed: {err}"}
    notes = _fallback_notes(label, attempts, "the OBJ options (Y-up axis, body and clothing parts, materials) were "
                                             "NOT applied, and the OBJ may not be in CC5's T-pose")
    if not os.path.isfile(output_path):
        return {"success": False, "error": f"CC5 did not write {output_path}", "signature": label, "notes": notes}
    if not notes:  # the options were applied: CC5's T-pose, Y-up unless y_up false asked for Z-up
        notes.append(OBJ_TPOSE_NOTE if y_up else OBJ_Z_UP_NOTE)
    result: dict[str, Any] = {"success": True, "path": output_path, "signature": label,
                              "notes": notes + expression_notes}
    if expression_weights:
        result["expression_weights"] = expression_weights
    return result


def _face_vertex_indices(refs: list[str], count: int) -> list[int] | None:
    """The 0-based vertex indices an "f" line's references name, or None when it has none, or one is not a whole
    number or names no vertex read so far. A reference is v, v/vt, v//vn or v/vt/vn; v counts from the file's first
    "v" line (1), or back from the latest one when negative (-1)."""
    if not refs:
        return None
    indices: list[int] = []
    for ref in refs:
        try:
            number = int(ref.split("/", 1)[0])
        except ValueError:
            return None
        index = number - 1 if number > 0 else count + number
        if number == 0 or not 0 <= index < count:
            return None
        indices.append(index)
    return indices


def read_obj_groups(path: str) -> dict[str, list[tuple[float, float, float]]]:
    """The vertices of each group of an OBJ (CC5's OBJ units are cm), by the standard OBJ rule (P-2): a group's
    vertices are the ones its faces use, each once, in file order.

    A face ("f") belongs to the group the last "g <name>" or "o <name>" line before it names ("" before any). So CC5's
    layout (a group's vertices, then its "g <name>" line, then its faces) and the name-first layout of Blender and most
    other tools ("o <name>", then the object's vertices and faces) read the same. A name with no faces adds no group; a
    name that comes back adds to its group. Raises ValueError on a malformed "v" line (fewer than three numbers, or one
    that is not finite) or "f" line (see _face_vertex_indices).
    """
    vertices: list[tuple[float, float, float]] = []
    used: dict[str, set[int]] = {}
    name = ""
    with open(path, encoding="utf-8", errors="replace") as f:
        for number, line in enumerate(f, 1):
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v":
                try:
                    vertex = (float(parts[1]), float(parts[2]), float(parts[3]))
                except (IndexError, ValueError):
                    vertex = None
                if vertex is None or not all(math.isfinite(c) for c in vertex):
                    raise ValueError(f"line {number} is not a vertex (v x y z): {line.strip()[:80]}")
                vertices.append(vertex)
            elif parts[0] in ("g", "o"):
                name = " ".join(parts[1:])
            elif parts[0] == "f":
                indices = _face_vertex_indices(parts[1:], len(vertices))
                if indices is None:
                    raise ValueError(f"line {number} is not a face of earlier vertices (f v1 v2 v3 ...): "
                                     f"{line.strip()[:80]}")
                used.setdefault(name, set()).update(indices)
    return {group: [vertices[i] for i in sorted(indices)] for group, indices in used.items()}


def compare_vertices(a: list[tuple[float, float, float]], b: list[tuple[float, float, float]]) -> dict[str, Any]:
    """How far apart two vertex lists are, vertex by vertex (OBJ units are cm): {count_a, count_b, max_cm,
    share_over_10cm}, the share of vertices more than POSE_MISMATCH_CM apart. With different counts no vertex can be
    paired: max_cm and share_over_10cm are None."""
    if len(a) != len(b):
        return {"count_a": len(a), "count_b": len(b), "max_cm": None, "share_over_10cm": None}
    distances = [math.dist(p, q) for p, q in zip(a, b)]
    over = sum(1 for d in distances if d > POSE_MISMATCH_CM)
    return {"count_a": len(a), "count_b": len(b), "max_cm": max(distances, default=0.0),
            "share_over_10cm": over / len(distances) if distances else 0.0}


def _z_up_match(wanted: list[tuple[float, float, float]], reference: list[tuple[float, float, float]]) -> bool:
    """Whether `wanted` is the Y-up `reference` turned Z-up (P-9): it matches as closely as the pose check asks (at
    most POSE_MISMATCH_SHARE of the vertices more than POSE_MISMATCH_CM apart) once each reference vertex (x, y, z)
    becomes (x, -z, y), or (x, z, -y): which sign CC5's Z-up export uses is not verified, so both are tried."""
    for turn in (lambda x, y, z: (x, -z, y), lambda x, y, z: (x, z, -y)):
        share = compare_vertices(wanted, [turn(*v) for v in reference])["share_over_10cm"]
        if share is not None and share <= POSE_MISMATCH_SHARE:
            return True
    return False


GOZ_POSES = {"current": "EExportGoZPose_Current", "tpose": "EExportGoZPose_TPose", "apose": "EExportGoZPose_APose"}


def _set_goz_pose(option: Any, pose_enum: Any) -> bool:
    """Put the pose on an RExportGoZMeshOption; True when it took. Live CC5 exposes it as the attribute
    ePose (dir(): bDoScale, bIsCreate, ePose, strPoseFilePath); a setter method is only the fallback."""
    if pose_enum is None:
        return False
    if hasattr(option, "ePose"):
        option.ePose = pose_enum
        return option.ePose == pose_enum
    setter = next((s for s in ("SetPose", "SetExportPose", "SetGoZPose") if hasattr(option, s)), None)
    if setter is None:
        return False
    getattr(option, setter)(pose_enum)
    return True


def export_goz(output_dir: str, pose: str = "tpose") -> dict[str, Any]:
    """Write GoZ files for ZBrush. Live signature:
    ExportGoZFile(ObjectVector kObjects, std::wstring strFolderPath, RExportGoZMeshOption kSetting) -> RStatus."""
    error = check_path(output_dir)
    if error:
        return {"success": False, "error": error}
    if not isinstance(pose, str) or pose not in GOZ_POSES:
        return {"success": False, "error": f"pose must be one of: {', '.join(GOZ_POSES)}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(output_dir, exist_ok=True)
    # Live CC5 5.13 appends each file name straight onto the folder string: "<parent>\goz" became
    # "<parent>\gozCC_Base_Body.GoZ", so the folder goes in with a trailing separator.
    folder = output_dir.rstrip("/\\") + os.sep
    started = time.time() - 2  # mtime slack; report only files this export wrote
    option = RLPy.RExportGoZMeshOption()
    pose_applied = _set_goz_pose(option, getattr(RLPy, GOZ_POSES[pose], None)) or pose == "current"
    attempts: list[tuple[str, Any]] = []
    if hasattr(RLPy, "ObjectVector"):
        def export_with_object_vector() -> None:
            objects = RLPy.ObjectVector()
            objects.append(avatar)
            _raise_on_error(RLPy.RFileIO.ExportGoZFile(objects, folder, option), "ExportGoZFile")
        attempts.append(("(ObjectVector[avatar], folder, option)", export_with_object_vector))
    attempts += [
        ("([avatar], folder, option)",
         lambda: _raise_on_error(RLPy.RFileIO.ExportGoZFile([avatar], folder, option), "ExportGoZFile")),
        ("([avatar], folder, [option])",
         lambda: _raise_on_error(RLPy.RFileIO.ExportGoZFile([avatar], folder, [option]), "ExportGoZFile")),
    ]
    label, err = try_signatures(attempts)
    if not label:
        return {"success": False, "error": f"ExportGoZFile failed: {err}"}
    files = list_files(output_dir, since=started)
    if not any(f["path"].lower().endswith(".goz") for f in files):
        return {"success": False, "signature": label,
                "error": f"CC5 reported success but wrote no GoZ file in {output_dir}"}
    notes = [] if pose_applied else [
        f"WARNING: pose '{pose}' NOT applied (RExportGoZMeshOption has no ePose attribute or pose setter); "
        "files use the current pose"]
    return {"success": True, "folder": output_dir, "files": files, "signature": label,
            "pose_applied": pose_applied, "notes": notes}


FBX_KINDS = {"prop": "EImportFbxOption_Prop", "clothing": None}

# Chad's ruling (2026-10-03): kind 'character' is switched off. Live in CC5 5.13 (Task 18), LoadFbxFile with
# EImportFbxOption_StandardHumanCharacter stopped in CC5's "Create Asset(s)" dialog and crashed CC5 (Qt5Core) when
# that dialog was answered from a script. Keep the text in sync with IMPORT_CHARACTER_DISABLED in
# src/tools/pipeline.ts.
IMPORT_CHARACTER_DISABLED = (
    "import_fbx with kind 'character' is switched off because it crashed Character Creator 5. Import the whole "
    "character by hand instead: use File > Import in Character Creator 5. Importing a 'prop' or 'clothing' "
    "still works.")


def _worn_names(avatar: Any) -> list[str]:
    """Names of the clothes and accessories the avatar wears."""
    items = list(avatar.GetClothes() or []) + list(avatar.GetAccessories(True) or [])
    return [str(item.GetName()) for item in items]


def import_fbx(file_path: str, kind: str, target: str | None = None) -> dict[str, Any]:
    """Import an FBX from Blender/Maya/etc. as a prop, or as clothing for one avatar (`target`, else the selected
    avatar, else the first: cc5_api._pick_target_avatar, as load_asset). Kind 'character' is switched off
    (IMPORT_CHARACTER_DISABLED) and never touches CC5.
    Live signatures: LoadFbxFile(path, EImportFbxOption, ...); LoadClotheFromFbx(avatar, path, WStringVector)."""
    if kind == "character":
        return {"success": False, "error": IMPORT_CHARACTER_DISABLED}
    if not isinstance(kind, str) or kind not in FBX_KINDS:
        return {"success": False, "error": f"kind must be one of: {', '.join(FBX_KINDS)}"}
    if target is not None and (kind != "clothing" or not isinstance(target, str) or not target):
        return {"success": False, "error": "target is only for kind 'clothing' and must be a character name"}
    error = _check_existing(file_path, {".fbx"})
    if error:
        return {"success": False, "error": error}
    avatar = None
    if kind == "clothing":
        avatar, pick_error = cc5_api._pick_target_avatar(target, ".fbx")
        if pick_error:
            no_avatar = not list(RLPy.RScene.GetAvatars())
            return {"success": False, "error": "No avatar in scene to dress" if no_avatar else pick_error}
    notes: list[str] = []
    failed_meshes: list[str] = []
    attempts: list[tuple[str, Any]] = []
    worn_before = _worn_names(avatar) if kind == "clothing" else []
    RLPy.RGlobal.BeginAction("Import FBX")
    try:
        if kind == "clothing":
            # The third argument is an out-param: CC5 fills it with the meshes it could not import.
            failed_vector = RLPy.WStringVector() if hasattr(RLPy, "WStringVector") else None
            failed_list: list[Any] = []

            def load_clothes(failed_out: Any) -> None:
                _raise_on_error(RLPy.RFileIO.LoadClotheFromFbx(avatar, file_path, failed_out), "LoadClotheFromFbx")

            if failed_vector is not None:
                attempts.append(("LoadClotheFromFbx(avatar, path, WStringVector)", lambda: load_clothes(failed_vector)))
            attempts.append(("LoadClotheFromFbx(avatar, path, list)", lambda: load_clothes(failed_list)))
            label, err = try_signatures(attempts)
            if label:
                RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
                filled = failed_vector if label.endswith("WStringVector)") else failed_list
                failed_meshes = [str(name) for name in filled]
                if failed_meshes:
                    notes.append(f"WARNING: {len(failed_meshes)} clothing mesh(es) did not import: "
                                 f"{', '.join(failed_meshes)}")
        else:
            option = getattr(RLPy, FBX_KINDS[kind], None)
            if option is None:
                notes.append(f"WARNING: RLPy.{FBX_KINDS[kind]} not found, so CC5's default import option was used")
            else:
                attempts.append(("LoadFbxFile(path, option)",
                                 lambda: _raise_on_error(RLPy.RFileIO.LoadFbxFile(file_path, option), "LoadFbxFile")))
            attempts.append(("LoadFbxFile(path)",
                             lambda: _raise_on_error(RLPy.RFileIO.LoadFbxFile(file_path), "LoadFbxFile")))
            label, err = try_signatures(attempts)
            notes += _fallback_notes(label, attempts,
                                     f"CC5's default import option was used instead of {FBX_KINDS[kind]}")
    finally:
        RLPy.RGlobal.EndAction()
    if not label:
        return {"success": False, "error": f"FBX import failed: {err}"}
    cc5_api._invalidate_caches()
    result: dict[str, Any] = {"success": True, "signature": label, "notes": notes}
    if kind == "clothing":
        # Live CC5 5.13: LoadClotheFromFbx reports success for a garment it cannot fit (an unskinned mesh) and adds
        # nothing, so success means something new is worn.
        added = [name for name in _worn_names(avatar) if name not in worn_before]
        if not added:
            not_imported = f" Meshes CC5 did not import: {', '.join(failed_meshes)}." if failed_meshes else ""
            return {"success": False, "signature": label, "failed_meshes": failed_meshes, "notes": notes,
                    "error": "CC5 reported success but no clothing was added." + not_imported + " The garment must be "
                             "skinned to the character's skeleton: export the character (export_fbx with target_tool "
                             "'Blender'), fit and skin the garment to its armature, and export it with the armature."}
        result["failed_meshes"] = failed_meshes
        result["added"] = added
    return result


def list_meshes() -> dict[str, Any]:
    """Mesh names of the current avatar (the names replace_mesh_from_obj accepts)."""
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    return {"success": True, "meshes": list(avatar.GetMeshNames(True) or [])}


# DEC-9 (Chad, 2026-10-06): replace_mesh_from_obj removes a pose but refuses an animation, which it would have to
# delete for good. The rule lives in _clips_to_remove only; keep the wording in step with REPLACE_MESH_ANIMATION_RULE in
# src/tools/pipeline.ts.
ANIMATION_REFUSED = ("{name} has an animation (a motion clip of {frames} frames). CC5 reads the OBJ in the character's "
                     "current pose, so the animation would have to be deleted, and it cannot be restored. Remove it in "
                     "Character Creator 5 first, then try again.")
POSE_REMOVED_NOTE = ("The character's pose was removed so that CC5 reads the OBJ in the T-pose; it stands in a T-pose "
                     "now. Apply a pose again with apply_pose if needed.")


def _character_name(avatar: Any) -> str:
    try:
        name = str(avatar.GetName() or "").strip()
    except Exception:
        name = ""
    return name or "The character"


def _group_list(groups: dict[str, Any]) -> str:
    return ", ".join(name or '""' for name in groups) or "none"


def _clips_to_remove(skeleton: Any, name: str = "The character") -> list[Any]:
    """The character's pose clips (each at most POSE_CLIP_MAX_FRAMES frames long), in clip order: replace_mesh_from_obj
    deletes them so that CC5 reads the OBJ in the T-pose. A longer clip is an animation, which deleting would lose for
    good, so it raises ValueError(ANIMATION_REFUSED) instead (DEC-9, Chad 2026-10-06: keep this refusal).

    Live CC5 5.13: a freshly loaded character has one clip one frame long (its arms-down stance); after apply_pose the
    clip is 0 long. RTime counts 6,000 per second; IndexedFrameTime(1) is one frame at the project's frame rate.
    """
    one = float(RLPy.RGlobal.GetFps().IndexedFrameTime(1).ToFloat())
    if not one > 0:
        raise RuntimeError(f"CC5 gave a frame length of {one}, so the motion clips could not be measured")
    clips = [skeleton.GetClip(i) for i in range(int(skeleton.GetClipCount()))]
    longest = max((float(clip.GetClipLength().ToFloat()) for clip in clips), default=0.0)
    if longest > POSE_CLIP_MAX_FRAMES * one + 1e-6:
        raise ValueError(ANIMATION_REFUSED.format(name=name, frames=f"{round(longest / one, 1):g}"))
    return clips


def _tpose_vertices(avatar: Any, mesh_name: str) -> list[tuple[float, float, float]]:
    """The vertices of the character's mesh `mesh_name` in CC5's T-pose, whatever pose the scene shows: an OBJ export
    into a temporary folder (export_obj's parts and Y-up, without ExportMaterial, so no textures are written), read
    back, then the folder deleted. Live (F-83 probe), one undo still reversed ReplaceMesh after two OBJ exports. Raises
    when the export fails or has no group named `mesh_name`."""
    folder = tempfile.mkdtemp(prefix="cc5_obj_check_")
    try:
        path = os.path.join(folder, "check.obj")
        _raise_on_error(RLPy.RFileIO.ExportObjFile(avatar, path, _obj_option(True, materials=False)), "ExportObjFile")
        if not os.path.isfile(path):
            raise RuntimeError("CC5 wrote no OBJ")
        groups = read_obj_groups(path)
        if mesh_name not in groups:
            raise RuntimeError(f"CC5's OBJ has no group named {mesh_name} (groups: {_group_list(groups)})")
        return groups[mesh_name]
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _undo_once(avatar: Any) -> str | None:
    """One RGlobal.Undo() for the replace's undo step (live: one undo reversed a ReplaceMesh exactly), then a redraw.
    None when the undo ran, else its error."""
    try:
        RLPy.RGlobal.Undo()
    except Exception as e:
        return str(e)
    try:
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
    except Exception:
        pass
    return None


def replace_mesh_from_obj(mesh_name: str, obj_path: str) -> dict[str, Any]:
    """Swap one avatar mesh for an edited OBJ from export_obj: same topology, in CC5's T-pose (F-83).

    RIAvatar.ReplaceMesh(mesh, obj, bSplitObjects=False, bAutoRig=False) takes the OBJ's mesh as the mesh in the
    character's CURRENT pose, so the character's pose is removed first: with no motion clip it stands in the T-pose,
    the pose export_obj writes. In this order, and every refusal leaves the scene unchanged:
      1. mesh_name, the file, the avatar and a known mesh;
      2. the OBJ's group named mesh_name, else its only group (read_obj_groups: the vertices its faces use);
      3. the motion clips: a pose is removed later, an animation refused (_clips_to_remove, DEC-9);
      4. the facial expression: refused while a slider is not at 0 (EXPRESSION_REFUSED, F-88: the replace would bake
         an expression the OBJ carries into the mesh), with every set slider and its weight (expression_weights,
         review #5), and when it cannot be read;
      5. a T-pose export of the current mesh (_tpose_vertices): the OBJ must have its vertex count, and at most
         POSE_MISMATCH_SHARE of its vertices may be more than POSE_MISMATCH_CM away (an older export_obj's bind pose
         is far more); a Z-up OBJ is refused naming the axis (_z_up_match, P-9); a failed export refuses too, so
         nothing is replaced unchecked;
      6. as ONE undo step: the pose clips deleted (last first), ReplaceMesh, ObjectModified;
      7. a T-pose export again must have moved when the OBJ differs from the mesh by more than REPLACE_APPLIED_CM (else
         CC5 did not apply the OBJ, P-3), and must match the OBJ within ROUND_TRIP_TOLERANCE_CM; otherwise one
         RGlobal.Undo() takes the step back and the call fails. If that export fails, the replace stays, with a
         WARNING note.
    The result: mesh, pose_removed (a clip was deleted), check_max_cm (None when not checked) and notes.
    """
    if not isinstance(mesh_name, str) or not mesh_name:
        return {"success": False, "error": "mesh_name is required"}
    error = _check_existing(obj_path, {".obj"})
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    names = list(avatar.GetMeshNames(True) or [])
    if mesh_name not in names:
        return {"success": False, "error": f"Unknown mesh '{mesh_name}'. Meshes: {', '.join(names)}"}
    file = os.path.basename(obj_path)
    try:
        groups = read_obj_groups(obj_path)
    except (OSError, ValueError) as e:
        return {"success": False, "error": f"Could not read {file}: {e}"}
    if mesh_name in groups:
        wanted = groups[mesh_name]
    elif len(groups) == 1:
        wanted = next(iter(groups.values()))
    else:
        return {"success": False, "error": f"{file} has no group named {mesh_name} (groups: {_group_list(groups)})"}
    character = _character_name(avatar)
    try:
        skeleton = avatar.GetSkeletonComponent()
        if skeleton is None:
            raise RuntimeError("CC5 gave no skeleton component")
        clips = _clips_to_remove(skeleton, character)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": f"Could not read {character}'s motion clips, so nothing was replaced: {e}"}
    try:
        sliders = _active_expression(avatar)
    except Exception as e:
        return {"success": False,
                "error": f"Could not read {character}'s facial expression, so nothing was replaced: {e}"}
    if sliders:
        return {"success": False,
                "error": EXPRESSION_REFUSED.format(name=character, sliders=_slider_text(sliders), file=file),
                "expression_weights": _expression_weights(sliders)}
    try:
        reference = _tpose_vertices(avatar, mesh_name)
    except Exception as e:
        return {"success": False, "error": f"Could not export {character}'s {mesh_name} in the T-pose to check {file} "
                                           f"against it, so nothing was replaced: {e}"}
    before = compare_vertices(wanted, reference)
    if before["max_cm"] is None:
        return {"success": False, "error": f"{file}'s {mesh_name} has {before['count_a']} vertices, the character's "
                                           f"has {before['count_b']}: replace_mesh_from_obj needs the same topology"}
    if before["share_over_10cm"] > POSE_MISMATCH_SHARE:
        if _z_up_match(wanted, reference):
            return {"success": False, "error": (
                f"{file} is a Z-up OBJ (export_obj with y_up false); replace_mesh_from_obj reads only Y-up OBJs: "
                "export it with y_up true (the default), sculpt, then replace.")}
        return {"success": False, "error": (
            f"{file} does not match the character's T-pose: {before['share_over_10cm'] * 100:.1f}% of {mesh_name}'s "
            f"vertices are more than {POSE_MISMATCH_CM:g} cm from it. Likely causes: another pose (an OBJ from an older "
            "export_obj is in the bind pose), another axis, or a changed vertex order. Export the OBJ again with "
            "export_obj (y_up true), sculpt it without changing the pose or the vertex order, then replace.")}
    removed = 0
    failure: str | None = None
    RLPy.RGlobal.BeginAction("Replace Mesh")
    try:
        for clip in reversed(clips):
            skeleton.DeleteClip(clip)
            removed += 1
        _raise_on_error(avatar.ReplaceMesh(mesh_name, obj_path, False, False), "ReplaceMesh")
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
    except Exception as e:
        failure = str(e)
        if removed:  # the pose is gone although the replace failed: the viewport must show that
            try:
                RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
            except Exception:
                pass
    finally:
        RLPy.RGlobal.EndAction()
    if failure is not None:
        if removed:
            # No automatic undo here: whether CC5 recorded the failed step is unknown, and an undo of nothing would
            # take back the user's previous change.
            failure = (failure.rstrip(".") + ". The character's pose had already been removed for the replace: undo "
                       "once to bring it back, or apply a pose again with apply_pose.")
        return {"success": False, "error": failure}
    notes = [POSE_REMOVED_NOTE] if removed else []
    check_max_cm: float | None = None
    try:
        after = _tpose_vertices(avatar, mesh_name)
    except Exception as e:
        notes.append(f"WARNING: the new {mesh_name} was not checked against {file}: the T-pose export after the "
                     f"replace failed ({e}). Look at the character in Character Creator 5; one undo takes the replace "
                     "back.")
    else:
        # P-3: ReplaceMesh can report OK without applying the OBJ (the single-group fallback passes a group under
        # another name). An OBJ that differs from the mesh must move it; else a fine sculpt within
        # ROUND_TRIP_TOLERANCE_CM would pass the check below unapplied.
        moved = compare_vertices(after, reference)
        if (before["max_cm"] > REPLACE_APPLIED_CM and moved["max_cm"] is not None
                and moved["max_cm"] <= REPLACE_APPLIED_CM):
            undo_error = _undo_once(avatar)
            done = ("nothing was changed (the replace was undone)" if undo_error is None
                    else f"undoing the replace failed ({undo_error}): undo it in Character Creator 5")
            return {"success": False, "error": f"CC5 did not apply {file} to {mesh_name}; {done}"}
        check = compare_vertices(after, wanted)
        if check["max_cm"] is None or check["max_cm"] > ROUND_TRIP_TOLERANCE_CM:
            how = (f"the mesh has {check['count_a']} vertices after the replace and the OBJ {check['count_b']}"
                   if check["max_cm"] is None else f"the mesh differs by up to {check['max_cm']:.2f} cm from the OBJ")
            undo_error = _undo_once(avatar)
            done = ("the replace was undone" if undo_error is None
                    else f"undoing the replace failed ({undo_error}): undo it in Character Creator 5")
            return {"success": False, "error": f"CC5 did not read {file} as expected ({how}); {done}."}
        check_max_cm = round(check["max_cm"], 2)
    return {"success": True, "mesh": mesh_name, "pose_removed": removed > 0, "check_max_cm": check_max_cm,
            "notes": notes}


# Keep in sync with TEXTURE_CHANNELS and IMAGE_EXTENSIONS in src/tools/pipeline.ts.
TEXTURE_CHANNELS = {
    "diffuse": "EMaterialTextureChannel_Diffuse",
    "normal": "EMaterialTextureChannel_Normal",
    "roughness": "EMaterialTextureChannel_Roughness",
    "metallic": "EMaterialTextureChannel_Metallic",
    "ao": "EMaterialTextureChannel_AmbientOcclusion",
    "opacity": "EMaterialTextureChannel_Opacity",
    "displacement": "EMaterialTextureChannel_Displacement",
    "specular": "EMaterialTextureChannel_Specular",
    "glow": "EMaterialTextureChannel_Glow",
    "bump": "EMaterialTextureChannel_Bump",
    "diffuse_blend": "EMaterialTextureChannel_DiffuseBlend",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff"}

# The last Diffuse Blend image and strength this bridge set on each material, keyed (avatar_key, mesh, material):
# {"image": path, "strength": 0-1}. load_texture('diffuse_blend') and cc5_skin's apply/remove_skin_overlay keep it;
# export_for_unity trusts it over CC5's read, which lags until CC5 renders (F-65), and ships or bakes its image (F-75).
# An undo or redo marks every record stale ("stale": True, mark_blend_sources_stale, P-1): export_for_unity then uses
# CC5's read and does not trust the image, until the next write of that material's record replaces it.
# Kept across /reload like cc5_api._redo_slots (importlib.reload re-runs this module in the same namespace); lost on a
# CC5 restart.
BLEND_SOURCES: dict[tuple[Any, str, str], dict[str, Any]] = globals().get("BLEND_SOURCES", {})


def mark_blend_sources_stale() -> None:
    """Mark every BLEND_SOURCES record stale (P-1). cc5_api.undo() and redo() call this: an undo or redo can bring back
    another overlay image or strength than the bridge last set, and a record cannot tell which. A stale record never
    overrides CC5's read, and its image is not trusted (cc5_skin._overlay_state); the next load_texture or
    apply_skin_overlay on that material writes a fresh record, and remove_skin_overlay drops it. Never raises."""
    for record in list(BLEND_SOURCES.values()):
        if isinstance(record, dict):
            record["stale"] = True


# GetTextureWeights reads the value from before the last change until CC5 renders. Re-evaluating the current frame
# (RGlobal.SetTime(RGlobal.GetTime())) is untried, and CC5 records surprising calls as undo steps (RenderImage,
# SetRenderExportParameter). It stays off until the live probe shows the read refreshes and no undo step is added;
# then set it to "set_time".
REFRESH_METHOD: str | None = None


def avatar_key(avatar: Any) -> Any:
    """The avatar's id (GetID), or its name when CC5 cannot give the id: the first part of a BLEND_SOURCES key."""
    try:
        return avatar.GetID()
    except Exception:
        return avatar.GetName()


def now_key():
    key = RLPy.RKey()
    key.SetTime(RLPy.RGlobal.GetTime())
    return key


def refresh_current_frame() -> bool:
    """Re-evaluate the current frame so GetTextureWeights reads the latest strength. Off (no RLPy call, False) unless
    REFRESH_METHOD is "set_time"; True when the refresh ran."""
    if REFRESH_METHOD != "set_time":
        return False
    try:
        RLPy.RGlobal.SetTime(RLPy.RGlobal.GetTime())
        return True
    except Exception:
        return False


def read_blend_strength(mat_comp: Any, mesh: str, mat: str) -> float | None:
    """CC5's Diffuse Blend strength (0-1) of one material, or None when it cannot be read or is not a finite number
    (P-8: a NaN would reach the JSON reply, which the MCP server cannot parse). GetTextureWeights lists one weight per
    texture channel, indexed by the channel's value (DiffuseBlend is 7 live)."""
    try:
        weights = list(mat_comp.GetTextureWeights(mesh, mat))
        weight = float(weights[int(RLPy.EMaterialTextureChannel_DiffuseBlend)])
    except Exception:
        return None
    return weight if math.isfinite(weight) else None


def read_blend_strengths(mat_comp: Any, targets: list[tuple[str, str]],
                         expected: float) -> tuple[dict[str, float], list[str]]:
    """({material: strength CC5 reads, 3 dp}, [materials whose read differs from `expected` by more than 0.005]). A
    material CC5 cannot read has no entry and is not stale. Refreshes the frame first (when REFRESH_METHOD is on).
    Never raises."""
    strengths: dict[str, float] = {}
    stale: list[str] = []
    refresh_current_frame()
    for mesh, mat in targets:
        try:
            weight = read_blend_strength(mat_comp, mesh, mat)
            if weight is None:
                continue
            strengths[mat] = round(weight, 3)
            if abs(weight - expected) > 0.005:
                stale.append(mat)
        except Exception:
            continue
    return strengths, stale


def resolve_material(avatar, mesh_name: str, material_name: str) -> tuple[Any, str | None]:
    """Return (material component, error). Errors list the valid names."""
    meshes = list(avatar.GetMeshNames(True) or [])
    if mesh_name not in meshes:
        return None, f"Unknown mesh '{mesh_name}'. Meshes: {', '.join(meshes)}"
    mat_comp = avatar.GetMaterialComponent()
    mats = list(mat_comp.GetMaterialNames(mesh_name) or [])
    if material_name not in mats:
        return None, f"Unknown material '{material_name}' on {mesh_name}. Materials: {', '.join(mats)}"
    return mat_comp, None


def load_texture(mesh_name: str, material_name: str, channel: str, image_path: str,
                 strength: float | None = None) -> dict[str, Any]:
    """Load an image into one texture channel of one material.

    For 'diffuse_blend' it also sets the layer's strength (F-66): `strength` 0-100, default 100. CC5 shows a Diffuse
    Blend image only above 0, and a newly loaded image keeps whatever strength the layer had (0 on a fresh layer). The
    result's `strength` is the value set; `read` is what CC5 reads back, `stale` when that differs (CC5's read lags
    until it renders). Other channels take no strength.
    """
    if not isinstance(channel, str) or channel not in TEXTURE_CHANNELS:
        return {"success": False, "error": f"channel must be one of: {', '.join(TEXTURE_CHANNELS)}"}
    if strength is not None:
        if channel != "diffuse_blend":
            return {"success": False, "error": "strength is only for channel 'diffuse_blend'"}
        if (isinstance(strength, bool) or not isinstance(strength, (int, float)) or math.isnan(strength)
                or not 0 <= strength <= 100):
            return {"success": False, "error": "strength must be 0-100"}
    error = _check_existing(image_path, IMAGE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    mat_comp, error = resolve_material(avatar, mesh_name, material_name)
    if error:
        return {"success": False, "error": error}
    blend = channel == "diffuse_blend"
    channel_enum = getattr(RLPy, TEXTURE_CHANNELS[channel])
    weight = 1.0 if strength is None else float(strength) / 100.0
    read: float | None = None
    loaded = modified = recorded = False
    RLPy.RGlobal.BeginAction("Load Texture")
    try:
        _raise_on_error(mat_comp.LoadImageToTexture(mesh_name, material_name, channel_enum, image_path),
                        "LoadImageToTexture")
        loaded = True
        if blend:
            try:
                _raise_on_error(mat_comp.AddTextureWeightKey(now_key(), mesh_name, material_name, channel_enum, weight),
                                "AddTextureWeightKey")
            except Exception as e:
                raise RuntimeError(f"{e} (the image is loaded but its strength was not set; CC5 shows a Diffuse Blend "
                                   "image only above 0)") from e
        # After the weight key, so the redraw sees both changes.
        modified = True
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        if blend:
            BLEND_SOURCES[(avatar_key(avatar), mesh_name, material_name)] = {"image": image_path, "strength": weight}
            recorded = True
            refresh_current_frame()  # inside the action: a refresh, when on, joins the same undo step
            read = read_blend_strength(mat_comp, mesh_name, material_name)
    except Exception as e:
        if blend and loaded and not recorded:
            # CC5 holds the new image, but the material's record still names the old one: an export must not ship or
            # bake that (P-1). A later load_texture or apply_skin_overlay writes a fresh record.
            rec = BLEND_SOURCES.get((avatar_key(avatar), mesh_name, material_name))
            if rec is not None:
                rec["stale"] = True
        return {"success": False, "error": str(e)}
    finally:
        if loaded and not modified:  # the image went in before the failure: the viewport must still redraw
            RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    if not blend:
        return {"success": True}
    # strength is always the value set: a stale read is never reported as the strength.
    return {"success": True, "strength": weight, "read": read,
            "stale": read is None or abs(read - weight) > 0.005}


def load_substance_textures(folder: str) -> dict[str, Any]:
    """Apply a Substance Painter texture export folder to the avatar (CC's own Substance import)."""
    error = check_path(folder)
    if error:
        return {"success": False, "error": error}
    if not os.path.isdir(folder):
        return {"success": False, "error": f"Folder not found: {folder}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    RLPy.RGlobal.BeginAction("Load Substance Textures")
    try:
        label, err = try_signatures([
            ("(avatar, folder)",
             lambda: _raise_on_error(RLPy.RFileIO.LoadSubstancePainterTextures(avatar, folder),
                                     "LoadSubstancePainterTextures")),
        ])
        if label:
            RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    finally:
        RLPy.RGlobal.EndAction()
    if not label:
        return {"success": False, "error": f"Substance import failed: {err}"}
    return {"success": True, "signature": label}


def export_textures(output_dir: str, character_name: str) -> dict[str, Any]:
    """Export FBX + its textures as image files (in their source formats): the starting set for Substance Painter.

    Convert Image Format is never asked for: live CC5 5.13 crashes right after an export with it (Task 18).
    """
    error = check_path(output_dir)
    if error:
        return {"success": False, "error": error}
    if not SAFE_NAME.match(character_name or ""):
        return {"success": False, "error": "Character name must be 1-64 letters, digits, '_' or '-'"}
    if not cc5_api.get_first_avatar():
        return {"success": False, "error": "No avatar in scene"}
    folder = os.path.join(output_dir, character_name)
    os.makedirs(folder, exist_ok=True)
    fbx = os.path.join(folder, character_name + ".fbx")
    started = time.time() - 2  # mtime slack; report only files this export wrote
    result = cc5_api.export_fbx(fbx, 0, target_tool="", embed_textures=False, export_motion=False,
                                allow_fallback=False)
    error = _check_export(result, fbx, started)
    if error:
        return error
    return {"success": True, "folder": folder, "files": list_files(folder, since=started),
            "notes": result.get("notes", [])}


def _opt_int(p: dict, key: str) -> int | None:
    return int(p[key]) if p.get(key) is not None else None


ACTIONS: dict[str, Any] = {
    "export_for_unity": lambda p: export_for_unity(
        p["unity_dir"], p["character_name"], _opt_int(p, "sub_d_level"),
        _opt_int(p, "texture_size"), bool(p.get("include_current_pose", False)),
        p.get("injuries"), bool(p.get("remove_tearline_occlusion", False))),
    "get_mesh_stats": lambda p: get_mesh_stats(),
    "apply_pose": lambda p: apply_pose(p["file_path"]),
    "save_character": lambda p: save_character(p["output_path"]),
    "export_obj": lambda p: export_obj(p["output_path"], bool(p.get("y_up", True))),
    "export_goz": lambda p: export_goz(p["output_dir"], p.get("pose", "tpose")),
    "import_fbx": lambda p: import_fbx(p["file_path"], p["kind"], p.get("target")),
    "list_meshes": lambda p: list_meshes(),
    "replace_mesh_from_obj": lambda p: replace_mesh_from_obj(p["mesh_name"], p["obj_path"]),
    "load_texture": lambda p: load_texture(p["mesh_name"], p["material_name"], p["channel"], p["image_path"],
                                           p.get("strength")),
    "load_substance_textures": lambda p: load_substance_textures(p["folder"]),
    "export_textures": lambda p: export_textures(p["output_dir"], p["character_name"]),
}
POST_ROUTES: dict[str, str] = {
    "/pipeline/mesh_stats": "get_mesh_stats",
    "/pipeline/pose": "apply_pose",
    "/pipeline/save_character": "save_character",
    "/pipeline/export_obj": "export_obj",
    "/pipeline/meshes": "list_meshes",
    "/pipeline/replace_mesh": "replace_mesh_from_obj",
    "/pipeline/load_texture": "load_texture",
    "/pipeline/substance_import": "load_substance_textures",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "export_for_unity": ["unity_dir", "character_name"],
    "apply_pose": ["file_path"],
    "save_character": ["output_path"],
    "export_obj": ["output_path"],
    "export_goz": ["output_dir"],  # job-only: no POST route
    "import_fbx": ["file_path", "kind"],  # job-only: no POST route
    "replace_mesh_from_obj": ["mesh_name", "obj_path"],
    "load_texture": ["mesh_name", "material_name", "channel", "image_path"],
    "load_substance_textures": ["folder"],
    "export_textures": ["output_dir", "character_name"],  # job-only: no POST route
}

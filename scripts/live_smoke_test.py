#!/usr/bin/env python3
"""
Comprehensive LIVE smoke test for the CC5 MCP bridge.

Exercises ~44 bridge routes against a running CC5 (3D Creator mode). Creates a
default avatar and a few content items, so it mutates the scene (run on a scratch
project). Prints PASS/FAIL per check and exits non-zero on failure.

Prereq: CC5 running with the bridge up. Launch with:
    powershell -ExecutionPolicy Bypass -File scripts/launch_cc5_for_test.ps1
Then:
    py -3 scripts/live_smoke_test.py

Every request except /health sends the bridge token from CC5_BRIDGE_TOKEN or
%LOCALAPPDATA%\\CC5_MCP_Bridge\\token (CC5 writes it on its first start).

NOTE: this talks to the bridge DIRECTLY (HTTP), so it does NOT exercise the
TypeScript validation layer (e.g. asset.ts validateAssetPath). Keep the TS unit
tests (npm test) as the check for that layer.
"""
import json
import os
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.request

BASE = os.environ.get("CC5_BRIDGE_URL", "http://127.0.0.1:5101")
TOKEN_FILE = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "CC5_MCP_Bridge", "token")


def _read_token():
    if os.environ.get("CC5_BRIDGE_TOKEN"):
        return os.environ["CC5_BRIDGE_TOKEN"].strip()
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    return ""


TOKEN = _read_token()
P, F, S = [], [], []
SLOW = []  # direct (non-job) calls that took long: near the bridge's 30 s limit they should become jobs


def call(method, path, body=None, timeout=120, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", "X-CC5-Token": TOKEN}
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, None
    except Exception as e:
        return None, {"_err": str(e)}
    finally:
        elapsed = time.monotonic() - t0
        if elapsed > 20 and path not in ("/jobs/start", "/jobs/status"):
            SLOW.append(f"{path} {elapsed:.1f}s")


def res(r):
    if r is None:
        return {}
    return r.get("result") if isinstance(r, dict) and "result" in r else r


def answered(s, r):
    """CC5 ran the command: HTTP 200, or a clean 400 failure result from the command itself. An auth, Host,
    route or validation error body ({"error": ...} with no "success") is not an answer."""
    return s == 200 or (s == 400 and isinstance(res(r), dict) and "success" in res(r))


def warnings_in(result):
    notes = result.get("notes") if isinstance(result, dict) else None
    return [n for n in (notes or []) if isinstance(n, str) and n.startswith("WARNING")]


def ok(name, cond, extra=""):
    (P if cond else F).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {str(extra)[:90]}")


def skip(name, why=""):
    S.append(name)
    print(f"  [SKIP] {name}  {why}")


def is_resp(r):
    return isinstance(res(r), (dict, list))


print("== Scene / Avatar ==")
s, r = call("GET", "/health"); ok("check_cc5_connection", s == 200 and res(r).get("status") == "ok")
s, r = call("POST", "/avatar/create"); ok("create_avatar", res(r).get("success"))
s, r = call("POST", "/avatar/delete", {"name": "___nope___"}); ok("delete_avatar (clean not-found)", isinstance(res(r), dict) and res(r).get("success") is False)
s, r = call("GET", "/avatars"); avs = res(r); ok("list_avatars", isinstance(avs, list) and bool(avs))
s, r = call("GET", "/avatar/info"); ok("get_avatar_info", s == 200 and is_resp(r))
s, r = call("GET", "/scene/objects"); ok("get_scene_objects", s == 200 and is_resp(r))

print("== Morphs ==")
s, r = call("GET", "/morphs/catalog"); ok("get_morph_catalog", s == 200 and is_resp(r))
s, r = call("POST", "/morphs/search", {"query": "jaw"}); sr = res(r)
ok("search_morphs (list)", isinstance(sr, list) and bool(sr), f"n={len(sr) if isinstance(sr, list) else sr}")
mid = sr[0]["id"] if isinstance(sr, list) and sr else None
mid2 = sr[1]["id"] if isinstance(sr, list) and len(sr) > 1 else mid
s, r = call("POST", "/morph/set", {"morph_id": mid, "value": 0.3}); ok("adjust_morph", res(r).get("success"))
s, r = call("POST", "/morph/get", {"morph_id": mid}); gv = res(r)
ok("get_morph_value", gv.get("success") and abs(gv.get("value", 0) - 0.3) < 0.01, gv)
s, r = call("POST", "/morphs/set", {"morphs": [{"morph_id": mid, "value": 0.1}, {"morph_id": mid2, "value": 0.2}]})
ok("adjust_multiple_morphs", res(r).get("success"))
s, r = call("POST", "/morphs/reset"); ok("reset_morphs", s == 200 and is_resp(r), s)

print("== Materials / Color ==")
s, r = call("GET", "/material/info"); mi = res(r); ok("get_material_info (success+meshes)", isinstance(mi, dict) and mi.get("success") and "meshes" in mi)
mesh = mat = None
for k, v in (mi.get("meshes", {}) if isinstance(mi, dict) else {}).items():
    if isinstance(v, list) and v:
        mesh, mat = k, v[0]; break
if mesh:
    s, r = call("POST", "/material/color/get", {"mesh_name": mesh, "material_name": mat}); ok("get_diffuse_color", res(r).get("success") and "r" in res(r))
    s, r = call("POST", "/material/properties", {"mesh_name": mesh, "material_name": mat}); ok("get_material_properties", res(r).get("success"))
    s, r = call("POST", "/material/color/set", {"mesh_name": mesh, "material_name": mat, "r": .7, "g": .6, "b": .5}); ok("set_diffuse_color", res(r).get("success"))
    s, r = call("POST", "/material/opacity", {"mesh_name": mesh, "material_name": mat, "opacity": 100}); ok("set_material_opacity", res(r).get("success"))
    s, r = call("POST", "/material/glossiness", {"mesh_name": mesh, "material_name": mat, "glossiness": 20}); ok("set_material_glossiness", res(r).get("success"))
    s, r = call("POST", "/material/specular", {"mesh_name": mesh, "material_name": mat, "specular": 50}); ok("set_material_specular", res(r).get("success"))
    # PBR shader params (Digital Human Shader: roughness/SSS) — only present on skin materials
    s, r = call("POST", "/material/shader/get", {"mesh_name": mesh, "material_name": mat}); sp = res(r)
    ok("get_shader_parameters", isinstance(sp, dict) and sp.get("success") and isinstance(sp.get("parameters"), dict))
    pnames = list(sp.get("parameters", {}).keys()) if isinstance(sp, dict) else []
    if pnames:
        pn = pnames[0]; orig = sp["parameters"][pn]
        s, r = call("POST", "/material/shader/set", {"mesh_name": mesh, "material_name": mat, "parameter_name": pn, "values": orig})
        ok("set_shader_parameter round-trip", res(r).get("success") and res(r).get("parameter") == pn, res(r))
        s, r = call("POST", "/material/shader/set", {"mesh_name": mesh, "material_name": mat, "parameter_name": "___nope___", "values": [1.0]})
        ok("set_shader_parameter (clean unknown-param error)", isinstance(res(r), dict) and res(r).get("success") is False)
    else:
        skip("set_shader_parameter round-trip", "no shader params"); skip("set_shader_parameter (clean unknown-param error)", "no shader params")
else:
    for n in ["get_diffuse_color", "get_material_properties", "set_diffuse_color", "set_material_opacity", "set_material_glossiness", "set_material_specular", "get_shader_parameters", "set_shader_parameter round-trip", "set_shader_parameter (clean unknown-param error)"]:
        skip(n, "no mesh")
s, r = call("POST", "/color/eye", {"r": .3, "g": .2, "b": .1}); ok("set_eye_color", s == 200 and is_resp(r), s)
# set_lip_color correctly errors on the CC3+ base (no dedicated lip material — would tint the whole head).
s, r = call("POST", "/color/lip", {"r": .6, "g": .3, "b": .3}); ok("set_lip_color (clean result)", isinstance(res(r), dict) and "success" in res(r))
# set_hair_color correctly errors on a bald avatar (no hair materials) — accept clean error.
s, r = call("POST", "/color/hair", {"r": .2, "g": .1, "b": .05}); ok("set_hair_color (clean result)", isinstance(res(r), dict) and ("success" in res(r)))

print("== Lights / Camera / Expression ==")
s, r = call("GET", "/lights"); lts = res(r); ok("get_lights", s == 200 and is_resp(r))
lname = lts[0].get("name") if isinstance(lts, list) and lts and isinstance(lts[0], dict) else None
if lname:
    s, r = call("POST", "/light/info", {"light_name": lname}); ok("get_light_info", is_resp(r))
    # round-trip: set red, read back ~1.0/0/0 (RRgb.Red() is 0-255, get divides by 255)
    call("POST", "/light/color", {"light_name": lname, "r": 1.0, "g": 0.0, "b": 0.0})
    s, r = call("POST", "/light/info", {"light_name": lname}); c = res(r).get("color", {}) if isinstance(res(r), dict) else {}
    ok("set_light_color round-trip", abs(c.get("r", 0) - 1.0) < 0.05 and c.get("g", 1) < 0.05, c)
    s, r = call("POST", "/light/multiplier", {"light_name": lname, "multiplier": 1.0}); ok("set_light_multiplier", res(r).get("success") is not False and is_resp(r))
    # on/off toggle round-trip (lighting-guide): off then read-back, then restore on
    call("POST", "/light/active", {"light_name": lname, "active": False})
    s, r = call("POST", "/light/info", {"light_name": lname}); off_state = res(r).get("active") if isinstance(res(r), dict) else None
    s, r = call("POST", "/light/active", {"light_name": lname, "active": True}); ok("set_light_active round-trip", res(r).get("success") and off_state is False, res(r))
    # shadow: set darkness + cast, read back, then restore
    call("POST", "/light/shadow", {"light_name": lname, "cast_shadow": True, "darken_strength": 0.3})
    s, r = call("POST", "/light/info", {"light_name": lname}); ds = res(r).get("darken_shadow_strength") if isinstance(res(r), dict) else None
    ok("set_light_shadow darken round-trip", isinstance(ds, (int, float)) and abs(ds - 0.3) < 0.02, ds)
    call("POST", "/light/shadow", {"light_name": lname, "darken_strength": 0.0})  # restore
    s, r = call("POST", "/light/shadow", {"light_name": lname}); ok("set_light_shadow (clean no-arg error)", isinstance(res(r), dict) and res(r).get("success") is False)
else:
    for n in ["get_light_info", "set_light_color round-trip", "set_light_multiplier",
              "set_light_active round-trip", "set_light_shadow darken round-trip", "set_light_shadow (clean no-arg error)"]:
        skip(n, "no light")
s, r = call("GET", "/camera/info"); ok("get_camera_info", s == 200 and is_resp(r))
s, r = call("POST", "/camera/focal", {"focal_length": 50}); ok("set_camera_focal_length (responds)", answered(s, r), s)
s, r = call("POST", "/camera/frame", {"view": "face"}); ok("frame_camera face", res(r).get("success"), res(r))
call("POST", "/camera/frame", {"view": "home"})  # reset to full-body view
s, r = call("GET", "/expressions"); exprs = res(r); ok("get_expression_info (groups)", s == 200 and isinstance(exprs, dict) and "error" not in exprs and len(exprs) > 0, s)
# pick a real expression slider name to set, then reset
expr_name = None
if isinstance(exprs, dict):
    for g, names in exprs.items():
        if isinstance(names, list) and names:
            expr_name = names[0]; break
if expr_name:
    s, r = call("POST", "/expression/set", {"expressions": [{"name": expr_name, "weight": 0.7}, {"name": "___bogus___", "weight": 1.0}]}); er = res(r)
    ok("set_expression (applied + skipped)", er.get("success") and len(er.get("applied", [])) == 1 and "___bogus___" in er.get("skipped", []), er)
    s, r = call("POST", "/expression/reset", {}); ok("reset_expression", res(r).get("success") and res(r).get("reset_count", 0) > 0, res(r))
else:
    skip("set_expression (applied + skipped)", "no expression names"); skip("reset_expression", "no expression names")
s, r = call("POST", "/subdivision", {"level": 0}); ok("set_subdivision_level", res(r).get("success"))
# Environment / visual settings (ambient + IBL)
s, r = call("GET", "/visual/settings"); vsg = res(r)
ok("get_visual_settings", isinstance(vsg, dict) and vsg.get("success") and isinstance(vsg.get("ambient"), dict))
amb0 = vsg.get("ambient") if isinstance(vsg, dict) else None
s, r = call("POST", "/visual/ambient", {"r": 0.3, "g": 0.2, "b": 0.1}); ar = res(r)
ok("set_ambient round-trip", ar.get("success") and abs(ar.get("ambient", {}).get("r", 0) - 0.3) < 0.02, ar)
if amb0:
    call("POST", "/visual/ambient", amb0)  # restore
s, r = call("POST", "/visual/ibl", {"enable": True}); ok("set_ibl (enable toggle)", res(r).get("success") and res(r).get("ibl_enabled") is True, res(r))
s, r = call("POST", "/visual/ibl", {"image_path": "C:/___nope___/missing.hdr", "enable": True}); ok("set_ibl (clean bad-path error)", isinstance(res(r), dict) and res(r).get("success") is False)

print("== Content + asset load + item ops (real cloth) ==")
s, r = call("GET", "/clothes"); ok("list_clothes", s == 200 and is_resp(r))
s, r = call("GET", "/hair"); ok("list_hair", s == 200 and is_resp(r))
s, r = call("GET", "/accessories"); ok("list_accessories", s == 200 and is_resp(r))
s, r = call("POST", "/content/browse", {"folder_type": "shoes"}); cb = res(r)
ok("browse_content (.ccShoes)", isinstance(cb, list) and cb and str(cb[0]).lower().endswith(".ccshoes"), f"n={len(cb) if isinstance(cb, list) else cb}")
# scene/animation content categories (pose/motion may be empty on a base install — accept a list either way)
s, r = call("POST", "/content/browse", {"folder_type": "light"}); lb = res(r)
ok("browse_content light", isinstance(lb, list), f"n={len(lb) if isinstance(lb, list) else lb}")
s, r = call("POST", "/content/browse", {"folder_type": "pose"}); pb = res(r)
ok("browse_content pose (list, may be empty)", isinstance(pb, list))
shoe = cb[0] if isinstance(cb, list) and cb and str(cb[0]).lower().endswith(".ccshoes") else None
if shoe:
    s, r = call("POST", "/asset/load", {"file_path": shoe}, timeout=120); ok("load_asset (.ccShoes)", res(r).get("success"))
    s, r = call("GET", "/clothes"); cl = res(r)
    cloth_name = None
    if isinstance(cl, list) and cl:
        cloth_name = cl[0].get("name") if isinstance(cl[0], dict) else (cl[0] if isinstance(cl[0], str) else None)
    if cloth_name:
        s, r = call("POST", "/item/visible", {"item_name": cloth_name, "visible": False}); ok("set_item_visible HIDE real cloth", res(r).get("success"), res(r))
        s, r = call("POST", "/item/visible", {"item_name": cloth_name, "visible": True}); ok("set_item_visible SHOW real cloth", res(r).get("success"))
        s, r = call("POST", "/item/remove", {"item_name": cloth_name}); ok("remove_scene_item real cloth", res(r).get("success"), res(r))
    else:
        for n in ["set_item_visible HIDE real cloth", "set_item_visible SHOW real cloth", "remove_scene_item real cloth"]:
            skip(n, "no cloth name")
else:
    for n in ["load_asset (.ccShoes)", "set_item_visible HIDE real cloth", "set_item_visible SHOW real cloth", "remove_scene_item real cloth"]:
        skip(n, "no shoe")
s, r = call("POST", "/item/visible", {"item_name": "___nope___", "visible": False}); ok("set_item_visible (clean not-found)", isinstance(res(r), dict) and res(r).get("success") is False)
s, r = call("POST", "/item/remove", {"item_name": "___nope___"}); ok("remove_scene_item (clean not-found)", isinstance(res(r), dict) and res(r).get("success") is False)

print("== Export / Capture / Bake / Edit / Exec ==")
s, r = call("POST", "/viewport/capture"); cap = res(r)
ok("capture_viewport", isinstance(cap, dict) and (cap.get("success") or cap.get("base64") or cap.get("path")))
fbx = os.path.join(tempfile.gettempdir(), "cc5_smoke_export.fbx")
s, r = call("POST", "/export/fbx", {"output_path": fbx}, timeout=180); ok("export_fbx (responds)", answered(s, r), s)
s, r = call("GET", "/export/head_mh/status"); ok("export_head_mh status", s == 200 and is_resp(r))
s, r = call("POST", "/undo"); ok("undo", s == 200 and is_resp(r), s)
s, r = call("POST", "/redo"); ok("redo", s == 200 and is_resp(r), s)
s, r = call("POST", "/exec/python", {"code": "result=6*7"})
if any(os.environ.get(v, "").strip().lower() in ("1", "true", "yes") for v in ("CC5_DEV_MODE", "CC5_ALLOW_EXEC")):
    ok("exec_python (dev mode)", res(r).get("success") and str(res(r).get("result")) == "42", s)
else:
    ok("exec_python blocked without dev mode", s == 403, s)

STATUS_TIMES = []  # seconds per /jobs/status answer while jobs run


def job(action, params, timeout=600):
    """Start a bridge job, poll it to the end and return its result (None if it never finished). Times every
    /jobs/status answer: if those stall during a long job, CC5's main thread holds Python's GIL."""
    s, r = call("POST", "/jobs/start", {"action": action, "params": params})
    jid = res(r).get("job_id") if s == 200 else None
    if not jid:
        print(f"  could not start job {action}: {s} {r}")
        return None
    end = time.time() + timeout
    while time.time() < end:
        t0 = time.monotonic()
        _, st = call("POST", "/jobs/status", {"job_id": jid})
        STATUS_TIMES.append(time.monotonic() - t0)
        st = res(st)
        if st.get("status") in ("done", "failed"):
            return st.get("result")
        time.sleep(1)
    return None


def file_text(path):
    with open(path, encoding="utf-8", errors="ignore") as f:
        return f.read()


def _tiff_size(f, data):
    """TIFF (same reader as src/image-info.ts): "II"/"MM", version 42, then the first IFD's offset. The IFD is a
    2-byte entry count and 12-byte entries (tag, type, count, value); tag 256 = width, 257 = height, as SHORT
    (type 3, first 2 bytes of the value field) or LONG (type 4). The IFD often follows the image data, so it is read
    at its offset. BigTIFF (version 43), truncated or malformed files give None."""
    if len(data) < 8:
        return None
    order = "<" if data[:2] == b"II" else ">"
    version, ifd = struct.unpack(order + "HI", data[2:8])
    if version != 42 or ifd < 8:
        return None
    f.seek(ifd)
    head = f.read(2)
    if len(head) < 2:
        return None
    count = struct.unpack(order + "H", head)[0]
    entries = f.read(count * 12)
    if len(entries) < count * 12:
        return None
    size = {256: 0, 257: 0}
    for i in range(count):
        tag, kind = struct.unpack(order + "HH", entries[i * 12:i * 12 + 4])
        if tag not in size:
            continue
        if kind == 3:
            size[tag] = struct.unpack(order + "H", entries[i * 12 + 8:i * 12 + 10])[0]
        elif kind == 4:
            size[tag] = struct.unpack(order + "I", entries[i * 12 + 8:i * 12 + 12])[0]
        else:
            return None
    return (size[256], size[257]) if size[256] > 0 and size[257] > 0 else None


def image_size(path):
    """(width, height) from a PNG, JPEG, TIFF or BMP header, or None for other files."""
    with open(path, "rb") as f:
        data = f.read(1 << 20)
        if data[:2] in (b"II", b"MM"):
            return _tiff_size(f, data)
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":  # JPEG: walk the segments to the first start-of-frame marker
        i = 2
        while i + 9 < len(data) and data[i] == 0xFF:
            marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", data[i + 5:i + 9])
                return width, height
            i += 2 + length
    if data[:2] == b"BM":  # BMP: int32 width at 18, height at 22 (negative for a top-down bitmap)
        if len(data) < 26:
            return None
        width, height = struct.unpack("<ii", data[18:26])
        return (width, abs(height)) if width > 0 and height != 0 else None
    return None


print("== Exonicus extensions ==")
scratch = os.path.join(tempfile.gettempdir(), "cc5_live", "Assets", "Test")
try:
    urllib.request.urlopen(urllib.request.Request(BASE + "/avatars"), timeout=5)
    ok("auth required", False)
except urllib.error.HTTPError as e:
    ok("auth required", e.code == 401, e.code)
s, r = call("POST", "/morphs/search", {"query": "jaw"}, headers={"Host": "evil.example:80"}); ok("foreign Host rejected", s == 403, s)
s, r = call("POST", "/morphs/search", {"query": "jaw"}, headers={"Content-Type": "text/plain"}); ok("non-JSON POST rejected", s == 415, s)

s, r = call("POST", "/pipeline/mesh_stats", {}); ms = res(r)
ok("get_mesh_stats (with triangles)", s == 200 and ms.get("success") and "triangles" in ms.get("totals", {}), ms.get("totals"))
pairs = [(m.get("object"), m.get("mesh")) for m in ms.get("meshes", [])] if isinstance(ms, dict) else []
ok("get_mesh_stats counts each (object, mesh) once", s == 200 and ms.get("success") and len(pairs) == len(set(pairs)), len(pairs))
print("  mesh names (are names unique across worn items?):", sorted(m for _, m in pairs))

# export_for_unity refuses an Assets folder with no Unity project around it: mark %TEMP%\cc5_live as a stand-in project.
project_marker = os.path.join(tempfile.gettempdir(), "cc5_live", "ProjectSettings", "ProjectVersion.txt")
os.makedirs(os.path.dirname(project_marker), exist_ok=True)
with open(project_marker, "w", encoding="utf-8") as f:
    f.write("m_EditorVersion: 6000.2.10f1\n# Written by scripts/live_smoke_test.py; not a real Unity project.\n")
# injuries 'omit': an FBX carries no skin overlay or skin condition, and export_for_unity needs a choice once they exist.
r = job("export_for_unity", {"unity_dir": scratch, "character_name": "LiveTest", "sub_d_level": 0, "texture_size": 1024,
                             "injuries": "omit"})
r = r if isinstance(r, dict) else {}
ok("export_for_unity", bool(r.get("success") and os.path.exists(r.get("fbx", ""))), r.get("error") or r.get("fbx"))
ok("export_for_unity applied every setting (no WARNING notes)", bool(r.get("success")) and not warnings_in(r), warnings_in(r) or r.get("notes"))
# The export keeps the textures' source formats (Convert Image Format crashes CC5 5.13), so check every format read.
edges = [max(z) for z in (image_size(f["path"]) for f in r.get("files", [])
                          if f["path"].lower().endswith((".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"))) if z]
if edges:
    ok("export_for_unity texture_size 1024 reached the textures (SetTextureSize enum)", max(edges) <= 1024,
       f"largest edge {max(edges)}")
else:
    skip("export_for_unity texture_size 1024 reached the textures (SetTextureSize enum)",
         "no PNG, JPEG, TIFF or BMP textures written")
ok("/jobs/status answers within 5 s while a job runs", bool(STATUS_TIMES) and max(STATUS_TIMES) < 5, f"slowest {max(STATUS_TIMES or [0]):.2f}s")

obj_out = os.path.join(scratch, "obj", "live.obj")
s, r = call("POST", "/pipeline/export_obj", {"output_path": obj_out}); eo = res(r)
ok("export_obj (preferred call form, no WARNING notes)", eo.get("success") and not warnings_in(eo), eo)
# LIVE-VERIFY: the OBJ must hold the body mesh (part bits set). Also open live.obj once and confirm it is in CC5's
# T-pose, arms horizontal (F-83: no ResetToBindPose; replace_mesh_from_obj reads it back in that pose).
ok("export_obj has CC_Base_Body", os.path.exists(obj_out) and "CC_Base_Body" in file_text(obj_out), obj_out)
goz_dir = os.path.join(scratch, "goz")
r = job("export_goz", {"output_dir": goz_dir, "pose": "tpose"})
ok("export_goz (pose applied)", bool(r and r.get("success") and r.get("pose_applied")), r)
# Live CC5 5.13 appends file names straight onto the folder it is given (it once wrote <scratch>\gozCC_Base_Body.GoZ).
goz_files = [f for f in os.listdir(goz_dir) if f.lower().endswith(".goz")] if os.path.isdir(goz_dir) else []
ok("export_goz wrote its .GoZ files into the folder", bool(goz_files), goz_files[:3])
fbx = os.path.join(scratch, "LiveTest", "LiveTest.fbx")
# CC5 may stop on its own "Import Settings" (frame rate) dialog here: the job then waits until it is answered in CC5.
r = job("import_fbx", {"file_path": fbx, "kind": "prop"}); ok("import_fbx prop", bool(r and r.get("success") and not warnings_in(r)), r)
s, r = call("POST", "/pipeline/meshes", {}); meshes = res(r).get("meshes") or []; ok("list_meshes", bool(meshes), meshes[:3])
r = job("save_character", {"output_path": os.path.join(scratch, "base.ccAvatar")}); ok("save_character", bool(r and r.get("success")), r)
overlay = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "overlay.png")
s, r = call("POST", "/skin/overlay", {"image_path": overlay, "region": "head", "strength": 60}); ok("apply_skin_overlay", res(r).get("success"), res(r))
s, r = call("POST", "/skin/condition", {"condition": "pale", "amount": 0.8}); ok("set_skin_condition", res(r).get("success"), res(r))
# Live CC5 5.13: the neutral CC3_Base_Plus has no wrinkle data (SetWrinkleDetailStrength reports an error status for it),
# while a textured template such as CC4 Camila takes the strength (Task 18). So the check skips the neutral base.
first_avatar = next((a.get("name") for a in (res(call("GET", "/avatars")[1]) or []) if isinstance(a, dict)), None)
if first_avatar == "CC3_Base_Plus":
    skip("set_wrinkle_strength", "the neutral CC3_Base_Plus has no wrinkle data; run on a textured template (Task 18: CC4 Camila PASS)")
else:
    s, r = call("POST", "/skin/wrinkle", {"strength": 0.5}); ok("set_wrinkle_strength", res(r).get("success"), res(r))
s, r = call("POST", "/skin/overlay/remove", {"region": "head"}); ok("remove_skin_overlay", res(r).get("success"), res(r))
r = job("export_textures", {"output_dir": os.path.join(scratch, "sp"), "character_name": "LiveTex"})
ok("export_textures (no WARNING notes)", bool(r and r.get("success")) and not warnings_in(r), r)
tex = r if isinstance(r, dict) else {}
if tex.get("folder"):  # proves the LoadSubstancePainterTextures signature; the folder need not be a real Substance export
    r = job("load_substance_textures", {"folder": tex["folder"]}); ok("load_substance_textures", bool(r and r.get("success")), r)
else:
    skip("load_substance_textures", "export_textures failed")
mi2 = res(call("GET", "/material/info")[1])
skin = next(((k, m) for k, v in (mi2.get("meshes", {}) if isinstance(mi2, dict) else {}).items() if isinstance(v, list) for m in v if "skin" in str(m).lower()), None)
if skin:
    s, r = call("POST", "/pipeline/load_texture", {"mesh_name": skin[0], "material_name": skin[1], "channel": "diffuse_blend", "image_path": overlay}); ok("load_texture", res(r).get("success"), res(r))
    call("POST", "/undo")
else:
    skip("load_texture", "no skin material")
body = next((m for m in meshes if "body" in str(m).lower()), meshes[0] if meshes else None)
if body and os.path.exists(obj_out):  # unedited OBJ back onto the same mesh: proves ReplaceMesh(name, path, False, False)
    # F-83: the round trip must be checked (check_max_cm, 0.00 cm when CC5 read the OBJ as written); one undo takes
    # back the replace and the pose it removed.
    r = job("replace_mesh_from_obj", {"mesh_name": body, "obj_path": obj_out})
    ok("replace_mesh_from_obj (round trip checked)",
       bool(r and r.get("success")) and isinstance(r.get("check_max_cm"), (int, float)), r)
    call("POST", "/undo")
else:
    skip("replace_mesh_from_obj", "no mesh or export_obj failed")
prof = os.environ.get("CC5_LIVE_FACIAL_PROFILE", "")
if os.path.isfile(prof):
    s, r = call("POST", "/builder/facial_profile", {"file_path": prof}); ok("load_facial_profile", res(r).get("success"), res(r))
else:
    skip("load_facial_profile", "set CC5_LIVE_FACIAL_PROFILE to a facial profile file")
poses = []
for ft in ("pose", "motion"):
    got = res(call("POST", "/content/browse", {"folder_type": ft})[1])
    poses += [p for p in (got if isinstance(got, list) else []) if isinstance(p, str) and os.path.isabs(p)]
print("  pose/motion extensions:", sorted({os.path.splitext(p)[1].lower() for p in poses}))
POSE_EXTS = (".rlmotion", ".imotion", ".rlpose", ".ipose", ".imotionplus", ".ccpose", ".ccmotion")  # = cc5_pipeline.POSE_EXTENSIONS
pose = os.environ.get("CC5_LIVE_POSE") or next((p for p in poses if os.path.splitext(p)[1].lower() in POSE_EXTS), None)
if pose:
    r = job("apply_pose", {"file_path": pose}); ok("apply_pose", bool(r and r.get("success")), r)
    if r and r.get("success"):
        # Requirement 3: the pose must reach Unity. Step 4 opens LivePosed.fbx in Unity to check the mesh is posed.
        # pale 0.8 from set_skin_condition above is still on: without injuries the export would not run.
        r = job("export_for_unity", {"unity_dir": scratch, "character_name": "LivePosed", "sub_d_level": 0,
                                     "texture_size": 1024, "include_current_pose": True, "injuries": "omit"})
        ok("export_for_unity include_current_pose (Step 4: is LivePosed.fbx posed in Unity?)",
           bool(r and r.get("success")) and not warnings_in(r), r)
elif poses:
    ok("apply_pose accepts browse_content pose/motion files", False, "add the printed extensions to POSE_EXTENSIONS (py + ts)")
else:
    skip("apply_pose", "no pose/motion content installed; set CC5_LIVE_POSE to a .rlMotion/.iMotion file")
for ft in ("makeup_full", "makeup_foundation", "makeup_eye", "makeup_lip", "image_layer", "skingen", "wrinkle_mask", "texture"):
    s, r = call("POST", "/content/browse", {"folder_type": ft}); listing = res(r)
    files = listing if isinstance(listing, list) else []
    if s != 200 or not isinstance(listing, list) or (len(files) == 1 and str(files[0]).startswith(("Unknown folder type", "Content browsing not available", "No content folder resolved", "Error browsing content"))):
        ok(f"browse {ft}", False, listing)
    elif files:
        ok(f"browse {ft}", True, files[:2])
    else:
        skip(f"browse {ft}", "folder resolved but empty (no content installed, or files filtered by extension; see Step 3)")
# Resolved in Task 18: live CC5 5.13 lists only .iImgLayer stage items under image_layer, so apply_skin_overlay and
# create_character ask the user for PNG/JPG/TGA overlays instead of pointing at image_layer. Printed for the record.
layers = [p for p in (res(call("POST", "/content/browse", {"folder_type": "image_layer"})[1]) or []) if isinstance(p, str)]
images = [p for p in layers if os.path.splitext(p)[1].lower() in (".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff")]
print(f"  image_layer: {len(layers)} item(s), {len(images)} of them overlay images")
s, r = call("POST", "/content/browse", {"folder_type": "shoes"})
shoe_files = [p for p in (res(r) if isinstance(res(r), list) else []) if isinstance(p, str) and os.path.isabs(p)]
if shoe_files:
    stem = os.path.splitext(os.path.basename(shoe_files[0]))[0]
    s, r = call("POST", "/content/browse", {"folder_type": "shoes", "query": stem})
    hits = [p for p in (res(r) if isinstance(res(r), list) else []) if isinstance(p, str) and os.path.isabs(p)]
    ok("browse_content query filters by file name before the 200-file cap", shoe_files[0] in hits and
       all(all(w in os.path.basename(h).lower() for w in stem.lower().split()) for h in hits), f"'{stem}': {len(hits)} hit(s)")
    # Does GetContentFilesInFolder recurse into subfolders? More than one folder here (or files in a subfolder) says yes.
    print("  shoe folders listed:", sorted({os.path.dirname(p) for p in shoe_files})[:5])
else:
    skip("browse_content query filters by file name before the 200-file cap", "no shoes content")
cloth = os.environ.get("CC5_LIVE_CLOTH_FBX", "")
if os.path.isfile(cloth):
    r = job("import_fbx", {"file_path": cloth, "kind": "clothing"}); ok("import_fbx clothing", bool(r and r.get("success")), r)
    print("  clothing meshes that did not import:", (r or {}).get("failed_meshes"))
else:
    skip("import_fbx clothing", "set CC5_LIVE_CLOTH_FBX to a clothing FBX")
# Switched off (Chad's ruling, 2026-10-03): a whole-character import and Headshot both crashed live CC5 5.13. The
# installed plugin must refuse them with its "do it by hand in CC5" message before touching CC5. The paths do not
# exist, so an older plugin that still runs them fails on the missing file (and this check FAILs) instead of
# crashing CC5. Never point these checks at a real file.
missing = os.path.join(scratch, "no-such-file")
r = job("import_fbx", {"file_path": missing + ".fbx", "kind": "character"}, timeout=30)
ok("import_fbx character is switched off (do it by hand in CC5)", bool(r) and r.get("success") is False and
   "switched off" in str(r.get("error")) and "File > Import in Character Creator 5" in str(r.get("error")), r)
r = job("headshot_from_photo", {"photo_path": missing + ".jpg"}, timeout=30)
ok("headshot_from_photo is switched off (do it by hand in CC5)", bool(r) and r.get("success") is False and
   "switched off" in str(r.get("error")) and "Headshot plugin inside Character Creator 5" in str(r.get("error")), r)
# Last: CC5 5.13 has no Bake / Apply Skin / Skin Editor command (SkinGen's menu holds About, Online Manual, Video
# Tutorial and Remove SkinGen Data), so bake_skin_textures must answer with the manual steps and open nothing. It used to
# trigger SkinGen's About box, a window with no buttons that blocked every later command until it was closed (F-84).
s, r = call("POST", "/skin/bake", {}, timeout=120); bk = res(r)
bk = bk if isinstance(bk, dict) else {}
ok("bake_skin_textures answers without opening a window",
   answered(s, r) and bk.get("manual_step_required") is True and not bk.get("triggered_action"), bk.get("error") or s)
print("  skin commands bake_skin_textures looked at:", bk.get("candidates_inspected"))
time.sleep(1)
s, r = call("GET", "/avatars")
ok("bake_skin_textures leaves no modal dialog open", s == 200, "" if s == 200 else (r or {}).get("error"))
print(f"  slowest /jobs/status answer: {max(STATUS_TIMES or [0]):.2f}s over {len(STATUS_TIMES)} polls")
if SLOW:
    print("  direct calls over 20 s (the bridge stops waiting at 30 s; make them jobs):", "; ".join(SLOW))

print(f"\n==== {len(P)} PASS / {len(F)} FAIL / {len(S)} SKIP ====")
if F:
    print("FAILED:", ", ".join(F))
if S:
    print("SKIPPED:", ", ".join(S))
sys.exit(1 if F else 0)

#!/usr/bin/env python3
"""End-to-end pipeline check: a patient built with this repo's MCP tools goes CC5 -> Blender -> Unity.

    npm run build
    py -3 scripts/e2e/run_e2e.py --blender "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"

Prerequisites: CC5 running with the bridge up and no dialog open (answer any recovery prompt in CC5 first);
build/ up to date; Blender and Unity 6000.2.10f1 installed (Unity signed in). See scripts/e2e/README.md.

CC5 leg: starts the built MCP server (node build/index.js) and speaks MCP JSON-RPC over stdio, so the run
goes through the same TypeScript tools an agent uses (apply_character_recipe, check_quest_budget,
save_character, export_for_unity, export_fbx, apply_pose, job_status). Steps with no TypeScript logic
(get_mesh_stats, which has no MCP tool, and the alive checks) call the bridge's HTTP endpoints directly.
Blender leg: blender_check.py in background mode. Unity leg: a throwaway project under the scratch root,
Editor/E2EImportCheck.cs in batch mode.

Writes <scratch>/e2e-report.md and <scratch>/e2e-results.json, and exits 1 if any step FAILs. Every run
first deletes the outputs of the previous one (<scratch>/cc5, <scratch>/blender, Assets/E2E of the project).
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
TEMPLATES = "C:/Users/Public/Documents/Reallusion/Reallusion Templates"
DEFAULTS = {
    "scratch": os.path.join(tempfile.gettempdir(), "cc5-e2e"),
    "blender": "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe",
    "unity": "C:/Program Files/Unity/Hub/Editor/6000.2.10f1/Editor/Unity.exe",
    "base": f"{TEMPLATES}/Actor/Character/CC4 Kevin.ccAvatar",
    "pose": f"{TEMPLATES}/Animation/Pose/1.Male Pose/Sitting_Floor.rlPose",
    "overlay": os.path.join(REPO, "scripts", "fixtures", "overlay.png"),
}
BRIDGE_URL = os.environ.get("CC5_BRIDGE_URL", "http://127.0.0.1:5101")
TOKEN_FILE = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "CC5_MCP_Bridge", "token")
PROJECT_MARKER = "cc5-e2e-project.txt"
NAME = "E2E_Patient"
POSED = "E2E_Patient_Posed"
FROM_BLENDER = "E2E_Patient_from_Blender"
EXPORT_TIMEOUT_S = 600  # exports hold CC5's GIL, so status polls stall while they run
POSE_MOVE_M = 0.05
TRIANGLE_TOLERANCE_PCT = 5.0
ECHO = False  # main() prints each step as it is recorded


# ---------------------------------------------------------------- results and report (unit-tested)

def new_run(params: dict) -> dict:
    return {"params": params, "started": datetime.datetime.now().isoformat(timespec="seconds"), "steps": [],
            "cc5": {}, "blender": {}, "unity": {}, "pose": {}, "triangles": []}


def record(run: dict, leg: str, name: str, ok: bool, detail: str, seconds: float, via: str) -> bool:
    run["steps"].append({"leg": leg, "name": name, "status": "PASS" if ok else "FAIL", "detail": detail,
                         "seconds": round(seconds, 1), "via": via})
    if ECHO:
        print(f"[{'PASS' if ok else 'FAIL'}] {leg}: {name} ({seconds:.1f} s) {detail.splitlines()[0] if detail else ''}",
              flush=True)
    return ok


def exit_code(run: dict) -> int:
    return 0 if run["steps"] and all(s["status"] == "PASS" for s in run["steps"]) else 1


def job_id_from_text(text: str) -> str | None:
    m = re.match(r"Still running in CC5 \(job (cmd_[0-9a-f_]+)\)", text or "")
    return m.group(1) if m else None


def within_percent(value: float, reference: float, pct: float) -> bool:
    return reference > 0 and abs(value - reference) / reference * 100 <= pct


def mesh_triangle_differences(cc5_meshes: list[dict], unity_renderers: list[dict]) -> list[str]:
    cc5: dict[str, int] = {}
    for m in cc5_meshes:
        cc5[m["mesh"]] = cc5.get(m["mesh"], 0) + int(m["triangles"])
    unity: dict[str, int] = {}
    for r in unity_renderers:
        unity[r["name"]] = unity.get(r["name"], 0) + int(r["triangles"])
    fmt = lambda n: "(missing)" if n is None else f"{n:,}"  # noqa: E731
    return [f"{name}: CC5 {fmt(cc5.get(name))}, Unity {fmt(unity.get(name))}"
            for name in list(cc5) + [n for n in unity if n not in cc5] if cc5.get(name) != unity.get(name)]


def _positions(bones: list[dict]) -> dict[str, tuple[float, float, float]]:
    return {b["name"]: (b["x"], b["y"], b["z"]) for b in bones or []}


def _distances(base: dict, other: dict) -> dict[str, float]:
    return {n: round(sum((a - b) ** 2 for a, b in zip(base[n], other[n])) ** 0.5, 6) for n in base if n in other}


def pose_check(unposed: dict, posed: dict, threshold: float = POSE_MOVE_M) -> tuple[str, str, dict]:
    """PASS when a head/hand/foot bone of the posed model sits more than `threshold` (m) away from the
    unposed model's, as imported or after sampling the posed model's first clip at time 0."""
    base = _positions(unposed.get("bonesStatic"))
    dist = {"static": _distances(base, _positions(posed.get("bonesStatic"))),
            "sampled": _distances(base, _positions(posed.get("bonesSampled"))) if posed.get("sampled") else {}}
    if not base:
        return "FAIL", f"head/hand/foot bones not found in {unposed.get('path')}", dist
    if not dist["static"] and not dist["sampled"]:
        return "FAIL", f"head/hand/foot bones not found in {posed.get('path')}", dist
    static_max = max(dist["static"].values(), default=0.0)
    sampled_max = max(dist["sampled"].values(), default=0.0)
    if static_max > threshold:
        return "PASS", f"posed as imported (largest bone move {static_max:.3f} m)", dist
    if sampled_max > threshold:
        clip = (posed.get("clips") or ["?"])[0]
        return "PASS", (f"posed after sampling its clip '{clip}' at time 0 (largest bone move {sampled_max:.3f} m); "
                        f"as imported the model shows the bind pose (largest move {static_max:.3f} m)"), dist
    sampled = f", {sampled_max:.3f} m after sampling its clip" if posed.get("sampled") else ", and it has no clip"
    return "FAIL", (f"came in in the bind pose: largest bone move {static_max:.3f} m as imported{sampled} "
                    f"(needs more than {threshold} m)"), dist


def unity_skin_texture_check(model: dict) -> tuple[bool, str]:
    skin = [m for m in model.get("materials", []) if "skin" in m["name"].lower()]
    if not skin:
        return False, f"no skin material in {os.path.basename(model.get('path', ''))}"
    missing = [m["name"] for m in skin if not m.get("mainTexture")]
    detail = f"{len(skin) - len(missing)}/{len(skin)} skin materials have a main texture"
    return not missing, detail + (f"; missing: {', '.join(missing)}" if missing else "")


def blender_texture_check(report: dict) -> tuple[bool, str]:
    images = report.get("images", [])
    unresolved = [i["name"] for i in images if not i.get("resolved")]
    skin = [m for m in report.get("materials", []) if "skin" in m["name"].lower()]
    untextured = [m["name"] for m in skin if not m.get("images")]
    parts = [f"{len(images) - len(unresolved)}/{len(images)} images resolved on disk"]
    if unresolved:
        parts.append(f"unresolved: {', '.join(unresolved)}")
    if not skin:
        parts.append("no skin material")
    elif untextured:
        parts.append(f"skin materials without an image texture: {', '.join(untextured)}")
    else:
        parts.append(f"all {len(skin)} skin materials have image textures")
    return not unresolved and bool(skin) and not untextured, "; ".join(parts)


def _cell(text) -> str:
    text = " ".join(str(text).split())
    text = text if len(text) <= 400 else text[:397] + "..."
    return text.replace("|", "\\|")


def render_report(run: dict) -> str:
    overall = "PASS" if exit_code(run) == 0 else "FAIL"
    p = run.get("params", {})
    out = [
        "# CC5 -> Blender -> Unity end-to-end check", "",
        f"**Overall: {overall}**", "",
        f"Started {run.get('started')}, finished {run.get('finished', '?')}, {run.get('seconds', '?')} s in total.",
    ]
    for key in ("base", "pose", "overlay", "blender", "unity", "scratch"):
        if p.get(key):
            out.append(f"- {key}: `{p[key]}`")
    for key in ("cc5_version", "blender_version", "unity_version"):
        if run.get(key):
            out.append(f"- {key.replace('_', ' ')}: {run[key]}")
    out += ["", "## Steps", "", "| Leg | Step | Result | Via | Time | Detail |", "|---|---|---|---|---|---|"]
    for s in run["steps"]:
        out.append(f"| {s['leg']} | {_cell(s['name'])} | {s['status']} | {s['via']} | {s['seconds']} s | {_cell(s['detail'])} |")

    legs = run.get("legs", [])
    if legs:
        out += ["", "## Legs", "", "| Leg | Result | Triangles | Materials | Textures | Bones | Warnings | Time |",
                "|---|---|---|---|---|---|---|---|"]
        for leg in legs:
            out.append("| " + " | ".join(_cell(leg.get(k, "-")) for k in
                                         ("leg", "result", "triangles", "materials", "textures", "bones", "warnings",
                                          "time")) + " |")

    models = run["unity"].get("models", [])
    if models:
        out += ["", "## Unity models", "",
                "| Model | Imported | Renderers (skinned / mesh) | Triangles | Materials | With main texture | "
                "Missing textures | Rig | Bones | Clips | Warnings | Errors | Import time |",
                "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for m in models:
            out.append(
                f"| {os.path.basename(m['path'])} | {'yes' if m.get('imported') else 'NO'} | "
                f"{m.get('skinnedRenderers', 0)} / {m.get('meshRenderers', 0)} | {m.get('triangles', 0):,} | "
                f"{m.get('materialCount', 0)} | {m.get('materialsWithMainTexture', 0)} | "
                f"{_cell(', '.join(m.get('missingTextures', [])) or '-')} | {m.get('animationType', '')} | "
                f"{m.get('bones', 0)} | {_cell(', '.join(m.get('clips', [])) or '-')} | {len(m.get('warnings', []))} | "
                f"{len(m.get('errors', []))} | {m.get('seconds', 0):.1f} s |")

    if run["triangles"]:
        out += ["", "## Triangles", "", "| Source | Triangles | vs CC5 get_mesh_stats |", "|---|---|---|"]
        out += [f"| {_cell(t['source'])} | {t['triangles']:,} | {_cell(t['vs_cc5'])} |" for t in run["triangles"]]

    for key, title in (("budget", "Quest budget (scene, before export)"),
                       ("budget_export", "Quest budget (E2E_Patient export folder, sub_d_level 0)")):
        if run["cc5"].get(key):
            out += ["", f"## {title}", "", "```", run["cc5"][key], "```"]

    pose = run.get("pose") or {}
    if pose.get("static") or pose.get("sampled"):
        out += ["", f"## Pose: bone distance from {NAME} (Unity units, m)", "",
                "| Bone | as imported | after sampling the clip |", "|---|---|---|"]
        for bone in sorted(set(pose.get("static", {})) | set(pose.get("sampled", {}))):
            s, c = pose.get("static", {}).get(bone), pose.get("sampled", {}).get(bone)
            out.append(f"| {bone} | {'-' if s is None else f'{s:.3f}'} | {'-' if c is None else f'{c:.3f}'} |")

    warned = [(os.path.basename(m["path"]), kind, msg) for m in models
              for kind in ("errors", "warnings") for msg in m.get(kind, [])]
    if warned:
        out += ["", "## Unity importer messages", ""]
        out += [f"- {model} ({kind[:-1]}): {_cell(msg)}" for model, kind, msg in warned[:60]]
        if len(warned) > 60:
            out.append(f"- ... {len(warned) - 60} more in e2e-results.json")
    return "\n".join(out) + "\n"


def unity_project_error(path: str) -> str | None:
    """None if `path` is missing (the script creates it) or is a project this script created."""
    if not os.path.exists(path) or os.path.isfile(os.path.join(path, PROJECT_MARKER)):
        return None
    return (f"{path} exists but is not a project this script created (no {PROJECT_MARKER}); "
            "delete it or pass another --scratch")


def stand_in_unity_project(root: str) -> str:
    """Write <root>/ProjectSettings/ProjectVersion.txt: export_for_unity refuses an Assets folder with no Unity project
    around it, and the CC5 leg exports into <root>/Assets before the Unity leg copies the files into a real project."""
    marker = os.path.join(root, "ProjectSettings", "ProjectVersion.txt")
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, "w", encoding="utf-8") as f:
        f.write("m_EditorVersion: 6000.2.10f1\n"
                "# Written by cc5-mcp-server scripts/e2e/run_e2e.py so that export_for_unity accepts this folder; "
                "it is not a real Unity project.\n")
    return marker


# ---------------------------------------------------------------- CC5 bridge and MCP client

class Bridge:
    """Direct bridge HTTP calls, for steps with no TypeScript logic. Reads the token per call, never prints it."""

    @staticmethod
    def _token() -> str:
        if os.environ.get("CC5_BRIDGE_TOKEN", "").strip():
            return os.environ["CC5_BRIDGE_TOKEN"].strip()
        try:
            with open(TOKEN_FILE, encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def call(self, method: str, path: str, body=None, timeout: float = 60) -> tuple[int | None, object]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BRIDGE_URL + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", "X-CC5-Token": self._token()})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            with e:
                raw = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(raw or "{}")
            except ValueError:
                return e.code, raw
        except Exception as e:  # refused, reset, timed out: CC5 is not answering
            return None, str(e)


def result_of(body):
    return body.get("result", body) if isinstance(body, dict) else body


class McpClient:
    """Speaks MCP JSON-RPC (newline-delimited, stdio) to the built server, like an agent's MCP client."""

    def __init__(self, log_path: str):
        self.log = open(log_path, "w", encoding="utf-8")
        self.proc = subprocess.Popen(["node", os.path.join(REPO, "build", "index.js")], cwd=REPO,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        self.lines: queue.Queue = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for raw in self.proc.stdout:
            self.lines.put(raw)
        self.lines.put(None)

    def _send(self, msg: dict) -> None:
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    def request(self, method: str, params: dict, timeout: float) -> dict:
        self.next_id += 1
        rid = self.next_id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no MCP reply to {method} within {timeout:.0f} s")
            try:
                raw = self.lines.get(timeout=remaining)
            except queue.Empty:
                continue
            if raw is None:
                raise RuntimeError(f"the MCP server exited (code {self.proc.poll()}); see {self.log.name}")
            msg = json.loads(raw)
            if msg.get("id") == rid and ("result" in msg or "error" in msg):
                return msg
            # Anything else is a notification (e.g. the recipe's progress) or a late reply: not ours.

    def initialize(self) -> dict:
        r = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                        "clientInfo": {"name": "cc5-e2e", "version": "1.0"}}, 30)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return r["result"]

    def tool_names(self) -> list[str]:
        return [t["name"] for t in self.request("tools/list", {}, 30)["result"]["tools"]]

    def call_tool(self, name: str, arguments: dict, timeout: float) -> tuple[bool, str]:
        """(is_error, text) of one tools/call."""
        msg = self.request("tools/call", {"name": name, "arguments": arguments}, timeout)
        if "error" in msg:
            return True, f"MCP error {msg['error'].get('code')}: {msg['error'].get('message')}"
        res = msg["result"]
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        return bool(res.get("isError")), text

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        self.log.close()


def tool_until_done(mcp: McpClient, name: str, arguments: dict, timeout: float) -> tuple[bool, str, str]:
    """Call a job-backed tool and, while it says 'Still running', poll job_status. (is_error, text, via)."""
    deadline = time.monotonic() + timeout
    is_error, text = mcp.call_tool(name, arguments, timeout)
    via = "MCP"
    job_id = None if is_error else job_id_from_text(text)
    while job_id and time.monotonic() < deadline:
        via = "MCP + job_status"
        time.sleep(5)
        is_error, text = mcp.call_tool("job_status", {"job_id": job_id}, 120)
        if is_error or not text.startswith("Still running"):
            return is_error, text, via
    if job_id:
        return True, f"still running after {timeout:.0f} s (job {job_id})", via
    return is_error, text, via


def cc5_pid() -> str:
    try:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH", "/FI", "IMAGENAME eq CharacterCreator.exe"],
                             capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return ""
    m = re.search(r'"CharacterCreator\.exe","(\d+)"', out)
    return m.group(1) if m else ""


class LegAborted(Exception):
    """A step the rest of the leg depends on failed; it is already recorded as FAIL."""


# ---------------------------------------------------------------- legs

def cc5_leg(run: dict, a: argparse.Namespace, bridge: Bridge) -> None:
    leg = "CC5"
    out = os.path.join(a.scratch, "cc5")
    unity_dir = os.path.join(out, "Unity", "Assets", "Patients")
    t0 = time.monotonic()
    status, body = bridge.call("GET", "/health", timeout=10)
    if not record(run, leg, "bridge /health", status == 200, f"{BRIDGE_URL} answered {status}",
                  time.monotonic() - t0, "bridge HTTP"):
        raise LegAborted
    run["cc5"]["pid_start"] = cc5_pid()
    t0 = time.monotonic()
    status, body = bridge.call("GET", "/avatars", timeout=30)
    if not record(run, leg, "no modal dialog open (GET /avatars answers)", status == 200,
                  "ok" if status == 200 else f"HTTP {status}: {result_of(body)} (answer the dialog in CC5, then re-run)",
                  time.monotonic() - t0, "bridge HTTP"):
        raise LegAborted
    for path, what in ((a.overlay, "--overlay"), (a.pose, "--pose")) + (((a.base, "--base"),) if a.base != "default" else ()):
        if not record(run, leg, f"input {what} exists", os.path.isfile(path), path, 0, "file system"):
            raise LegAborted
    # export_for_unity needs a Unity project around its Assets folder (main() deleted <scratch>/cc5 before this run).
    stand_in_unity_project(os.path.join(out, "Unity"))

    mcp = McpClient(os.path.join(a.scratch, "mcp-server.log"))
    try:
        t0 = time.monotonic()
        info = mcp.initialize()
        names = mcp.tool_names()
        needed = ["apply_character_recipe", "check_quest_budget", "save_character", "export_for_unity",
                  "export_fbx", "apply_pose", "job_status"]
        missing = [n for n in needed if n not in names]
        if not record(run, leg, "MCP server starts (node build/index.js)", not missing,
                      f"{info.get('serverInfo', {}).get('name')} {info.get('serverInfo', {}).get('version')}, "
                      f"{len(names)} tools" + (f"; missing {missing}" if missing else ""),
                      time.monotonic() - t0, "MCP"):
            raise LegAborted
        _cc5_steps(run, a, bridge, mcp, out, unity_dir)
    finally:
        mcp.close()
        run["cc5"]["pid_end"] = cc5_pid()


def _alive_after_export(run: dict, bridge: Bridge, what: str) -> bool:
    time.sleep(10)
    t0 = time.monotonic()
    health, _ = bridge.call("GET", "/health", timeout=10)
    avatars, _ = bridge.call("GET", "/avatars", timeout=30)
    pid = cc5_pid()
    ok = health == 200 and avatars == 200
    hint = "" if ok else "; CC5 crashed or hung: restart it, answer its recovery prompt in CC5, then re-run"
    return record(run, "CC5", f"CC5 alive 10 s after {what}", ok,
                  f"/health {health}, /avatars {avatars}, CharacterCreator.exe pid {pid or 'none'}{hint}",
                  time.monotonic() - t0 + 10, "bridge HTTP")


def _export_unity(run, a, bridge, mcp, unity_dir, name, posed: bool) -> bool:
    # The recipe puts an overlay (60) and pale (0.6) on the patient: an FBX carries neither, and export_for_unity
    # will not export them without a choice. This check is about the FBX itself, so they are left out.
    args = {"unity_dir": unity_dir, "character_name": name, "sub_d_level": 0, "texture_size": 2048, "wait_seconds": 120,
            "injuries": "omit"}
    if posed:
        args["include_current_pose"] = True
    t0 = time.monotonic()
    is_error, text, via = tool_until_done(mcp, "export_for_unity", args, EXPORT_TIMEOUT_S)
    fbx = os.path.join(unity_dir, name, name + ".fbx")
    ok = not is_error and os.path.isfile(fbx)
    record(run, "CC5", f"export_for_unity {name}" + (" (include_current_pose)" if posed else ""), ok,
           text if ok else f"{text} (FBX on disk: {os.path.isfile(fbx)})", time.monotonic() - t0, via)
    alive = _alive_after_export(run, bridge, f"export_for_unity {name}")
    return ok and alive


def _cc5_steps(run, a, bridge, mcp, out, unity_dir) -> None:
    leg = "CC5"
    recipe = {
        "base": a.base,
        "body_preset": {"preset": "slim", "intensity": 0.5},
        "skin_condition": {"condition": "pale", "amount": 0.6},
        "overlays": [{"image_path": a.overlay, "region": "all", "strength": 60}],
        "expression": [{"name": "Brow_Compress_L", "weight": 0.6}, {"name": "Brow_Compress_R", "weight": 0.6},
                       {"name": "Mouth_Frown_L", "weight": 0.4}, {"name": "Mouth_Frown_R", "weight": 0.4},
                       {"name": "Eye_Squint_L", "weight": 0.3}, {"name": "Eye_Squint_R", "weight": 0.3}],
    }
    run["cc5"]["recipe"] = recipe
    t0 = time.monotonic()
    is_error, text = mcp.call_tool("apply_character_recipe", {"recipe": recipe}, 900)
    if not record(run, leg, "apply_character_recipe", not is_error, text, time.monotonic() - t0, "MCP"):
        raise LegAborted

    t0 = time.monotonic()
    status, body = bridge.call("POST", "/pipeline/mesh_stats", {}, timeout=60)
    stats = result_of(body) if status == 200 else {}
    run["cc5"]["mesh_stats"] = stats
    ok = status == 200 and isinstance(stats, dict) and stats.get("success") is True
    totals = stats.get("totals", {}) if ok else {}
    if not record(run, leg, "get_mesh_stats (no MCP tool; check_quest_budget reads it)", ok,
                  f"{totals.get('triangles', 0):,} triangles, {totals.get('materials', 0)} materials, "
                  f"{len(stats.get('meshes', []))} meshes" if ok else f"HTTP {status}: {result_of(body)}",
                  time.monotonic() - t0, "bridge HTTP"):
        raise LegAborted

    t0 = time.monotonic()
    is_error, text = mcp.call_tool("check_quest_budget", {}, 120)
    run["cc5"]["budget"] = text
    record(run, leg, "check_quest_budget (triangles, materials)", text.startswith(("PASS", "FAIL", "NOT CHECKED")),
           f"verdict: {text.splitlines()[0] if text else '(empty)'}", time.monotonic() - t0, "MCP")

    # CC5 5.13 can crash on the first FBX export after a launch: save the character first.
    saved = os.path.join(out, NAME + ".ccAvatar")
    t0 = time.monotonic()
    is_error, text, via = tool_until_done(mcp, "save_character", {"output_path": saved}, EXPORT_TIMEOUT_S)
    if not record(run, leg, "save_character (before the first export)", not is_error and os.path.isfile(saved),
                  text, time.monotonic() - t0, via):
        raise LegAborted

    # A throwaway export first, so the checked exports are never the session's first (which CC5 5.13 often
    # crashes on, README "Known issues"). If CC5 dies here, nothing checked was lost: restart and re-run.
    warm = os.path.join(out, "warmup", "warmup.fbx")
    os.makedirs(os.path.dirname(warm), exist_ok=True)
    t0 = time.monotonic()
    is_error, text = mcp.call_tool("export_fbx", {"output_path": warm, "target_tool": "Unity", "sub_d_level": 0,
                                                  "texture_size": 512}, EXPORT_TIMEOUT_S)
    record(run, leg, "warm-up export_fbx (absorbs CC5 5.13's first-export crash)",
           not is_error and os.path.isfile(warm), text, time.monotonic() - t0, "MCP")
    if not _alive_after_export(run, bridge, "the warm-up export"):
        raise LegAborted

    if not _export_unity(run, a, bridge, mcp, unity_dir, NAME, posed=False):
        raise LegAborted
    folder = os.path.join(unity_dir, NAME)
    run["cc5"]["unity_export_files"] = sorted(os.listdir(folder))
    t0 = time.monotonic()
    is_error, text = mcp.call_tool("check_quest_budget", {"export_folder": folder, "sub_d_level": 0}, 120)
    run["cc5"]["budget_export"] = text
    record(run, leg, "check_quest_budget on the E2E_Patient export (textures too)",
           text.startswith(("PASS", "FAIL", "NOT CHECKED")), f"verdict: {text.splitlines()[0] if text else '(empty)'}",
           time.monotonic() - t0, "MCP")

    blender_fbx = os.path.join(out, "Blender", NAME + ".fbx")
    os.makedirs(os.path.dirname(blender_fbx), exist_ok=True)
    t0 = time.monotonic()
    is_error, text = mcp.call_tool("export_fbx", {"output_path": blender_fbx, "target_tool": "Blender",
                                                  "sub_d_level": 0, "texture_size": 2048}, EXPORT_TIMEOUT_S)
    sidecar = os.path.splitext(blender_fbx)[0] + ".json"
    ok = not is_error and os.path.isfile(blender_fbx) and os.path.isfile(sidecar)
    record(run, leg, "export_fbx target_tool Blender (+ JSON sidecar)", ok,
           f"{text} (FBX on disk: {os.path.isfile(blender_fbx)}, sidecar: {os.path.isfile(sidecar)})",
           time.monotonic() - t0, "MCP")
    if not _alive_after_export(run, bridge, "export_fbx Blender"):
        raise LegAborted

    t0 = time.monotonic()
    is_error, text, via = tool_until_done(mcp, "apply_pose", {"file_path": a.pose}, EXPORT_TIMEOUT_S)
    if not record(run, leg, f"apply_pose {os.path.basename(a.pose)}", not is_error, text, time.monotonic() - t0, via):
        raise LegAborted
    _export_unity(run, a, bridge, mcp, unity_dir, POSED, posed=True)


def blender_leg(run: dict, a: argparse.Namespace) -> None:
    leg = "Blender"
    src = os.path.join(a.scratch, "cc5", "Blender", NAME + ".fbx")
    out_dir = os.path.join(a.scratch, "blender")
    out_fbx = os.path.join(out_dir, FROM_BLENDER, FROM_BLENDER + ".fbx")
    report_path = os.path.join(out_dir, "blender-report.json")
    if not record(run, leg, "Blender found", os.path.isfile(a.blender), f"{a.blender} (pass --blender)", 0, "file system"):
        raise LegAborted
    if not record(run, leg, "input: CC5 Blender-preset FBX", os.path.isfile(src), src, 0, "file system"):
        raise LegAborted
    os.makedirs(out_dir, exist_ok=True)
    cmd = [a.blender, "-b", "--factory-startup", "--python-exit-code", "1", "--python",
           os.path.join(HERE, "blender_check.py"), "--", "--fbx", src, "--out", out_fbx, "--report", report_path]
    t0 = time.monotonic()
    with open(os.path.join(out_dir, "blender.log"), "w", encoding="utf-8") as log:
        try:
            code = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=1200).returncode
        except subprocess.TimeoutExpired:
            code = "timeout (20 min)"
    seconds = time.monotonic() - t0
    rep = {}
    if os.path.isfile(report_path):
        with open(report_path, encoding="utf-8") as f:
            rep = json.load(f)
    run["blender"] = rep
    run["blender_version"] = rep.get("blender_version", "")
    ok = code == 0 and rep.get("ok") is True
    detail = (f"exit {code}; {rep.get('mesh_objects', 0)} mesh objects, {rep.get('triangles', 0):,} triangles, "
              f"{rep.get('bones', 0)} bones, {len(rep.get('materials', []))} materials, "
              f"{rep.get('shape_keys', 0)} shape keys; import {rep.get('import_seconds')} s, "
              f"export {rep.get('export_seconds')} s" + (f"; {rep['error']}" if rep.get("error") else ""))
    if not record(run, leg, "import CC5 FBX and re-export (blender_check.py)", ok, detail, seconds, "Blender -b"):
        raise LegAborted
    record(run, leg, "armature and bones", rep.get("bones", 0) > 0,
           ", ".join(f"{x['name']}: {x['bones']} bones" for x in rep.get("armatures", [])) or "no armature", 0, "analysis")
    ok, detail = blender_texture_check(rep)
    record(run, leg, "image textures resolved on disk", ok, detail, 0, "analysis")
    cc5_tris = run["cc5"].get("mesh_stats", {}).get("totals", {}).get("triangles", 0)
    record(run, leg, f"triangles vs CC5 get_mesh_stats (within {TRIANGLE_TOLERANCE_PCT:g}%)",
           within_percent(rep.get("triangles", 0), cc5_tris, TRIANGLE_TOLERANCE_PCT),
           f"Blender {rep.get('triangles', 0):,}, CC5 {cc5_tris:,}", 0, "analysis")
    export = rep.get("export", {})
    record(run, leg, f"export {FROM_BLENDER}.fbx", export.get("exists") is True,
           f"{export.get('path')} ({export.get('bytes', 0) / 1_048_576:.1f} MB; folder: "
           f"{', '.join(export.get('files_in_folder', []))})", 0, "analysis")


def _licensing_lines(log_path: str) -> list[str]:
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            return [ln.strip() for ln in f if "licens" in ln.lower() and ("error" in ln.lower() or "fail" in ln.lower())][:10]
    except OSError:
        return []


def _run_unity(cmd: list[str], log_path: str, timeout: float) -> tuple[int | str, float]:
    t0 = time.monotonic()
    try:
        code = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        code = f"timeout ({timeout / 60:.0f} min)"
    return code, time.monotonic() - t0


def unity_leg(run: dict, a: argparse.Namespace) -> None:
    leg = "Unity"
    project = os.path.join(a.scratch, "UnityE2E")
    if not record(run, leg, "Unity found", os.path.isfile(a.unity), f"{a.unity} (pass --unity)", 0, "file system"):
        raise LegAborted
    error = unity_project_error(project)
    if not record(run, leg, "throwaway project path", error is None, error or project, 0, "file system"):
        raise LegAborted
    if not os.path.isfile(os.path.join(project, "ProjectSettings", "ProjectVersion.txt")):
        log = os.path.join(a.scratch, "unity-create.log")
        code, seconds = _run_unity([a.unity, "-batchmode", "-nographics", "-createProject", project,
                                    "-logFile", log, "-quit"], log, 1800)
        ok = code == 0 and os.path.isfile(os.path.join(project, "ProjectSettings", "ProjectVersion.txt"))
        if ok:
            with open(os.path.join(project, PROJECT_MARKER), "w", encoding="utf-8") as f:
                f.write("Throwaway Unity project created by cc5-mcp-server scripts/e2e/run_e2e.py. Safe to delete.\n")
        lic = _licensing_lines(log)
        if not record(run, leg, "create throwaway project", ok, f"exit {code}; log {log}" +
                      (f"; licensing: {' / '.join(lic)}" if lic and not ok else ""), seconds, "Unity -batchmode"):
            raise LegAborted

    assets = os.path.join(project, "Assets", "E2E")
    sources = {NAME: os.path.join(a.scratch, "cc5", "Unity", "Assets", "Patients", NAME),
               POSED: os.path.join(a.scratch, "cc5", "Unity", "Assets", "Patients", POSED),
               FROM_BLENDER: os.path.join(a.scratch, "blender", FROM_BLENDER)}
    models = []
    for name, src in sources.items():
        fbx = os.path.join(src, name + ".fbx")
        if record(run, leg, f"input {name}.fbx", os.path.isfile(fbx), fbx, 0, "file system"):
            shutil.copytree(src, os.path.join(assets, name))
            models.append(f"Assets/E2E/{name}/{name}.fbx")
    os.makedirs(os.path.join(project, "Assets", "Editor"), exist_ok=True)
    shutil.copy2(os.path.join(HERE, "Editor", "E2EImportCheck.cs"), os.path.join(project, "Assets", "Editor"))
    if not models:
        raise LegAborted

    report_path = os.path.join(a.scratch, "e2e-unity-report.json")
    if os.path.exists(report_path):
        os.remove(report_path)
    log = os.path.join(project, "e2e-unity.log")
    code, seconds = _run_unity([a.unity, "-batchmode", "-nographics", "-projectPath", project,
                                "-executeMethod", "E2EImportCheck.Run", "-logFile", log, "-quit",
                                "-e2eModels", ";".join(models), "-e2eReport", report_path], log, 3600)
    rep = {}
    if os.path.isfile(report_path):
        with open(report_path, encoding="utf-8") as f:
            rep = json.load(f)
    run["unity"] = rep
    run["unity_version"] = rep.get("unityVersion", "")
    ok = code == 0 and rep.get("ok") is True
    lic = [] if ok else _licensing_lines(log)
    if not record(run, leg, "import and check (E2EImportCheck.Run)", ok,
                  f"exit {code}; report {'written' if rep else 'MISSING'}; log {log}" +
                  (f"; licensing: {' / '.join(lic)}" if lic else ""), seconds, "Unity -batchmode"):
        if not rep:
            raise LegAborted
    for m in rep.get("models", []):
        base = os.path.basename(m["path"])
        renderers = m.get("skinnedRenderers", 0) + m.get("meshRenderers", 0)
        record(run, leg, f"{base} imports without errors, renderers > 0",
               m.get("imported") and not m.get("errors") and renderers > 0,
               f"{renderers} renderers, {m.get('triangles', 0):,} triangles, {m.get('materialCount', 0)} materials, "
               f"rig {m.get('animationType')}, {m.get('bones', 0)} bones, clips {m.get('clips') or '-'}, "
               f"{len(m.get('warnings', []))} warnings, {len(m.get('errors', []))} errors"
               + (f": {m['errors'][0]}" if m.get("errors") else ""), m.get("seconds", 0), "analysis")
        ok, detail = unity_skin_texture_check(m)
        record(run, leg, f"{base} skin materials have their main texture", ok, detail, 0, "analysis")


def cross_checks(run: dict) -> None:
    stats = run["cc5"].get("mesh_stats") or {}
    cc5_tris = stats.get("totals", {}).get("triangles", 0)
    models = {os.path.splitext(os.path.basename(m["path"]))[0]: m for m in run["unity"].get("models", [])}
    run["triangles"] = [{"source": "CC5 get_mesh_stats totals.triangles", "triangles": cc5_tris, "vs_cc5": "-"}]
    if run["blender"]:
        b = run["blender"].get("triangles", 0)
        run["triangles"].append({"source": "Blender import of the Blender-preset FBX", "triangles": b,
                                 "vs_cc5": f"{(b - cc5_tris):+,}"})
    for name, m in models.items():
        run["triangles"].append({"source": f"Unity {name}.fbx", "triangles": m.get("triangles", 0),
                                 "vs_cc5": f"{(m.get('triangles', 0) - cc5_tris):+,}"})
    unposed = models.get(NAME)
    if unposed:
        diffs = mesh_triangle_differences(stats.get("meshes", []), unposed.get("renderers", []))
        record(run, "Unity", f"{NAME}.fbx triangles equal get_mesh_stats totals.triangles",
               unposed.get("triangles") == cc5_tris and not diffs,
               f"Unity {unposed.get('triangles', 0):,}, CC5 {cc5_tris:,}" + (f"; differ: {'; '.join(diffs)}" if diffs else ""),
               0, "analysis")
    for name in (POSED, FROM_BLENDER):
        if name in models:
            t = models[name].get("triangles", 0)
            record(run, "Unity", f"{name}.fbx triangles vs CC5 (within {TRIANGLE_TOLERANCE_PCT:g}%)",
                   within_percent(t, cc5_tris, TRIANGLE_TOLERANCE_PCT), f"Unity {t:,}, CC5 {cc5_tris:,}", 0, "analysis")
    if unposed and POSED in models:
        status, detail, dist = pose_check(unposed, models[POSED])
        run["pose"] = dist
        record(run, "Unity", f"{POSED}.fbx comes in posed (a head/hand/foot bone moves > {POSE_MOVE_M} m)",
               status == "PASS", detail, 0, "analysis")
    elif run["unity"]:
        record(run, "Unity", "pose check", False, f"{NAME}.fbx or {POSED}.fbx missing from the Unity report", 0, "analysis")
    start, end = run["cc5"].get("pid_start"), run["cc5"].get("pid_end")
    if start:
        record(run, "CC5", "CC5 process unchanged during the run (no crash or restart)", start == end,
               f"pid at start {start}, at end {end or 'none'}", 0, "tasklist")


def summarize_legs(run: dict) -> None:
    def leg_result(leg: str, about: str = "") -> str:
        steps = [s for s in run["steps"] if s["leg"] == leg and about in s["name"]]
        return "FAIL" if not steps or any(s["status"] == "FAIL" for s in steps) else "PASS"

    def leg_time(leg: str) -> str:
        return f"{sum(s['seconds'] for s in run['steps'] if s['leg'] == leg):.0f} s"

    totals = run["cc5"].get("mesh_stats", {}).get("totals", {})
    files = run["cc5"].get("unity_export_files", [])
    folder = os.path.join(run["params"].get("scratch", ""), "cc5", "Unity", "Assets", "Patients", NAME)
    textures = 0
    if os.path.isdir(folder):
        textures = sum(1 for _, _, fs in os.walk(folder) for f in fs
                       if f.lower().endswith((".png", ".jpg", ".jpeg", ".tga", ".tif", ".tiff", ".bmp")))
    b = run["blender"]
    legs = [{"leg": "CC5", "result": leg_result("CC5"), "triangles": f"{totals.get('triangles', 0):,}",
             "materials": totals.get("materials", "-"), "textures": f"{textures} image files in the {NAME} export",
             "bones": "-", "warnings": "-", "time": leg_time("CC5")},
            {"leg": "Blender", "result": leg_result("Blender"), "triangles": f"{b.get('triangles', 0):,}",
             "materials": len(b.get("materials", [])),
             "textures": f"{b.get('images_resolved', 0)}/{len(b.get('images', []))} resolved",
             "bones": b.get("bones", "-"), "warnings": b.get("error", "-"), "time": leg_time("Blender")}]
    for m in run["unity"].get("models", []):
        base = os.path.basename(m["path"])
        legs.append({"leg": f"Unity {base}", "result": leg_result("Unity", base),
                     "triangles": f"{m.get('triangles', 0):,}", "materials": m.get("materialCount", 0),
                     "textures": f"{m.get('materialsWithMainTexture', 0)}/{m.get('materialCount', 0)} with main texture",
                     "bones": m.get("bones", 0),
                     "warnings": f"{len(m.get('warnings', []))} warnings, {len(m.get('errors', []))} errors",
                     "time": f"{m.get('seconds', 0):.0f} s import"})
    if not run["unity"].get("models"):
        legs.append({"leg": "Unity", "result": leg_result("Unity"), "time": leg_time("Unity")})
    run["legs"] = legs


# ---------------------------------------------------------------- main

def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--scratch", default=DEFAULTS["scratch"], help="Folder for every output (default %(default)s)")
    p.add_argument("--blender", default=DEFAULTS["blender"], help="blender.exe (default %(default)s)")
    p.add_argument("--unity", default=DEFAULTS["unity"], help="Unity.exe 6000.2.10f1 (default %(default)s)")
    p.add_argument("--base", default=DEFAULTS["base"], help="Recipe base: a .ccAvatar/.iAvatar or 'default'")
    p.add_argument("--pose", default=DEFAULTS["pose"], help="Pose file for the posed export")
    p.add_argument("--overlay", default=DEFAULTS["overlay"], help="Skin overlay image")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    global ECHO
    ECHO = True
    sys.stdout.reconfigure(errors="replace")  # tool texts contain characters a cp1252 console cannot print
    a = parse_args(argv)
    a.scratch = os.path.abspath(a.scratch)
    os.makedirs(a.scratch, exist_ok=True)
    run = new_run({k: getattr(a, k) for k in ("scratch", "blender", "unity", "base", "pose", "overlay")})
    started = time.monotonic()
    # Outputs of the previous run, so nothing stale reaches Blender or Unity.
    stale = [os.path.join(a.scratch, "cc5"), os.path.join(a.scratch, "blender")]
    if unity_project_error(os.path.join(a.scratch, "UnityE2E")) is None:
        stale.append(os.path.join(a.scratch, "UnityE2E", "Assets", "E2E"))
    for folder in stale:
        shutil.rmtree(folder, ignore_errors=True)
    if not os.path.isfile(os.path.join(REPO, "build", "index.js")):
        record(run, "CC5", "build/index.js exists", False, "run npm run build first", 0, "file system")
    else:
        for leg, fn in (("CC5", lambda: cc5_leg(run, a, Bridge())), ("Blender", lambda: blender_leg(run, a)),
                        ("Unity", lambda: unity_leg(run, a))):
            try:
                fn()
            except LegAborted:
                record(run, leg, "rest of the leg", False, "not run: an earlier step it depends on failed", 0, "-")
            except Exception as e:  # a bug or an environment error: report it, carry on with the next leg
                record(run, leg, "unexpected error", False, f"{type(e).__name__}: {e}", 0, "-")
        cross_checks(run)
    summarize_legs(run)
    run["finished"] = datetime.datetime.now().isoformat(timespec="seconds")
    run["seconds"] = round(time.monotonic() - started)
    with open(os.path.join(a.scratch, "e2e-results.json"), "w", encoding="utf-8") as f:
        json.dump(run, f, indent=1)
    report = render_report(run)
    with open(os.path.join(a.scratch, "e2e-report.md"), "w", encoding="utf-8") as f:
        f.write(report)
    code = exit_code(run)
    print(f"\n{'PASS' if code == 0 else 'FAIL'}: report {os.path.join(a.scratch, 'e2e-report.md')}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

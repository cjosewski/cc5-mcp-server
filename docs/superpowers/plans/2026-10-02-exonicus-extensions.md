# CC5 MCP — Exonicus Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the CC5 MCP bridge and extend it so a 3D artist can go from a text prompt to a finished, Quest-budget-checked character exported into Unity — with Blender / Substance Painter / ZBrush round-trips and injury skin overlays along the way.

**Architecture:** The TypeScript MCP server (stdio) talks HTTP to a Python plugin inside CC5, which runs every RLPy call on CC5's main thread through a QTimer-drained queue. New Python features go in new focused modules (`cc5_pipeline.py`, `cc5_skin.py`, `cc5_builder.py`) that `server.py` merges into its dispatch tables at startup and on `/reload`. Long operations run as server-side jobs the TS side polls. Multi-step workflows (recipes, batches, budget checks) are orchestrated on the TS side so they are unit-testable with the existing mock bridge.

**Tech Stack:** TypeScript 5.7, Node ≥18, `@modelcontextprotocol/sdk` 1.29, zod 3, vitest 4 · Python 3 (CC5's embedded interpreter), RLPy (CC5 5.1x), stdlib `http.server` · Python unit tests use stdlib `unittest` with a fake `RLPy` module (no new dependencies).

**Spec:** Inline — the "Requirements" section below, agreed with Chad in the 2026-10-02 session (review of `mackatwentytsuru/cc5-mcp-server` v1.1.0).

## Requirements

1. **Security:** dev mode (and with it `exec_python` and unauthenticated `/reload`) off by default; every bridge request except `/health` needs a shared-secret token; POSTs must be `application/json`; `Host` must be localhost.
2. **Reliability:** a timed-out command must never run later; failures carry MCP `isError: true`; slow operations don't block status polls; long operations run as jobs.
3. **Trauma Sim:** export straight into a Unity project folder; per-character mesh/texture budget report for Quest 3; apply a pose before export; batch-generate patient variations with a manifest.
4. **DCC round-trip:** Blender FBX preset (+ JSON material sidecar for Reallusion's Blender add-on), OBJ export, ZBrush GoZ export, FBX/OBJ import back (props, clothing, mesh replacement), per-channel texture load, Substance Painter texture import.
5. **Skin / injury:** image overlays (bruising, dirt, blood) on skin materials with strength, pallor, wrinkle strength, SkinGen/makeup content browsing.
6. **Prompt → full character:** Headshot from photo, facial-profile load, keyword content search across categories, save character, a declarative "character recipe" that applies everything in one call, and an MCP prompt that walks the model through building a character.
7. **Distribution:** fork at `github.com/cjosewski/cc5-mcp-server`, branch `exonicus-extensions`; installer copies every plugin `.py`; intern runbook updated.

## Global Constraints

- All RLPy calls run on CC5's main thread via the existing queue — never call RLPy from an HTTP thread.
- Every mutating RLPy sequence is wrapped `RLPy.RGlobal.BeginAction("<name>")` … `finally: RLPy.RGlobal.EndAction()` and followed by `RLPy.RGlobal.ObjectModified(...)` where the object changed.
- Validate every argument before it reaches RLPy (SWIG can segfault CC5 on bad input): paths reject `..` and NUL (`cc5_api._validate_path` semantics), names match `^[A-Za-z0-9_-]{1,64}$` (in Python, anchor the end with `\Z`, not `$`: Python's `$` also matches before a trailing newline), numbers are range-clamped.
- Python files start with `from __future__ import annotations`; plugin uses PySide2 only.
- New TS tool modules follow `src/tools/color.ts`: zod schema, `bridgeCall(...)`, one `registerXTools(server, bridge)` export, registered in `src/index.ts`.
- No new runtime dependencies (Node or Python).
- Quest 3 per-character budget defaults (overridable per call and via env `CC5_BUDGET_*`): **65,000 faces, 2048 px max texture edge, 66 MiB estimated texture GPU memory, 20 materials**. The face budget counts triangles (what Unity and the Quest profiler count), not polygons. `check_quest_budget` (Task 7) compares it against summed `RIMesh.GetFacesCount()`, and the reference does not say whether that counts triangles or polygons, so it is a LIVE-VERIFY item: Task 18 Step 4 checks it against Unity's triangle count.
- Budget source (measured 2026-10-02; the defaults match it at Chad's direction): the heaviest shipping Trauma Sim main patient, `Patient_FemaleWhite` (JaneWhite18), one of the three variants `PatientTriage` spawns from `ScenarioConfigGlobal.listOfPatients` (Patient_MaleWhite, Patient_FemaleWhite, Patient_FemaleBlack; each limit is the maximum across the three). Its meshes visible at spawn total 64,783 Unity triangles (rounded up to 65,000) in 20 material slots; its largest effective Quest texture edge is 2048 px (after Unity's Android import clamp); its default-visible textures need an estimated 65.1 MiB of GPU memory on Quest, rounded up to 66 MiB. The texture budget is GPU memory, not file size (controller ruling, 2026-10-02): the same textures total 494.1 MiB on disk, 407.6 MiB of it uncompressed TIF sources that Quest never loads, so a file-size limit could never fail. `estimateTextureGpuMb` (Task 7) estimates exported textures exactly as the measurement did: each texture scaled so its longer edge is at most the px limit (Unity's Android import clamp), 3.56 bits per pixel (ASTC 6x6, Unity's default Android compression), plus one third for the mip chain, in MiB (1,048,576 bytes). Export with `texture_size` 2048.
- RLPy signatures documented only as `*args` in `docs/rlpy-api-reference.md` are marked **LIVE-VERIFY**: the implementation tries the documented forms in order and reports which one worked; Task 18 confirms each against a running CC5.
- Upstream has no LICENSE file (README claims MIT). Keep the fork private-use until that is clarified with the author; don't redistribute outside Exonicus. So the fork is a **private** repo made with `gh repo create --private`, not a GitHub fork: upstream is public, and GitHub keeps a fork of a public repo public. Share it only by adding Exonicus people as collaborators.

## Review Focus

1. **Token file missing on first run** (MCP server started before CC5 ever ran the plugin) → tools must say "start CC5 first", and pick the token up later without restarting Claude Code. Test in Task 2.
2. **A command times out while CC5 is still busy, then the model retries** → the retry must not double-apply; the timeout message must say whether the command was cancelled or is still running. Test in Task 3.
3. **Unity folder outside a Unity `Assets` tree, or a character name with spaces/unicode** → refused with a clear message before anything is written. Test in Task 6.
4. **Recipe step fails halfway** (e.g. a hair asset path is wrong) → remaining steps still run, the report lists each step's outcome, and the overall result is `isError`. Test in Task 15.
5. **Batch run where CC5 crashes or a variant export fails** → the manifest is written after every variant so finished ones are not lost, and the failure is recorded per variant. Test in Task 16.

---

## File Structure

| File | Responsibility |
|---|---|
| `cc5-plugin/server.py` (modify) | auth (token, Host, Content-Type), timeout cancellation, threading server, job store, extension loading |
| `cc5-plugin/cc5_api.py` (modify) | `exec_python` dev-mode default; Blender preset + JSON flag in `export_fbx`; extra `browse_content` folders and a wider file filter (`.rl*` for pose/motion, images for the image-library folders) |
| `start_bridge.py` (modify) | dev starter also drops the extension modules from the module cache |
| `cc5-plugin/cc5_pipeline.py` (new) | Unity export, mesh stats, pose, save character, OBJ/GoZ export, FBX/OBJ import, texture load, Substance import |
| `cc5-plugin/cc5_skin.py` (new) | skin overlays, overlay strength, pallor, wrinkle strength |
| `cc5-plugin/cc5_builder.py` (new) | Headshot from photo, facial profile load, keyword content search |
| `tests/py/_support.py`, `tests/py/test_*.py` (new) | fake RLPy + unittest suites for the Python side |
| `src/auth.ts` (new) | read the bridge token |
| `src/jobs.ts` (new) | `runJob` start-and-poll helper |
| `src/image-info.ts` (new) | read PNG/JPEG/TGA dimensions from file headers |
| `src/recipe.ts` (new) | declarative character-recipe engine |
| `src/util.ts` (modify) | `isError` on failures; `errorResult()` |
| `src/tools/scene.ts`, `asset.ts`, `metahuman.ts` (modify) | hand-built failure results return `errorResult()` |
| `src/cc5-bridge.ts`, `src/types.ts` (modify) | token header, new bridge methods and result types |
| `src/tools/jobs.ts`, `unity.ts`, `pipeline.ts`, `skin.ts`, `builder.ts`, `batch.ts` (new) | MCP tools |
| `src/prompts/create-character.ts` (new) | MCP prompt for prompt-to-character |
| `install-plugin.ps1` (modify) | correct source path; copy all plugin `.py` files |
| `scripts/live_smoke_test.py` (modify) | live checks for every new route |

Python tests run with: `py -3 -m unittest discover -s tests/py -p "test_*.py" -v` (added as `npm run test:py`).

---

## Phase 0 — Fork

### Task 0: Fork, branch, baseline

**Files:** none changed.

- [ ] **Step 1: Check the local clone** (local only — nothing on GitHub changes here. Per the Task 0 ruling in the SDD ledger, the private GitHub repo is created in Task 19 Step 2, after Chad confirms; see Global Constraints)

```bash
cd D:/_Repos/cc5-mcp-server
# The clone's only remote is already named 'upstream' (no rename needed); 'origin' is added in Task 19 Step 2.
git remote get-url upstream      # must print the mackatwentytsuru/cc5-mcp-server URL
git switch exonicus-extensions   # branch already exists locally, created from upstream/main
```

- [ ] **Step 2: Baseline**

Run: `npm test`
Expected: `Test Files 14 passed (14)`, `Tests 462 passed (462)`.

---
## Phase 1 — Security & reliability

### Task 1: Python test harness

**Files:**
- Create: `tests/py/_support.py`, `tests/py/test_harness.py`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `_support.install_fake_rlpy() -> MagicMock` (installs `sys.modules["RLPy"]`, puts `cc5-plugin/` on `sys.path`, returns the fake); `_support.fresh_import(name: str) -> module` (drops cached plugin modules and re-imports). Every later Python test starts with `import _support`.

- [ ] **Step 1: Write the harness**

`tests/py/_support.py`:
```python
"""Test support: a fake RLPy module so plugin code imports outside CC5."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
from unittest import mock

# Keep server.py's token file out of the developer's real %LOCALAPPDATA%.
os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="cc5-pytest-")

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "cc5-plugin"))
PLUGIN_MODULES = ("server", "cc5_api", "cc5_pipeline", "cc5_skin", "cc5_builder")


def install_fake_rlpy() -> mock.MagicMock:
    fake = mock.MagicMock(name="RLPy")
    sys.modules["RLPy"] = fake
    if PLUGIN_DIR not in sys.path:
        sys.path.insert(0, PLUGIN_DIR)
    return fake


def fresh_import(name: str):
    for mod in PLUGIN_MODULES:
        sys.modules.pop(mod, None)
    return importlib.import_module(name)


install_fake_rlpy()
```

`tests/py/test_harness.py`:
```python
import unittest

import _support


class HarnessTest(unittest.TestCase):
    def test_cc5_api_imports_with_fake_rlpy(self):
        api = _support.fresh_import("cc5_api")
        self.assertTrue(hasattr(api, "export_fbx"))

    def test_server_imports(self):
        srv = _support.fresh_import("server")
        self.assertIn("export_fbx", srv.ACTION_MAP)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Add the npm script** — in `package.json` `"scripts"` add:
```json
"test:py": "py -3 -m unittest discover -s tests/py -p \"test_*.py\" -v"
```

- [ ] **Step 3: Run**

Run: `npm run test:py`
Expected: `Ran 2 tests` … `OK`. If `cc5_api` import fails on a module-level RLPy expression, give the fake that attribute an explicit value inside `install_fake_rlpy()` (MagicMock covers attribute access and calls; only `isinstance`/arithmetic on RLPy values needs a real value).

- [ ] **Step 4: Commit**
```bash
git add tests/py package.json
git commit -m "test: add Python unittest harness with fake RLPy"
```

---

### Task 2: Bridge authentication and safe defaults

**Files:**
- Modify: `cc5-plugin/server.py` (constants, `BridgeHandler`, new `_load_or_create_token`)
- Modify: `cc5-plugin/cc5_api.py:2402` (`exec_python` dev-mode default)
- Create: `src/auth.ts`, `tests/auth.test.ts`, `tests/setup-env.ts`, `tests/py/test_auth.py`
- Modify: `src/cc5-bridge.ts` (`request`), `vitest.config.ts`, `tests/cc5-bridge.test.ts`

**Interfaces:**
- Produces (Python): `server.TOKEN: str`, `server._load_or_create_token() -> str`; token file `%LOCALAPPDATA%\CC5_MCP_Bridge\token` (fallback `tempfile.gettempdir()`); header `X-CC5-Token`.
- Produces (TS): `getBridgeToken(): string | null`, `tokenPath(): string`, `resetTokenCache(): void` in `src/auth.ts`.

- [ ] **Step 1: Write the failing Python test** — `tests/py/test_auth.py`:
```python
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import _support


def _drain(srv, stop):
    while not stop.is_set():
        srv.process_command_queue()
        stop.wait(0.01)


class BridgeTestCase(unittest.TestCase):
    """Starts a real bridge on a free port with a thread standing in for CC5's main thread."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["LOCALAPPDATA"] = self.tmp
        os.environ.pop("CC5_BRIDGE_TOKEN", None)
        os.environ.pop("CC5_DEV_MODE", None)
        os.environ.pop("CC5_ALLOW_EXEC", None)
        self.srv = _support.fresh_import("server")
        self.srv.ACTION_MAP["ping"] = lambda p: {"success": True, "pong": True}
        self.srv.POST_ROUTES["/ping"] = "ping"
        self.srv.start_server(port=0)
        self.port = self.srv._httpd.server_address[1]
        self.stop = threading.Event()
        self.drain = threading.Thread(target=_drain, args=(self.srv, self.stop), daemon=True)
        self.drain.start()

    def tearDown(self):
        self.stop.set()
        self.srv.stop_server()

    def post(self, path, body, headers=None, token=True):
        h = {"Content-Type": "application/json"}
        if token:
            h["X-CC5-Token"] = self.srv.TOKEN
        h.update(headers or {})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(),
            method="POST", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode() or "{}")

    def get(self, path, token=True):
        h = {"X-CC5-Token": self.srv.TOKEN} if token else {}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode() or "{}")


class AuthTest(BridgeTestCase):
    def test_token_file_created(self):
        path = os.path.join(self.tmp, "CC5_MCP_Bridge", "token")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), self.srv.TOKEN)

    def test_missing_token_rejected(self):
        self.assertEqual(self.post("/ping", {}, token=False)[0], 401)

    def test_valid_token_accepted(self):
        self.assertEqual(self.post("/ping", {})[0], 200)

    def test_non_json_content_type_rejected(self):
        self.assertEqual(self.post("/ping", {}, {"Content-Type": "text/plain"})[0], 415)

    def test_foreign_host_rejected(self):
        self.assertEqual(self.post("/ping", {}, {"Host": "evil.example:80"})[0], 403)

    def test_dev_mode_off_by_default(self):
        self.assertFalse(self.srv.DEV_MODE)
        self.assertEqual(self.post("/exec/python", {"code": "result=1"})[0], 403)

    def test_health_needs_no_token(self):
        self.assertEqual(self.get("/health", token=False)[0], 200)

    def test_get_routes_need_token(self):
        self.assertEqual(self.get("/api", token=False)[0], 401)
        self.assertEqual(self.get("/avatars", token=False)[0], 401)
        self.assertEqual(self.get("/api")[0], 200)

    def test_reload_off_without_dev_mode(self):
        self.assertEqual(self.get("/reload")[0], 403)
        self.assertEqual(self.get("/reload", token=False)[0], 401)

    def test_exec_python_api_refuses_by_default(self):
        os.environ.pop("CC5_ALLOW_EXEC", None)
        api = _support.fresh_import("cc5_api")
        self.assertFalse(api.exec_python("result = 1")["success"])
```
(Later Python bridge tests import `BridgeTestCase` from `test_auth`.)

- [ ] **Step 2: Run — expect failures**

Run: `npm run test:py`
Expected: FAIL — `AttributeError: module 'server' has no attribute 'TOKEN'`.

- [ ] **Step 3: Implement in `server.py`**

Add `import secrets` and `import tempfile`. Replace the `RELOAD_SECRET` / `DEV_MODE` lines with:
```python
DEV_MODE = os.environ.get("CC5_DEV_MODE", "0").strip().lower() in ("1", "true", "yes")
TOKEN_HEADER = "X-CC5-Token"


def _token_path() -> str:
    base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    return os.path.join(base, "CC5_MCP_Bridge", "token")


def _load_or_create_token() -> str:
    env = os.environ.get("CC5_BRIDGE_TOKEN", "").strip()
    if env:
        return env
    path = _token_path()
    try:
        with open(path, encoding="utf-8") as f:
            existing = f.read().strip()
        if existing:
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(token)
    return token


TOKEN = _load_or_create_token()
```

Add to `BridgeHandler`:
```python
    def _allowed_host(self) -> bool:
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").strip().lower()
        return host in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _check_request(self, require_json: bool) -> bool:
        """Guard every request. Fails closed: anything unexpected is rejected."""
        if not self._allowed_host():
            self._send_json(403, {"error": "Forbidden host"})
            return False
        # Compare bytes: compare_digest raises TypeError on non-ASCII str, and http.server
        # decodes headers as latin-1, so a stray high byte must yield 401, not a dropped socket.
        supplied = (self.headers.get(TOKEN_HEADER) or "").encode("utf-8", "surrogatepass")
        if not hmac.compare_digest(supplied, TOKEN.encode("utf-8", "surrogatepass")):
            self._send_json(401, {"error": "Missing or invalid bridge token"})
            return False
        if require_json:
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self._send_json(415, {"error": "Content-Type must be application/json"})
                return False
        return True
```
In `do_GET`: keep the `/health` branch first (unauthenticated; reveals only status and version), then add
```python
        if not self._check_request(require_json=False):
            return
```
In `do_POST`, put this immediately after the existing `params = self._read_json()` try/except and before any routing:
```python
        if not self._check_request(require_json=True):
            return
```
Do not move the check above `_read_json`. `_read_json` is capped by MAX_REQUEST_BYTES, so reading the body first is safe. If the server rejects a request while body bytes are still unread, Windows resets the socket (TCP RST) when it closes the connection. For bodies of a few hundred KB, Node's fetch then reports ECONNRESET or UND_ERR_SOCKET instead of the 401, and the user sees the generic "Is CC5 running" message instead of the token explanation. With this order, malformed JSON gets a 400 before auth is checked. That is acceptable.
Replace the `/reload` branch (the token now covers authentication; reload also needs dev mode):
```python
        if path == "/reload":
            if not DEV_MODE:
                self._send_json(403, {"error": "/reload disabled. Set CC5_DEV_MODE=1."})
                return
            result = reload_modules()
            self._send_json(200 if result.get("success") else 500, {"result": result})
            return
```
Delete the `RELOAD_SECRET` warning in `start_server`.

In `cc5_api.exec_python` (~line 2402):
```python
    dev_mode = os.environ.get("CC5_DEV_MODE", "0").strip().lower() in ("1", "true", "yes")
```

- [ ] **Step 4: Run Python tests**

Run: `npm run test:py` — Expected: all pass.

- [ ] **Step 5: Write the failing TS tests**

`tests/setup-env.ts`:
```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate tests from a real CC5 token on the developer's machine.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-test-"));
delete process.env.CC5_BRIDGE_TOKEN;
```
`vitest.config.ts`: add `setupFiles: ["tests/setup-env.ts"],` inside `test: {`.

`tests/auth.test.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { getBridgeToken, tokenPath, resetTokenCache } from "../src/auth.js";

beforeEach(() => {
  resetTokenCache();
  delete process.env.CC5_BRIDGE_TOKEN;
  fs.rmSync(path.dirname(tokenPath()), { recursive: true, force: true });
});

describe("getBridgeToken", () => {
  it("returns null when no env and no file", () => {
    expect(getBridgeToken()).toBeNull();
  });

  it("prefers CC5_BRIDGE_TOKEN", () => {
    process.env.CC5_BRIDGE_TOKEN = "from-env";
    expect(getBridgeToken()).toBe("from-env");
  });

  it("picks up a token file written after startup", () => {
    expect(getBridgeToken()).toBeNull();
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
    fs.writeFileSync(tokenPath(), "from-file\n");
    expect(getBridgeToken()).toBe("from-file");
  });
});
```
Append to `tests/cc5-bridge.test.ts`:
```ts
describe("CC5Bridge token header", () => {
  it("sends X-CC5-Token when a token is available", async () => {
    process.env.CC5_BRIDGE_TOKEN = "t0k";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new CC5Bridge("http://localhost:5101").getAvatars();
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-CC5-Token"]).toBe("t0k");
    delete process.env.CC5_BRIDGE_TOKEN;
    vi.unstubAllGlobals();
  });

  it("explains a 401 in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    await expect(new CC5Bridge("http://localhost:5101").getAvatars()).rejects.toThrow(/token/i);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 6: Run — expect failure**

Run: `npx vitest run tests/auth.test.ts tests/cc5-bridge.test.ts`
Expected: FAIL — `Cannot find module '../src/auth.js'`.

- [ ] **Step 7: Implement** — `src/auth.ts`:
```ts
/**
 * Bridge token lookup. The CC5 plugin writes a random token to
 * %LOCALAPPDATA%\CC5_MCP_Bridge\token on first start; we send it on every request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: string | null = null;

export function tokenPath(): string {
  const base = process.env.LOCALAPPDATA ?? os.tmpdir();
  return path.join(base, "CC5_MCP_Bridge", "token");
}

export function getBridgeToken(): string | null {
  const fromEnv = process.env.CC5_BRIDGE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;
  try {
    const fromFile = fs.readFileSync(tokenPath(), "utf8").trim();
    if (fromFile) cached = fromFile;
  } catch {
    // CC5 has not started the plugin yet; try again on the next request.
  }
  return cached;
}

export function resetTokenCache(): void {
  cached = null;
}
```
In `src/cc5-bridge.ts` import `{ getBridgeToken, resetTokenCache } from "./auth.js"` and in `request` replace the `options` literal with:
```ts
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = getBridgeToken();
      if (token) headers["X-CC5-Token"] = token;
      const options: RequestInit = { method, headers, signal: controller.signal };
```
and insert before the `if (!response.ok)` block:
```ts
      if (response.status === 401) {
        resetTokenCache();
        throw new Error(
          "CC5 rejected the bridge token. Start Character Creator 5 at least once so it writes its token, then try again");
      }
```

- [ ] **Step 8: Run everything**

Run: `npm test && npm run test:py`
Expected: all pass. (The exact-headers assertion at `tests/cc5-bridge.test.ts:700` still holds because the test env has no token.)

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin/server.py cc5-plugin/cc5_api.py src/auth.ts src/cc5-bridge.ts tests vitest.config.ts
git commit -m "feat(security): token auth, Host and Content-Type checks, dev mode off by default"
```

---

### Task 3: Timeouts that never run late, threaded server, extension loading

**Files:**
- Modify: `cc5-plugin/server.py` (`process_command_queue`, `_execute_sync`, `ReusableHTTPServer`, `reload_modules`, new `load_extensions`)
- Create: `tests/py/test_queue.py`
- Modify: `start_bridge.py` (module-cache drop list)
- Modify: `src/cc5-bridge.ts` (`REQUEST_TIMEOUT_MS` default, `request` fetch call), `tests/cc5-bridge.test.ts`

**Interfaces:**
- Produces: `server.EXTENSION_MODULES: list[str]` (starts empty; later tasks append `"cc5_pipeline"`, `"cc5_skin"`, `"cc5_builder"`); `server.load_extensions(reload: bool = False) -> list[str]`. An extension module exposes module-level `ACTIONS: dict[str, Callable[[dict], Any]]`, `POST_ROUTES: dict[str, str]`, `REQUIRED_PARAMS: dict[str, list[str]]`.
- Produces: 504 bodies `{"error": ..., "state": "cancelled" | "running"}`.
- Produces (TS): `CC5_REQUEST_TIMEOUT_MS` default `35000`, which must stay above the bridge's 30 s `_execute_sync` timeout so the 504 body reaches the model. A client-side abort now throws `No reply from CC5 within Ns. CC5 may still be running this command; ...` instead of `This operation was aborted`.

- [ ] **Step 1: Failing test** — `tests/py/test_queue.py`:
```python
import threading
import unittest

import _support
from test_auth import BridgeTestCase


class QueueTest(BridgeTestCase):
    def test_timed_out_queued_command_never_runs(self):
        ran = []
        self.srv.ACTION_MAP["mark"] = lambda p: ran.append(1) or {"success": True}
        self.stop.set()
        self.drain.join(2)  # "main thread" busy: nothing drains the queue
        status, body = self.srv._execute_sync("mark", {}, timeout=0.2)
        self.assertEqual(status, 504)
        self.assertEqual(body["state"], "cancelled")
        self.srv.process_command_queue()  # CC5 becomes free
        self.assertEqual(ran, [])

    def test_retry_after_cancel_applies_once(self):
        ran = []
        self.srv.ACTION_MAP["mark"] = lambda p: ran.append(1) or {"success": True}
        self.stop.set()
        self.drain.join(2)  # main thread busy: nothing drains the queue
        status, body = self.srv._execute_sync("mark", {}, timeout=0.2)
        self.assertEqual((status, body["state"]), (504, "cancelled"))
        threading.Timer(0.05, self.srv.process_command_queue).start()  # CC5 frees up during the retry
        status, _ = self.srv._execute_sync("mark", {}, timeout=2)
        self.assertEqual(status, 200)
        self.assertEqual(ran, [1])  # the cancelled original was dropped; only the retry ran

    def test_timeout_while_running_says_running(self):
        gate = threading.Event()
        self.srv.ACTION_MAP["slow"] = lambda p: gate.wait(2) or {"success": True}
        status, body = self.srv._execute_sync("slow", {}, timeout=0.2)
        gate.set()
        self.assertEqual(status, 504)
        self.assertEqual(body["state"], "running")

    def test_result_published_at_deadline_is_returned(self):
        # Review Focus #2: a command that finishes right as the wait expires ran,
        # so it must not be reported as "cancelled" (that invites a double-apply retry).
        ran = []
        self.srv.ACTION_MAP["mark"] = lambda p: ran.append(1) or {"success": True}

        class LateEvent(threading.Event):
            def wait(self, timeout=None):
                super().wait(timeout)  # CC5 finishes and publishes the result...
                return False           # ...just as the deadline passes

        from unittest import mock
        with mock.patch.object(self.srv.threading, "Event", LateEvent):
            status, body = self.srv._execute_sync("mark", {}, timeout=2)
        self.assertEqual(ran, [1])
        self.assertEqual(status, 200)
        self.assertEqual(body["result"], {"success": True})
        self.assertEqual(self.srv._cancelled, set())

    def test_health_answers_while_command_runs(self):
        gate, started = threading.Event(), threading.Event()

        def slow_action(p):
            started.set()
            gate.wait(3)
            return {"success": True}

        self.srv.ACTION_MAP["slow"] = slow_action
        self.srv.POST_ROUTES["/slow"] = "slow"
        slow = threading.Thread(target=self.post, args=("/slow", {}), daemon=True)
        slow.start()
        try:
            # Wait until the /slow request is being handled, so /health has to
            # be answered while a command is in progress.
            self.assertTrue(started.wait(2), "slow command never started")
            import urllib.request
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=1) as r:
                self.assertEqual(r.status, 200)
        finally:
            gate.set()
            slow.join(5)


class ExtensionTest(unittest.TestCase):
    def test_extension_tables_merged(self):
        import sys, types
        ext = types.ModuleType("cc5_fake_ext")
        ext.ACTIONS = {"fake_action": lambda p: {"success": True}}
        ext.POST_ROUTES = {"/fake": "fake_action"}
        ext.REQUIRED_PARAMS = {"fake_action": ["x"]}
        sys.modules["cc5_fake_ext"] = ext
        srv = _support.fresh_import("server")
        srv.EXTENSION_MODULES[:] = ["cc5_fake_ext"]
        self.assertEqual(srv.load_extensions(), ["cc5_fake_ext"])
        self.assertIn("fake_action", srv.ACTION_MAP)
        self.assertEqual(srv.POST_ROUTES["/fake"], "fake_action")
        self.assertEqual(srv.REQUIRED_PARAMS["fake_action"], ["x"])
```

- [ ] **Step 2: Run — expect failure**

Run: `npm run test:py` — Expected: FAIL (`KeyError: 'state'`, health times out, no `load_extensions`).

- [ ] **Step 3: Implement**

Below `_processing = False` add:
```python
_cancelled: set[str] = set()
_running_id: str | None = None
```
In `process_command_queue`, after reading `cmd_id/action/params`, before the handler:
```python
            with _store_lock:
                if cmd_id in _cancelled:
                    _cancelled.discard(cmd_id)
                    command_queue.task_done()
                    continue
                global _running_id
                _running_id = cmd_id
```
and clear it inside the existing post-handler publish block, in the same lock acquisition that stores the result. Do not use a separate, later `with _store_lock:`: a timing-out `_execute_sync` could then see `_running_id is None` with no result stored yet and wrongly report "cancelled" for a command that ran.
```python
            with _store_lock:
                _running_id = None
                event = response_events.pop(cmd_id, None)
                if event:
                    response_store[cmd_id] = result
                    event.set()
```
(declare `global _processing, _running_id` at the top of the function instead of inline.)

Replace the timeout branch in `_execute_sync`:
```python
    if not event.wait(timeout=timeout):
        with _store_lock:
            # A result stored right at the deadline means the command ran: fall through
            # to the normal result handling below instead of discarding it.
            if cmd_id not in response_store:
                response_events.pop(cmd_id, None)
                if _running_id == cmd_id:
                    return 504, {"state": "running", "error": (
                        "CC5 is still working on this command. Check the scene before retrying; "
                        "the command may still complete.")}
                _cancelled.add(cmd_id)
                return 504, {"state": "cancelled", "error": "Timed out before CC5 started the command; it was cancelled and will not run."}
```
Keep the existing `with _store_lock: result = response_store.pop(...)` block and the 400/200 handling after it unchanged; a deadline-time result reaches them through the fall-through.

Threaded server (`ThreadingHTTPServer` is stdlib; RLPy still only runs on the main thread via the queue):
```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ReusableHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
```

In `stop_server`, close the listening socket after stopping the loop. `shutdown()` only ends `serve_forever` and leaves the socket open until GC, which prints a ResourceWarning on every bridge test and leaves port 5101 listening after `uninitialize_plugin`:
```python
def stop_server() -> None:
    """Shut down the HTTP server gracefully."""
    global _httpd
    if _httpd is not None:
        _httpd.shutdown()
        _httpd.server_close()
        _httpd = None
```

Extension loading, after the route tables:
```python
EXTENSION_MODULES: list[str] = []


def load_extensions(reload: bool = False) -> list[str]:
    """Import (or reload) feature modules and merge their dispatch tables."""
    loaded: list[str] = []
    for name in EXTENSION_MODULES:
        mod = sys.modules.get(name)
        mod = importlib.reload(mod) if (reload and mod is not None) else importlib.import_module(name)
        ACTION_MAP.update(mod.ACTIONS)
        POST_ROUTES.update(mod.POST_ROUTES)
        REQUIRED_PARAMS.update(mod.REQUIRED_PARAMS)
        loaded.append(name)
    return loaded
```
Call `load_extensions()` at the end of `start_server` (before starting the thread). In `reload_modules`, after reloading `cc5_api`:
```python
        loaded = load_extensions(reload=True)
        return {"success": True, "message": f"cc5_api and {len(loaded)} extension(s) reloaded"}
```

In `start_bridge.py` (the manual dev starter, re-run inside CC5's long-lived interpreter), extend the module-cache drop list. Otherwise `load_extensions()` (which uses `import_module`) returns stale extension modules that are still bound to the old `cc5_api`. Names that are not imported yet are skipped by the existing `if m in sys.modules` guard:
```python
for m in ["server", "cc5_api", "cc5_pipeline", "cc5_skin", "cc5_builder"]:
```

- [ ] **Step 4: Run** — `npm run test:py` — Expected: all pass.

- [ ] **Step 4b: Make the MCP client outlast the bridge timeout**

Both sides currently time out at 30 s. The TS timer starts before `fetch`, but the bridge's `event.wait` only starts once the request has been read. So the client always aborts first, and the model sees `This operation was aborted` instead of the 504 `cancelled`/`running` message. In `src/cc5-bridge.ts` replace the timeout constants with:
```ts
// Must stay above the bridge's 30 s command timeout (cc5-plugin/server.py `_execute_sync`)
// so its 504 "cancelled" / "running" answer arrives before this client gives up.
const _rawTimeout = parseInt(process.env.CC5_REQUEST_TIMEOUT_MS ?? "35000", 10);
const REQUEST_TIMEOUT_MS = Number.isFinite(_rawTimeout) && _rawTimeout > 0 && _rawTimeout <= 300_000
  ? _rawTimeout
  : 35_000;
```
and in `request` replace `const response = await fetch(`${this.baseUrl}${path}`, options);` with:
```ts
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, options);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") {
          throw new Error(
            `No reply from CC5 within ${REQUEST_TIMEOUT_MS / 1000}s. CC5 may still be running this command; ` +
            "check the scene (list_avatars / capture_viewport) before retrying.");
        }
        throw err;
      }
```
Append inside `describe("CC5Bridge internal request handling", ...)` in `tests/cc5-bridge.test.ts`:
```ts
  it("explains a client-side timeout instead of 'This operation was aborted'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("This operation was aborted", "AbortError")));
    await expect(bridge.getAvatars()).rejects.toThrow(/CC5 may still be running this command/);
  });

  it("passes the bridge's 504 cancelled message through to the caller", async () => {
    mockFetchHttpError(504, JSON.stringify({
      state: "cancelled",
      error: "Timed out before CC5 started the command; it was cancelled and will not run.",
    }));
    await expect(bridge.getAvatars()).rejects.toThrow(/cancelled and will not run/);
  });
```
Run: `npm test && npm run test:py` — Expected: all pass.

- [ ] **Step 5: Commit**
```bash
git add cc5-plugin/server.py tests/py/test_queue.py start_bridge.py src/cc5-bridge.ts tests/cc5-bridge.test.ts
git commit -m "fix(bridge): cancel timed-out commands, threaded HTTP server, extension module loading"
```

---

### Task 4: Failures carry `isError`

**Files:**
- Modify: `src/util.ts`, `tests/util.test.ts`, `src/tools/scene.ts`, `src/tools/asset.ts`, `src/tools/metahuman.ts`, `tests/tools/scene.test.ts`, `tests/tools/asset.test.ts`
- Create: `tests/tools/metahuman.test.ts`

**Interfaces:**
- Produces: `bridgeCall` returns `{ content, isError?: true }` — `isError` when the call throws or the result object has `success === false`; `errorResult(text: string)` → `{ content: [{type:"text", text}], isError: true }` for validation failures in new tools and for the hand-built failure results in `scene.ts` (`check_cc5_connection`, `capture_viewport`), `asset.ts` (`load_asset`, `export_fbx`) and `metahuman.ts` (`export_head_metahuman`). See Step 3b.

- [ ] **Step 1: Failing tests** — append to `tests/util.test.ts`:
```ts
import { errorResult } from "../src/util.js";

describe("bridgeCall isError", () => {
  it("flags thrown errors", async () => {
    const r = await bridgeCall(() => Promise.reject(new Error("x")), () => "no");
    expect(r.isError).toBe(true);
  });

  it("flags success:false results", async () => {
    const r = await bridgeCall(() => Promise.resolve({ success: false, error: "bad" }), (v) => `Failed: ${v.error}`);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Failed: bad");
  });

  it("does not flag successes", async () => {
    const r = await bridgeCall(() => Promise.resolve({ success: true }), () => "ok");
    expect(r.isError).toBeUndefined();
  });
});

describe("errorResult", () => {
  it("wraps text as an error", () => {
    expect(errorResult("nope")).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });
});
```
Append to `tests/tools/scene.test.ts`:
```ts
describe("scene failures carry isError", () => {
  it("check_cc5_connection: not responding", async () => {
    bridge.healthCheck.mockResolvedValue(false);
    expect((await server.getRegisteredTool("check_cc5_connection")({})).isError).toBe(true);
  });

  it("check_cc5_connection: healthCheck throws", async () => {
    bridge.healthCheck.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await server.getRegisteredTool("check_cc5_connection")({})).isError).toBe(true);
  });

  it("check_cc5_connection: connected is not an error", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    expect((await server.getRegisteredTool("check_cc5_connection")({})).isError).toBeUndefined();
  });

  it("capture_viewport: bad path, success:false, throw", async () => {
    const handler = server.getRegisteredTool("capture_viewport");
    expect((await handler({ output_path: "C:/out/frame.jpg" })).isError).toBe(true);
    bridge.captureViewport.mockResolvedValue({ success: false, error: "no render context" });
    expect((await handler({})).isError).toBe(true);
    bridge.captureViewport.mockRejectedValue(new Error("render failed"));
    expect((await handler({})).isError).toBe(true);
  });

  it("capture_viewport: success is not an error", async () => {
    bridge.captureViewport.mockResolvedValue(CAPTURE_SUCCESS);
    expect((await server.getRegisteredTool("capture_viewport")({ output_path: "C:/temp/capture.png" })).isError).toBeUndefined();
  });
});
```
Append to `tests/tools/asset.test.ts`:
```ts
describe("asset validation failures carry isError", () => {
  it("load_asset rejects a bad path with isError", async () => {
    const r = await server.getRegisteredTool("load_asset")({ file_path: "C:/a/../b.iAvatar" });
    expect(r.isError).toBe(true);
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("export_fbx rejects a bad path with isError", async () => {
    const r = await server.getRegisteredTool("export_fbx")({ output_path: "C:/out/char.obj" });
    expect(r.isError).toBe(true);
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});
```
Create `tests/tools/metahuman.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerMetaHumanTools } from "../../src/tools/metahuman.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMetaHumanTools(server as any, bridge as any);
});

describe("export_head_metahuman validation failures carry isError", () => {
  it("rejects a relative output_dir", async () => {
    const r = await server.getRegisteredTool("export_head_metahuman")({ output_dir: "rel/dir", character_name: "P1", gender: "Female" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("absolute");
  });

  it("rejects a bad character_name", async () => {
    const r = await server.getRegisteredTool("export_head_metahuman")({ output_dir: "D:/out", character_name: "a/b", gender: "Female" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid characters");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/util.test.ts tests/tools/scene.test.ts tests/tools/asset.test.ts tests/tools/metahuman.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — replace `src/util.ts` body:
```ts
export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function isFailure(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { success?: unknown }).success === false;
}

export async function bridgeCall<T>(
  fn: () => Promise<T>,
  formatSuccess: (result: T) => string,
): Promise<ToolResult> {
  try {
    const result = await fn();
    const text = formatSuccess(result);
    return isFailure(result) ? errorResult(text) : { content: [{ type: "text" as const, text }] };
  } catch (err: unknown) {
    console.error("[CC5 Bridge] bridgeCall caught error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`CC5 bridge error: ${message}. Is CC5 running with the MCP Bridge plugin?`);
  }
}
```
(keep the existing doc comment above `bridgeCall`.)

- [ ] **Step 3b: Route hand-built failures through `errorResult`.** These tools build their own results instead of calling `bridgeCall`, so Step 3 does not reach them. In `src/tools/scene.ts`, `src/tools/asset.ts` and `src/tools/metahuman.ts`, change `import { bridgeCall } from "../util.js";` to `import { bridgeCall, errorResult } from "../util.js";`. Then:
  - `scene.ts`, `check_cc5_connection`: replace the handler body with the code below.
```ts
    async () => {
      const down = "CC5 bridge is NOT responding. Make sure Character Creator 5 is running with the MCP Bridge plugin loaded.";
      try {
        const connected = await bridge.healthCheck();
        return connected
          ? { content: [{ type: "text" as const, text: "CC5 bridge is connected and ready." }] }
          : errorResult(down);
      } catch {
        return errorResult(down);
      }
    }
```
  - `scene.ts`, `capture_viewport`, in three returns:
    - the `pathError` return becomes `return errorResult(pathError);`
    - the `!result.success` return becomes ``return errorResult(`Failed: ${result.error}`);``
    - the catch return becomes ``return errorResult(`CC5 bridge error: ${message}`);``
  - `scene.ts`, `capture_viewport` tail: replace the `const content: Array<...> = [];` / `if (base64Data) {...} else {...}` / `return { content };` block with the code below.
```ts
        if (!base64Data) {
          return errorResult("Failed to capture viewport via both RenderImage and screen capture.");
        }
        return {
          content: [
            { type: "image" as const, data: base64Data, mimeType: "image/png" },
            { type: "text" as const, text: `Viewport captured: ${imgPath ?? "temp file"}` },
          ],
        };
```
  - `asset.ts`: both `return { content: [{ type: "text" as const, text: pathError }] };` lines (in `load_asset` and `export_fbx`) become `return errorResult(pathError);`. Each stays one line, so Task 9's `asset.ts:67` reference still holds.
  - `metahuman.ts`, `export_head_metahuman`: change the `dirError` line to `if (dirError) return errorResult(dirError);` and the `nameError` line to `if (nameError) return errorResult(nameError);`.

- [ ] **Step 4: Run** — `npm test` — Expected: all pass. If an existing test compares a whole failure result with `toEqual({ content: [...] })`, add `isError: true` to that expected object — that is the intended behaviour change.

- [ ] **Step 5: Commit**
```bash
git add src/util.ts src/tools/scene.ts src/tools/asset.ts src/tools/metahuman.ts tests
git commit -m "fix(tools): mark failed tool calls with isError"
```

---

### Task 5: Server-side jobs for long operations

**Files:**
- Modify: `cc5-plugin/server.py`
- Create: `tests/py/test_jobs.py`, `src/jobs.ts`, `src/tools/jobs.ts`, `tests/jobs.test.ts`, `tests/tools/jobs.test.ts`
- Modify: `src/cc5-bridge.ts`, `src/types.ts`, `src/index.ts`, `tests/helpers/mock-bridge.ts`

**Interfaces:**
- Produces (HTTP): `POST /jobs/start {action, params}` → `{"result": {"job_id": "cmd_N"}}`; `POST /jobs/status {job_id}` → `{"result": {"job_id","action","status":"queued"|"running"|"done"|"failed","result"?}}`. `exec_python` cannot run as a job.
- Produces (TS types): `JobStatus { job_id: string; action: string; status: "queued" | "running" | "done" | "failed"; result?: unknown }`.
- Produces (TS bridge): `startJob(action: string, params: Record<string, unknown>): Promise<{ job_id: string }>`, `getJob(jobId: string): Promise<JobStatus>`.
- Produces (`src/jobs.ts`): `runJob(bridge, action, params, opts?: { waitMs?: number; pollMs?: number }): Promise<JobOutcome>` where `type JobOutcome = { done: true; failed: boolean; result: unknown } | { done: false; job_id: string }`, and `formatPending(jobId: string): string`.
- Produces (MCP tool): `job_status(job_id)`.

- [ ] **Step 1: Failing Python test** — `tests/py/test_jobs.py`:
```python
import threading
import time

from test_auth import BridgeTestCase


class JobsTest(BridgeTestCase):
    def test_job_runs_and_reports_done(self):
        self.srv.ACTION_MAP["work"] = lambda p: {"success": True, "n": p["n"]}
        status, body = self.post("/jobs/start", {"action": "work", "params": {"n": 3}})
        self.assertEqual(status, 200)
        job_id = body["result"]["job_id"]
        for _ in range(50):
            _, st = self.post("/jobs/status", {"job_id": job_id})
            if st["result"]["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(st["result"]["result"], {"success": True, "n": 3})

    def test_failed_result_marks_job_failed(self):
        self.srv.ACTION_MAP["bad"] = lambda p: {"success": False, "error": "nope"}
        _, body = self.post("/jobs/start", {"action": "bad", "params": {}})
        time.sleep(0.2)
        _, st = self.post("/jobs/status", {"job_id": body["result"]["job_id"]})
        self.assertEqual(st["result"]["status"], "failed")

    def test_exec_python_not_allowed_as_job(self):
        self.assertEqual(self.post("/jobs/start", {"action": "exec_python", "params": {"code": "1"}})[0], 400)

    def test_non_object_params_rejected(self):
        self.assertEqual(self.post("/jobs/start", {"action": "search_morphs", "params": 5})[0], 400)

    def test_unknown_job_404(self):
        self.assertEqual(self.post("/jobs/status", {"job_id": "cmd_999999"})[0], 404)

    def test_status_answers_while_job_runs(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        self.srv.ACTION_MAP["slow"] = lambda p: gate.wait(5) or {"success": True}
        _, body = self.post("/jobs/start", {"action": "slow", "params": {}})
        job_id = body["result"]["job_id"]
        for _ in range(50):
            t0 = time.monotonic()
            status, st = self.post("/jobs/status", {"job_id": job_id})
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertEqual(status, 200)
            if st["result"]["status"] == "running":
                break
            time.sleep(0.02)
        self.assertEqual(st["result"]["status"], "running")
        gate.set()
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL (404 on `/jobs/start`).

- [ ] **Step 3: Implement in `server.py`**
```python
MAX_JOBS = 200
_jobs: dict[str, dict[str, Any]] = {}
JOB_FORBIDDEN = {"exec_python"}


def _start_job(action: str, params: dict) -> tuple[int, Any]:
    if action in JOB_FORBIDDEN or action not in ACTION_MAP:
        return 400, {"error": f"Action cannot run as a job: {action}"}
    error = _validate_params(action, params)
    if error:
        return 400, {"error": error}
    cmd_id = _next_command_id()
    with _store_lock:
        if len(_jobs) >= MAX_JOBS:
            for old_id in [j for j, v in _jobs.items() if v["status"] in ("done", "failed")][: len(_jobs) - MAX_JOBS + 1]:
                _jobs.pop(old_id, None)
        _jobs[cmd_id] = {"job_id": cmd_id, "action": action, "status": "queued"}
    try:
        command_queue.put_nowait({"id": cmd_id, "action": action, "params": params, "job": True})
    except queue.Full:
        with _store_lock:
            _jobs.pop(cmd_id, None)
        return 503, {"error": "server busy, command queue full"}
    return 200, {"result": {"job_id": cmd_id}}


def _job_status(job_id: str) -> tuple[int, Any]:
    with _store_lock:
        job = _jobs.get(job_id)
        return (200, {"result": dict(job)}) if job else (404, {"error": f"Unknown job: {job_id}"})
```
In `process_command_queue`, inside the lock where `_running_id` is set, add `if cmd.get("job"): _jobs[cmd_id]["status"] = "running"`. Replace the post-handler response block with:
```python
            with _store_lock:
                _running_id = None
                if cmd.get("job"):
                    failed = isinstance(result, dict) and result.get("success") is False
                    _jobs[cmd_id].update({"status": "failed" if failed else "done", "result": result})
                else:
                    event = response_events.pop(cmd_id, None)
                    if event:
                        response_store[cmd_id] = result
                        event.set()
```
In `do_POST`, after `_check_request` and `_read_json`, before the `POST_ROUTES` lookup:
```python
        if path == "/jobs/start":
            job_params = params.get("params") or {}
            if not isinstance(job_params, dict):
                self._send_json(400, {"error": "params must be a JSON object"})
                return
            status, data = _start_job(str(params.get("action", "")), job_params)
            self._send_json(status, data)
            return
        if path == "/jobs/status":
            status, data = _job_status(str(params.get("job_id", "")))
            self._send_json(status, data)
            return
```

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS tests** — `tests/jobs.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { runJob } from "../src/jobs.js";

function bridgeWith(statuses: Array<Record<string, unknown>>) {
  return {
    startJob: vi.fn().mockResolvedValue({ job_id: "cmd_1" }),
    getJob: vi.fn().mockImplementation(() => Promise.resolve(statuses.shift())),
  };
}

describe("runJob", () => {
  it("returns the result once the job is done", async () => {
    const b = bridgeWith([{ status: "running" }, { status: "done", result: { success: true } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toEqual({ done: true, failed: false, result: { success: true } });
  });

  it("reports failure", async () => {
    const b = bridgeWith([{ status: "failed", result: { success: false, error: "x" } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toMatchObject({ done: true, failed: true });
  });

  it("hands back the job id when it outlasts the wait", async () => {
    const b = { startJob: vi.fn().mockResolvedValue({ job_id: "cmd_7" }), getJob: vi.fn().mockResolvedValue({ status: "running" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 5, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_7" });
  });
});
```
`tests/tools/jobs.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerJobTools } from "../../src/tools/jobs.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerJobTools(server as any, bridge as any);
});

describe("job_status", () => {
  it("reports a running job", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "running" });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("Still running");
  });

  it("returns the finished result as JSON", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "x", status: "done", result: { success: true, fbx: "a.fbx" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("a.fbx");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/jobs.test.ts tests/tools/jobs.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 7: Implement**

`src/types.ts` append:
```ts
export interface JobStatus {
  job_id: string;
  action: string;
  status: "queued" | "running" | "done" | "failed";
  result?: unknown;
}
```
`src/cc5-bridge.ts` (add `JobStatus` to the type import) append methods:
```ts
  async startJob(action: string, params: Record<string, unknown>): Promise<{ job_id: string }> {
    return this.request<{ job_id: string }>("/jobs/start", "POST", { action, params });
  }

  async getJob(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>("/jobs/status", "POST", { job_id: jobId });
  }
```
`tests/helpers/mock-bridge.ts`: add `startJob: vi.fn(), getJob: vi.fn(),` to `createMockBridge()`.

`src/jobs.ts`:
```ts
/**
 * Start a bridge job and poll until it finishes or the wait budget runs out.
 * Long CC5 operations (exports, batches) run as jobs so no HTTP request times out mid-operation.
 */

import type { CC5Bridge } from "./cc5-bridge.js";

export type JobOutcome =
  | { done: true; failed: boolean; result: unknown }
  | { done: false; job_id: string };

export async function runJob(
  bridge: Pick<CC5Bridge, "startJob" | "getJob">,
  action: string,
  params: Record<string, unknown>,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<JobOutcome> {
  const waitMs = opts.waitMs ?? 25_000;
  const pollMs = opts.pollMs ?? 1_000;
  const { job_id } = await bridge.startJob(action, params);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const job = await bridge.getJob(job_id);
    if (job.status === "done" || job.status === "failed") {
      return { done: true, failed: job.status === "failed", result: job.result };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { done: false, job_id };
}

export function formatPending(jobId: string): string {
  return `Still running in CC5 (job ${jobId}). Call job_status with job_id "${jobId}" to get the result. Do not start the same operation again.`;
}
```
`src/tools/jobs.ts`:
```ts
/**
 * Job polling tool for long-running CC5 operations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall } from "../util.js";
import { formatPending } from "../jobs.js";

export function registerJobTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "job_status",
    "Check a long-running CC5 operation (export, batch) started earlier. Returns its result when finished.",
    { job_id: z.string().regex(/^cmd_\d+$/).describe("Job id returned by the earlier tool call") },
    async ({ job_id }) => {
      const res = await bridgeCall(
        () => bridge.getJob(job_id),
        (job) => {
          if (job.status === "queued" || job.status === "running") return formatPending(job_id);
          const label = job.status === "failed" ? "Failed" : "Finished";
          return `${label} (${job.action}):\n${JSON.stringify(job.result, null, 2)}`;
        },
      );
      return res.content[0].text.startsWith("Failed") ? errorResult(res.content[0].text) : res;
    }
  );
}
```
(import `errorResult` alongside `bridgeCall`.) `src/index.ts`: import and call `registerJobTools(server, bridge);`.

- [ ] **Step 8: Run** — `npm test && npm run test:py && npm run build` — Expected: all pass, build clean.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin/server.py src tests
git commit -m "feat(bridge): server-side jobs and job_status tool for long operations"
```

---

## Phase 2 — Trauma Simulator pipeline

### Task 6: Export straight into a Unity project

**Files:**
- Create: `cc5-plugin/cc5_pipeline.py`, `tests/py/test_pipeline_unity.py`, `src/tools/unity.ts`, `tests/tools/unity.test.ts`
- Modify: `cc5-plugin/server.py` (`EXTENSION_MODULES`), `src/index.ts`

**Interfaces:**
- Consumes: `cc5_api.export_fbx(output_path, options_flags, target_tool=..., sub_d_level=..., include_current_pose=..., embed_textures=..., export_motion=..., texture_size=..., convert_image_format=...) -> dict`; `runJob`, `formatPending`, `errorResult`.
- Produces (Python, `cc5_pipeline`): `SAFE_NAME` regex `^[A-Za-z0-9_-]{1,64}\Z`; `check_path(path: str) -> str | None`; `is_in_unity_assets(folder: str) -> bool`; `list_files(folder: str, since: float | None = None, max_entries: int = 2000) -> list[dict]` (`{"path", "bytes"}`; skips files modified before `since`, stops after `max_entries` folders + files so a broad folder cannot stall CC5's main thread); `export_for_unity(unity_dir: str, character_name: str, sub_d_level: int | None = None, texture_size: int | None = None, include_current_pose: bool = False) -> dict` → `{"success", "fbx", "folder", "files", "notes"}`; action `"export_for_unity"` (job-only, no POST route).
- Produces (TS): `isInUnityAssets(folder: string): boolean`, `isLocalAbsolute(p: string): boolean` (absolute, no '..', not a UNC/network or device path; reused by Tasks 7-8, 10, 12, 14-16), `CHARACTER_NAME` zod schema exported from `src/tools/unity.ts`; MCP tool `export_for_unity`.

- [ ] **Step 1: Failing Python test** — `tests/py/test_pipeline_unity.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


class ExportForUnityTest(unittest.TestCase):
    def setUp(self):
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.root = tempfile.mkdtemp()
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

    def test_exports_into_named_subfolder_with_unity_preset(self):
        def fake_export(path, flags, **kw):
            with open(path, "wb") as f:
                f.write(b"fbx")
            return {"success": True, "path": path, "notes": ["target_tool=Unity preset applied"]}

        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()), \
                mock.patch.object(self.pipe.cc5_api, "export_fbx", side_effect=fake_export) as exp:
            r = self.pipe.export_for_unity(self.assets, "Patient_01", texture_size=2048)
        self.assertTrue(r["success"])
        self.assertEqual(r["fbx"], os.path.join(self.assets, "Patient_01", "Patient_01.fbx"))
        kwargs = exp.call_args.kwargs
        self.assertEqual(kwargs["target_tool"], "Unity")
        self.assertFalse(kwargs["embed_textures"])
        self.assertFalse(kwargs["export_motion"])
        self.assertEqual(kwargs["texture_size"], 2048)
        self.assertTrue(kwargs["convert_image_format"])
        self.assertEqual(r["files"][0]["bytes"], 3)
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL (`No module named 'cc5_pipeline'`).

- [ ] **Step 3: Implement** — `cc5-plugin/cc5_pipeline.py`:
```python
"""
Export / import pipeline helpers: Unity export, mesh stats, poses, DCC round-trips.

Every function returns {"success": bool, ...}. All run on CC5's main thread via
the server queue. Arguments are validated before any RLPy call.
"""

from __future__ import annotations

import os
import re
import time
import urllib.parse
from typing import Any

import RLPy

import cc5_api

SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")  # \Z, not $: $ also matches before a trailing newline


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
) -> dict[str, Any]:
    """Export the current avatar with the Unity preset into <unity_dir>/<name>/<name>.fbx."""
    error = check_path(unity_dir)
    if error:
        return {"success": False, "error": error}
    if not is_in_unity_assets(unity_dir):
        return {"success": False, "error": f"Folder must be inside a Unity project's Assets folder: {unity_dir}"}
    if not SAFE_NAME.match(character_name or ""):
        return {"success": False, "error": "Character name must be 1-64 letters, digits, '_' or '-'"}
    if not cc5_api.get_first_avatar():
        return {"success": False, "error": "No avatar in scene"}
    folder = os.path.join(unity_dir, character_name)
    os.makedirs(folder, exist_ok=True)
    fbx = os.path.join(folder, character_name + ".fbx")
    started = time.time() - 2  # mtime slack; report only files this export wrote
    result = cc5_api.export_fbx(
        fbx, 0,
        target_tool="Unity",
        sub_d_level=sub_d_level,
        include_current_pose=include_current_pose,
        embed_textures=False,
        export_motion=False,
        texture_size=texture_size,
        convert_image_format=True,
    )
    if not result.get("success"):
        return result
    return {"success": True, "fbx": fbx, "folder": folder, "files": list_files(folder, since=started), "notes": result.get("notes", [])}


def _opt_int(p: dict, key: str) -> int | None:
    return int(p[key]) if p.get(key) is not None else None


ACTIONS: dict[str, Any] = {
    "export_for_unity": lambda p: export_for_unity(
        p["unity_dir"], p["character_name"], _opt_int(p, "sub_d_level"),
        _opt_int(p, "texture_size"), bool(p.get("include_current_pose", False))),
}
POST_ROUTES: dict[str, str] = {}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "export_for_unity": ["unity_dir", "character_name"],
}
```
In `server.py` set `EXTENSION_MODULES: list[str] = ["cc5_pipeline"]`.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS test** — `tests/tools/unity.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerUnityTools, isInUnityAssets, isLocalAbsolute } from "../../src/tools/unity.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerUnityTools(server as any, bridge as any);
});

describe("isInUnityAssets", () => {
  it("accepts a folder under Assets", () => expect(isInUnityAssets("D:/Proj/Assets/Chars")).toBe(true));
  it("rejects a folder outside Assets", () => expect(isInUnityAssets("D:/Proj/Exports")).toBe(false));
});

describe("isLocalAbsolute", () => {
  it("accepts a local drive path", () => expect(isLocalAbsolute("D:/Proj/Assets/Chars")).toBe(true));
  it("rejects UNC, device and NT-prefixed paths", () => {
    for (const p of ["//host/share/Assets", String.raw`\\host\share\Assets`, String.raw`\\?\UNC\host\share\Assets`, String.raw`\??\UNC\host\share`]) {
      expect(isLocalAbsolute(p)).toBe(false);
    }
  });
});

describe("export_for_unity", () => {
  const handler = () => server.getRegisteredTool("export_for_unity");

  it("refuses a folder outside Assets without calling CC5", async () => {
    const r = await handler()({ unity_dir: "D:/Exports", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("refuses a network (UNC) folder without calling CC5", async () => {
    const r = await handler()({ unity_dir: "//fileserver/share/Game/Assets/Characters", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("runs the export as a job and lists files", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
    bridge.getJob.mockResolvedValue({
      job_id: "cmd_1", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "D:/P/Assets/C/P1/P1.fbx", folder: "D:/P/Assets/C/P1", files: [{ path: "x.png", bytes: 1048576 }], notes: [] },
    });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ character_name: "P1" }));
    expect(r.content[0].text).toContain("P1.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("returns the job id when the export outlasts the wait", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "export_for_unity", status: "running" });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", wait_seconds: 0 });
    expect(r.content[0].text).toContain("cmd_9");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/unity.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement** — `src/tools/unity.ts`:
```ts
/**
 * Unity export: writes the current character with CC5's Unity preset
 * straight into a folder inside a Unity project's Assets tree.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { errorResult } from "../util.js";
import { runJob, formatPending } from "../jobs.js";

export const CHARACTER_NAME = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("File-safe name: letters, digits, '_' or '-' (max 64)");

/** Absolute local path without '..'. Rejects UNC/network paths (two leading slashes or backslashes) and device/NT paths (any '?'). */
export function isLocalAbsolute(p: string): boolean {
  return path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && !p.includes("?") && !p.includes("..");
}

export function isInUnityAssets(folder: string): boolean {
  return path.normalize(folder).split(/[\\/]/).some((p) => p.toLowerCase() === "assets");
}

export function formatFiles(files: Array<{ path: string; bytes: number }>): string {
  const totalMb = files.reduce((s, f) => s + f.bytes, 0) / 1_048_576;
  return `${files.length} files, ${totalMb.toFixed(1)} MB total`;
}

export function registerUnityTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "export_for_unity",
    "Export the current character as FBX with CC5's Unity preset into <unity_dir>/<character_name>/. unity_dir must be inside a Unity project's Assets folder. Runs as a background job; long exports return a job id for job_status.",
    {
      unity_dir: z.string().describe("Absolute folder inside a Unity project's Assets folder"),
      character_name: CHARACTER_NAME,
      sub_d_level: z.number().int().min(0).max(2).optional().describe("Subdivision level (0 = base mesh, best for Quest)"),
      texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]).optional(),
      include_current_pose: z.boolean().optional().describe("Export in the current pose instead of T-pose"),
      wait_seconds: z.number().int().min(0).max(120).default(25),
    },
    async ({ unity_dir, character_name, sub_d_level, texture_size, include_current_pose, wait_seconds }) => {
      if (!isLocalAbsolute(unity_dir)) return errorResult("unity_dir must be a local absolute path without '..' (no network/UNC paths)");
      if (!isInUnityAssets(unity_dir)) return errorResult(`unity_dir must be inside a Unity project's Assets folder: ${unity_dir}`);
      try {
        const out = await runJob(bridge, "export_for_unity",
          { unity_dir, character_name, sub_d_level, texture_size, include_current_pose },
          { waitMs: (wait_seconds ?? 25) * 1000 });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; fbx?: string; files?: Array<{ path: string; bytes: number }> };
        if (out.failed || !r.success) return errorResult(`Unity export failed: ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text" as const, text: `Exported ${r.fbx} (${formatFiles(r.files ?? [])}). Switch to Unity to import it.` }] };
      } catch (err) {
        return errorResult(`CC5 bridge error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
```
`src/index.ts`: import and call `registerUnityTools(server, bridge);`.

- [ ] **Step 8: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(unity): export_for_unity writes the Unity-preset FBX into a project's Assets folder"
```

---

### Task 7: Quest budget report (mesh stats + texture sizes)

**Files:**
- Modify: `cc5-plugin/cc5_pipeline.py`, `src/cc5-bridge.ts`, `src/types.ts`, `tests/helpers/mock-bridge.ts`, `src/tools/unity.ts`
- Create: `src/image-info.ts`, `tests/image-info.test.ts`, `tests/py/test_pipeline_stats.py`; extend `tests/tools/unity.test.ts`

**Interfaces:**
- Produces (Python): `get_mesh_stats() -> {"success", "meshes": [{"object","kind","mesh","vertices","faces","materials"}], "totals": {"vertices","faces","materials"}}`; route `GET`-style via `POST /pipeline/mesh_stats`.
- Produces (TS types): `MeshStat`, `MeshStatsResult` matching the above.
- Produces (TS): `bridge.getMeshStats(): Promise<MeshStatsResult>`; `readImageSize(file: string): { width: number; height: number } | null` (PNG, JPEG, TGA); `QUEST_DEFAULTS = { maxFaces: 65_000, maxTexturePx: 2048, maxTextureGpuMb: 66, maxMaterials: 20 }` (measured from `Patient_FemaleWhite`, see Global Constraints; each overridable by env `CC5_BUDGET_MAX_FACES`, `CC5_BUDGET_MAX_TEXTURE_PX`, `CC5_BUDGET_MAX_TEXTURE_GPU_MB`, `CC5_BUDGET_MAX_MATERIALS`); `estimateTextureGpuMb(textures: TextureInfo[], maxPx: number): number` (MiB; ASTC 6x6 = 3.56 bpp, mips × 4/3, longer edge clamped to `maxPx`); `evaluateBudget(stats, textures, limits) -> { pass: boolean; lines: string[] }`; MCP tool `check_quest_budget`.

- [ ] **Step 1: Failing Python test** — `tests/py/test_pipeline_stats.py`:
```python
import unittest
from unittest import mock

import _support


def _mesh(name, v, f):
    m = mock.MagicMock()
    m.GetName.return_value = name
    m.GetVerticesCount.return_value = v
    m.GetFacesCount.return_value = f
    return m


def _obj(name, meshes, mats_per_mesh):
    o = mock.MagicMock()
    o.GetName.return_value = name
    o.GetMeshes.return_value = meshes
    o.GetMaterialComponent.return_value.GetMaterialNames.return_value = ["m"] * mats_per_mesh
    return o


class MeshStatsTest(unittest.TestCase):
    def setUp(self):
        self.pipe = _support.fresh_import("cc5_pipeline")

    def test_no_avatar(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=None):
            self.assertFalse(self.pipe.get_mesh_stats()["success"])

    def test_totals_across_body_clothes_hair(self):
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 14000, 13000)], 6)
        avatar.GetClothes.return_value = [_obj("Shirt", [_mesh("Shirt", 3000, 2900)], 1)]
        avatar.GetHairs.return_value = [_obj("Hair", [_mesh("Hair", 9000, 8000)], 2)]
        avatar.GetAccessories.return_value = []
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.pipe.get_mesh_stats()
        self.assertTrue(r["success"])
        self.assertEqual(r["totals"], {"vertices": 26000, "faces": 23900, "materials": 9})
        self.assertEqual([m["kind"] for m in r["meshes"]], ["body", "clothing", "hair"])

    def test_worn_meshes_in_avatar_list_counted_once(self):
        # GetMeshes(True) on the avatar may also return worn-item meshes (child nodes).
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 14000, 13000), _mesh("Shirt", 3000, 2900), _mesh("Hair", 9000, 8000)], 6)
        avatar.GetClothes.return_value = [_obj("Shirt", [_mesh("Shirt", 3000, 2900)], 1)]
        avatar.GetHairs.return_value = [_obj("Hair", [_mesh("Hair", 9000, 8000)], 2)]
        avatar.GetAccessories.return_value = []
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.pipe.get_mesh_stats()
        self.assertEqual(r["totals"], {"vertices": 26000, "faces": 23900, "materials": 9})
        self.assertEqual([(m["kind"], m["mesh"]) for m in r["meshes"]], [("body", "CC_Base_Body"), ("clothing", "Shirt"), ("hair", "Hair")])
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** — append to `cc5_pipeline.py` (above `ACTIONS`):
```python
def _parts(avatar) -> list[tuple[str, Any]]:
    parts: list[tuple[str, Any]] = [("body", avatar)]
    parts += [("clothing", c) for c in (avatar.GetClothes() or [])]
    parts += [("hair", h) for h in (avatar.GetHairs() or [])]
    parts += [("accessory", a) for a in (avatar.GetAccessories(True) or [])]
    return parts


def get_mesh_stats() -> dict[str, Any]:
    """Vertex/face/material counts for the avatar and everything it wears."""
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    meshes: list[dict[str, Any]] = []
    seen: set[str] = set()
    parts = _parts(avatar)
    # Worn items first, body last: if avatar.GetMeshes(True) also returns worn-item meshes
    # (LIVE-VERIFY in Task 18), each mesh is still counted once, under its own kind.
    for kind, obj in parts[1:] + parts[:1]:
        mat_comp = obj.GetMaterialComponent() if hasattr(obj, "GetMaterialComponent") else None
        for mesh in obj.GetMeshes(True) or []:
            name = mesh.GetName()
            if name in seen:
                continue
            seen.add(name)
            try:
                mats = len(mat_comp.GetMaterialNames(name) or []) if mat_comp else 0
            except Exception:
                mats = 0
            meshes.append({
                "object": obj.GetName(), "kind": kind, "mesh": name,
                "vertices": int(mesh.GetVerticesCount()), "faces": int(mesh.GetFacesCount()),
                "materials": mats,
            })
    meshes.sort(key=lambda m: ("body", "clothing", "hair", "accessory").index(m["kind"]))
    totals = {k: sum(m[k] for m in meshes) for k in ("vertices", "faces", "materials")}
    return {"success": True, "meshes": meshes, "totals": totals}
```
Add to `ACTIONS`: `"get_mesh_stats": lambda p: get_mesh_stats(),` and to `POST_ROUTES`: `"/pipeline/mesh_stats": "get_mesh_stats",`.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS tests** — `tests/image-info.test.ts`:
```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { readImageSize } from "../src/image-info.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));

function write(name: string, bytes: number[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

describe("readImageSize", () => {
  it("reads PNG IHDR", () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0x08, 0x00, 0, 0, 0x04, 0x00];
    expect(readImageSize(write("a.png", png))).toEqual({ width: 2048, height: 1024 });
  });

  it("reads JPEG SOF0", () => {
    const jpg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x00, 0x04, 0x00, 3, 0, 0, 0];
    expect(readImageSize(write("a.jpg", jpg))).toEqual({ width: 1024, height: 512 });
  });

  it("reads TGA header", () => {
    const tga = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0x08, 32, 0];
    expect(readImageSize(write("a.tga", tga))).toEqual({ width: 4096, height: 2048 });
  });

  it("returns null for unknown data", () => {
    expect(readImageSize(write("a.bin", [1, 2, 3]))).toBeNull();
  });
});
```
Append to `tests/tools/unity.test.ts`:
```ts
import { evaluateBudget, estimateTextureGpuMb, QUEST_DEFAULTS } from "../../src/tools/unity.js";

describe("evaluateBudget", () => {
  const stats = { success: true, meshes: [], totals: { vertices: 1, faces: 40_000, materials: 10 } };

  it("passes within limits", () => {
    const r = evaluateBudget(stats, [{ path: "a.png", bytes: 1_000_000, width: 2048, height: 2048 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(true);
  });

  it("fails on faces and oversize textures, naming the offenders", () => {
    const r = evaluateBudget({ ...stats, totals: { vertices: 1, faces: 80_000, materials: 10 } },
      [{ path: "Body_Diffuse.png", bytes: 1, width: 4096, height: 4096 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("80,000");
    expect(r.lines.join("\n")).toContain("Body_Diffuse.png");
  });

  it("fails when a texture's size cannot be read, naming it", () => {
    const r = evaluateBudget(stats, [{ path: "Body_Diffuse.tif", bytes: 1, width: 0, height: 0 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("Body_Diffuse.tif");
  });

  it("fails when estimated texture GPU memory is over budget, and reports file size as information", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `t${i}.png`, bytes: 1_048_576, width: 2048, height: 2048 }));
    const r = evaluateBudget(stats, many, QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("Texture GPU memory");
    expect(r.lines.join("\n")).toContain("Texture files on disk: 40.0 MiB");
  });
});

describe("estimateTextureGpuMb", () => {
  it("prices a 2048px texture as ASTC 6x6 with mips", () => {
    expect(estimateTextureGpuMb([{ path: "a.png", bytes: 1, width: 2048, height: 2048 }], 2048)).toBeCloseTo(2.373, 3);
  });

  it("clamps the longer edge to maxPx, keeping the aspect ratio", () => {
    const clamped = estimateTextureGpuMb([{ path: "a.png", bytes: 1, width: 4096, height: 2048 }], 2048);
    const direct = estimateTextureGpuMb([{ path: "b.png", bytes: 1, width: 2048, height: 1024 }], 2048);
    expect(clamped).toBeCloseTo(direct, 6);
  });

  it("ignores textures whose size is unreadable", () => {
    expect(estimateTextureGpuMb([{ path: "a.tif", bytes: 1, width: 0, height: 0 }], 2048)).toBe(0);
  });
});

describe("check_quest_budget", () => {
  it("rejects an export_folder that is a file, without calling CC5", async () => {
    const r = await server.getRegisteredTool("check_quest_budget")({ export_folder: `${process.cwd()}/package.json` });
    expect(r.isError).toBe(true);
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
  });

  it("says when no textures were scanned", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({});
    expect(r.content[0].text).toContain("no texture images scanned");
  });

  it("reports mesh totals without an export folder", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({});
    expect(r.content[0].text).toContain("PASS");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/image-info.test.ts tests/tools/unity.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement**

`src/image-info.ts`:
```ts
/**
 * Read image dimensions from file headers (PNG, JPEG, TGA) without decoding.
 */

import fs from "node:fs";

export function readImageSize(file: string): { width: number; height: number } | null {
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    buf = Buffer.alloc(65_536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, n);
  } catch {
    return null;
  }
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (file.toLowerCase().endsWith(".tga") && buf.length >= 18) {
    return { width: buf.readUInt16LE(12), height: buf.readUInt16LE(14) };
  }
  return null;
}
```
`src/types.ts` append:
```ts
export interface MeshStat { object: string; kind: "body" | "clothing" | "hair" | "accessory"; mesh: string; vertices: number; faces: number; materials: number }
export interface MeshStatsResult { success: boolean; error?: string; meshes: MeshStat[]; totals: { vertices: number; faces: number; materials: number } }
```
`src/cc5-bridge.ts` (add `MeshStatsResult` to the `./types.js` type import):
```ts
  async getMeshStats(): Promise<MeshStatsResult> {
    return this.request<MeshStatsResult>("/pipeline/mesh_stats", "POST", {});
  }
```
`tests/helpers/mock-bridge.ts`: add `getMeshStats: vi.fn(),`.

Append to `src/tools/unity.ts` (add imports `fs from "node:fs"`, `readImageSize` from `"../image-info.js"`, `bridgeCall` from `"../util.js"`, type `MeshStatsResult` from `"../types.js"`):
```ts
function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Defaults match the heaviest shipping Trauma Sim patient (Patient_FemaleWhite), measured 2026-10-02.
// maxFaces is in triangles; maxTextureGpuMb is the textures' estimated Quest GPU memory in MiB (bytes / 1,048,576).
export const QUEST_DEFAULTS = {
  maxFaces: envNumber("CC5_BUDGET_MAX_FACES", 65_000),
  maxTexturePx: envNumber("CC5_BUDGET_MAX_TEXTURE_PX", 2048),
  maxTextureGpuMb: envNumber("CC5_BUDGET_MAX_TEXTURE_GPU_MB", 66),
  maxMaterials: envNumber("CC5_BUDGET_MAX_MATERIALS", 20),
};
export type BudgetLimits = typeof QUEST_DEFAULTS;
export type TextureInfo = { path: string; bytes: number; width: number; height: number };

// Same model the reference measurement used: ASTC 6x6 (Unity's default Android compression) with a full mip chain.
const ASTC_6X6_BITS_PER_PIXEL = 3.56;
const MIP_CHAIN_FACTOR = 4 / 3;

/** Estimated Quest GPU memory in MiB, each texture scaled so its longer edge is at most maxPx (Unity's import clamp). */
export function estimateTextureGpuMb(textures: TextureInfo[], maxPx: number): number {
  let bytes = 0;
  for (const t of textures) {
    const longEdge = Math.max(t.width, t.height);
    if (longEdge === 0) continue;
    const scale = Math.min(1, maxPx / longEdge);
    bytes += (t.width * scale) * (t.height * scale) * (ASTC_6X6_BITS_PER_PIXEL / 8) * MIP_CHAIN_FACTOR;
  }
  return bytes / 1_048_576;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff"]);

export function scanTextures(folder: string): TextureInfo[] {
  const out: TextureInfo[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        const size = readImageSize(full) ?? { width: 0, height: 0 };
        out.push({ path: full, bytes: fs.statSync(full).size, ...size });
      }
    }
  };
  walk(folder);
  return out;
}

export function evaluateBudget(stats: MeshStatsResult, textures: TextureInfo[], limits: BudgetLimits): { pass: boolean; lines: string[] } {
  const lines: string[] = [];
  let pass = true;
  const check = (ok: boolean, text: string) => { if (!ok) pass = false; lines.push(`${ok ? "OK  " : "OVER"} ${text}`); };
  const fmt = (n: number) => n.toLocaleString("en-US");
  check(stats.totals.faces <= limits.maxFaces, `Faces: ${fmt(stats.totals.faces)} / ${fmt(limits.maxFaces)}`);
  check(stats.totals.materials <= limits.maxMaterials, `Materials: ${stats.totals.materials} / ${limits.maxMaterials}`);
  if (textures.length) {
    const gpuMb = estimateTextureGpuMb(textures, limits.maxTexturePx);
    check(gpuMb <= limits.maxTextureGpuMb,
      `Texture GPU memory (est., ASTC 6x6 + mips): ${gpuMb.toFixed(1)} MiB / ${limits.maxTextureGpuMb} MiB`);
    const fileMb = textures.reduce((s, t) => s + t.bytes, 0) / 1_048_576;
    lines.push(`     Texture files on disk: ${fileMb.toFixed(1)} MiB (information only)`);
    const big = textures.filter((t) => Math.max(t.width, t.height) > limits.maxTexturePx);
    check(big.length === 0, `Textures larger than ${limits.maxTexturePx}px: ${big.length}`);
    for (const t of big) lines.push(`     ${path.basename(t.path)} (${t.width}x${t.height})`);
    const unreadable = textures.filter((t) => t.width === 0 || t.height === 0);
    check(unreadable.length === 0, `Textures with unreadable size: ${unreadable.length}`);
    for (const t of unreadable) lines.push(`     ${path.basename(t.path)} (size unreadable)`);
  } else {
    lines.push("     (no texture images scanned)");
  }
  return { pass, lines };
}
```
And register inside `registerUnityTools`:
```ts
  server.tool(
    "check_quest_budget",
    "Check the current character against the Quest 3 per-character budget (faces, materials, and — when export_folder is given — texture sizes). Defaults (matching the current Trauma Sim patient): 65,000 faces (triangles), 20 materials, 2048px textures, 66 MiB estimated texture GPU memory (ASTC 6x6 + mips; file size on disk is reported but not limited).",
    {
      export_folder: z.string().optional().describe("Folder from export_for_unity, to include texture checks"),
      max_faces: z.number().int().positive().optional(),
      max_materials: z.number().int().positive().optional(),
      max_texture_px: z.number().int().positive().optional(),
      max_texture_gpu_mb: z.number().positive().optional(),
    },
    async ({ export_folder, max_faces, max_materials, max_texture_px, max_texture_gpu_mb }) => {
      if (export_folder && (!isLocalAbsolute(export_folder) || !fs.existsSync(export_folder))) {
        return errorResult(`export_folder must be an existing local absolute folder (no network/UNC paths): ${export_folder}`);
      }
      if (export_folder && !fs.statSync(export_folder).isDirectory()) {
        return errorResult(`export_folder is not a folder: ${export_folder}`);
      }
      const limits: BudgetLimits = {
        maxFaces: max_faces ?? QUEST_DEFAULTS.maxFaces,
        maxMaterials: max_materials ?? QUEST_DEFAULTS.maxMaterials,
        maxTexturePx: max_texture_px ?? QUEST_DEFAULTS.maxTexturePx,
        maxTextureGpuMb: max_texture_gpu_mb ?? QUEST_DEFAULTS.maxTextureGpuMb,
      };
      const res = await bridgeCall(() => bridge.getMeshStats(), (stats) => {
        if (!stats.success) return `Failed: ${stats.error}`;
        const { pass, lines } = evaluateBudget(stats, export_folder ? scanTextures(export_folder) : [], limits);
        return `${pass ? "PASS" : "FAIL"} — Quest budget\n${lines.join("\n")}`;
      });
      return res.content[0].text.startsWith("FAIL") ? errorResult(res.content[0].text) : res;
    }
  );
```

- [ ] **Step 8: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(unity): check_quest_budget with mesh stats and texture header scan"
```

---

### Task 8: Pose before export, save character

**Files:**
- Modify: `cc5-plugin/cc5_pipeline.py`, `cc5-plugin/cc5_api.py` (`browse_content` extension filter for `pose`/`motion`), `src/cc5-bridge.ts`, `tests/helpers/mock-bridge.ts`, `src/index.ts`
- Create: `tests/py/test_pipeline_pose.py`, `src/tools/pipeline.ts`, `tests/tools/pipeline.test.ts`

**Interfaces:**
- Produces (Python): `apply_pose(file_path: str) -> {"success", "method": "LoadFile" | "LoadMotion"}` (POST `/pipeline/pose`, LIVE-VERIFY); `save_character(output_path: str) -> {"success", "path"}` (POST `/pipeline/save_character`, `.ccAvatar` only).
- Produces (TS bridge): `applyPose(filePath: string): Promise<OperationResult & { method?: string }>`, `saveCharacter(outputPath: string): Promise<OperationResult & { path?: string }>`.
- Produces (MCP tools in new `src/tools/pipeline.ts`, `registerPipelineTools(server, bridge)`): `apply_pose`, `save_character`. Later tasks add more tools to this file.

- [ ] **Step 1: Failing Python test** — `tests/py/test_pipeline_pose.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


class PoseTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.avatar = mock.MagicMock()
        self.dir = tempfile.mkdtemp()

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_rejects_wrong_extension(self):
        self.assertFalse(self.pipe.apply_pose(self._file("x.png"))["success"])

    def test_missing_file(self):
        self.assertFalse(self.pipe.apply_pose(os.path.join(self.dir, "nope.rlMotion"))["success"])

    def test_selects_avatar_then_loads(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(self._file("lying.rlMotion"))
        self.assertTrue(r["success"])
        self.rl.RScene.SelectObject.assert_called_with(self.avatar)
        self.assertEqual(r["method"], "LoadFile")

    def test_falls_back_to_load_motion(self):
        self.rl.RFileIO.LoadFile.side_effect = RuntimeError("not applicable")
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(self._file("lying.rlMotion"))
        self.assertEqual(r["method"], "LoadMotion")

    def test_error_status_falls_back_to_load_motion(self):
        # RLPy reports failure via RStatus, not an exception
        self.rl.RFileIO.LoadFile.return_value.IsError.return_value = True
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.apply_pose(self._file("lying.rlMotion"))
        self.assertTrue(r["success"])
        self.assertEqual(r["method"], "LoadMotion")

    def test_save_character_requires_ccavatar(self):
        self.assertFalse(self.pipe.save_character(os.path.join(self.dir, "a.fbx"))["success"])

    def test_save_character_saves_as_character(self):
        out = os.path.join(self.dir, "bases", "Male.ccAvatar")
        # save_character checks that the file exists afterwards, so the fake SaveFile writes it.
        self.rl.RFileIO.SaveFile.side_effect = lambda obj, setting, path: open(path, "wb").close()
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.save_character(out)
        self.assertEqual(r, {"success": True, "path": out})
        setting = self.rl.RSaveFileSetting.return_value
        setting.SetSaveType.assert_called_once_with(self.rl.ESaveFileType_Character)
        self.rl.RFileIO.SaveFile.assert_called_once_with(self.avatar, setting, out)

    def test_save_character_fails_when_nothing_written(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.save_character(os.path.join(self.dir, "base.ccAvatar"))
        self.assertFalse(r["success"])

    def test_accepts_cc_native_pose_extension(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            self.assertTrue(self.pipe.apply_pose(self._file("lying.ccPose"))["success"])


class BrowsePoseTest(unittest.TestCase):
    """browse_content('pose'/'motion') must list the .rl* files apply_pose accepts."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.rl.RApplication.GetDefaultContentFolder.return_value = "$/Template"
        self.rl.RApplication.GetCustomContentFolder.return_value = ""
        self.rl.RApplication.GetContentFilesInFolder.return_value = [
            "C:/c/Lying.rlMotion", "C:/c/Supine.rlPose", "C:/c/Old.iMotion", "C:/c/New.ccPose", "C:/c/Lying.png"]

    def test_pose_lists_rl_files(self):
        self.assertEqual(self.api.browse_content("pose"),
                         ["C:/c/Lying.rlMotion", "C:/c/Supine.rlPose", "C:/c/Old.iMotion", "C:/c/New.ccPose"])

    def test_other_folders_keep_cc_i_filter(self):
        self.assertEqual(self.api.browse_content("shoes"), ["C:/c/Old.iMotion", "C:/c/New.ccPose"])
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** — append to `cc5_pipeline.py`:
```python
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


def _raise_on_error(status: Any, what: str) -> None:
    """RLPy file calls return an RStatus instead of raising; turn an error status into an exception."""
    is_error = getattr(status, "IsError", None)
    if callable(is_error) and is_error() is True:
        raise RuntimeError(f"{what} reported an error status")


def apply_pose(file_path: str) -> dict[str, Any]:
    """Apply a pose/motion file to the avatar (LIVE-VERIFY: LoadFile on selection, then LoadMotion)."""
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
            _raise_on_error(RLPy.RFileIO.LoadFile(file_path), "LoadFile")
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


def save_character(output_path: str) -> dict[str, Any]:
    """Save the avatar as a .ccAvatar so batch runs can reload a clean base."""
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
        setting = RLPy.RSaveFileSetting()
        setting.SetSaveType(RLPy.ESaveFileType_Character)
        _raise_on_error(RLPy.RFileIO.SaveFile(avatar, setting, output_path), "SaveFile")
    except Exception as e:
        return {"success": False, "error": str(e)}
    if not os.path.isfile(output_path):
        return {"success": False, "error": f"CC5 did not write {output_path}"}
    return {"success": True, "path": output_path}
```
`ACTIONS` add: `"apply_pose": lambda p: apply_pose(p["file_path"]),` `"save_character": lambda p: save_character(p["output_path"]),`. `POST_ROUTES` add `"/pipeline/pose": "apply_pose",` `"/pipeline/save_character": "save_character",`. `REQUIRED_PARAMS` add `"apply_pose": ["file_path"],` `"save_character": ["output_path"],`.

In `cc5_api.browse_content`, replace the filter line `if (ext.startswith(".cc") or ext.startswith(".i")) and f not in seen:` with
```python
                if (ext.startswith((".cc", ".i")) or (folder_type in ("pose", "motion") and ext.startswith(".rl"))) and f not in seen:
```
and add `# pose/motion folders also hold .rlMotion/.rlPose files (apply_pose, not load_asset).` to the comment above it. Other folder types keep the `.cc*`/`.i*` filter, so `load_asset` never receives `.rl*` paths.

(LIVE-VERIFY in Task 18: `RSaveFileSetting.SetSaveType` is the expected setter; if CC5 reports no such method, list `dir(RLPy.RSaveFileSetting())` via `exec_python` with dev mode on and adjust.)

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS test** — `tests/tools/pipeline.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerPipelineTools } from "../../src/tools/pipeline.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPipelineTools(server as any, bridge as any);
});

describe("apply_pose", () => {
  it("rejects traversal without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/a/../b.rlMotion" });
    expect(r.isError).toBe(true);
    expect(bridge.applyPose).not.toHaveBeenCalled();
  });

  it("rejects a network (UNC) path without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "//fileserver/share/Supine.rlMotion" });
    expect(r.isError).toBe(true);
    expect(bridge.applyPose).not.toHaveBeenCalled();
  });

  it("applies a pose", async () => {
    bridge.applyPose.mockResolvedValue({ success: true, method: "LoadFile" });
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/Poses/Supine.rlMotion" });
    expect(r.content[0].text).toContain("Supine.rlMotion");
  });
});

describe("save_character", () => {
  it("requires .ccAvatar", async () => {
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/a/b.fbx" });
    expect(r.isError).toBe(true);
  });

  it("saves the character", async () => {
    bridge.saveCharacter.mockResolvedValue({ success: true, path: "C:/Bases/Male.ccAvatar" });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/Bases/Male.ccAvatar" });
    expect(bridge.saveCharacter).toHaveBeenCalledWith("C:/Bases/Male.ccAvatar");
    expect(r.content[0].text).toContain("Saved C:/Bases/Male.ccAvatar");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/pipeline.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement**

`src/cc5-bridge.ts`:
```ts
  async applyPose(filePath: string): Promise<OperationResult & { method?: string }> {
    return this.request("/pipeline/pose", "POST", { file_path: filePath });
  }

  async saveCharacter(outputPath: string): Promise<OperationResult & { path?: string }> {
    return this.request("/pipeline/save_character", "POST", { output_path: outputPath });
  }
```
`tests/helpers/mock-bridge.ts`: add `applyPose: vi.fn(), saveCharacter: vi.fn(),`.

`src/tools/pipeline.ts`:
```ts
/**
 * Pipeline tools: poses, saving, and DCC round-trips (Blender, Substance Painter, ZBrush).
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult } from "../util.js";
import { isLocalAbsolute } from "./unity.js";

/** Local absolute path (no '..', no UNC/network or device path), extension in the allowed set. Returns an error message or null. */
export function checkFile(filePath: string, allowed: string[]): string | null {
  if (filePath.includes("..")) return "Path traversal ('..') is not allowed";
  if (!isLocalAbsolute(filePath)) return `Path must be a local absolute path (no network/UNC or device paths): ${filePath}`;
  const ext = path.extname(filePath).toLowerCase();
  if (!allowed.includes(ext)) return `Unsupported file type ${ext || "(none)"}. Allowed: ${allowed.join(", ")}`;
  return null;
}

// Keep in sync with POSE_EXTENSIONS in cc5-plugin/cc5_pipeline.py.
export const POSE_EXTENSIONS = [".rlmotion", ".imotion", ".rlpose", ".ipose", ".imotionplus", ".ccpose", ".ccmotion"];

export function registerPipelineTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "apply_pose",
    "Apply a pose or motion file (.rlMotion, .rlPose, .iMotion, .iPose, .iMotionPlus, .ccPose, .ccMotion) to the current character, e.g. a supine pose before export. Use browse_content('pose') or browse_content('motion') to find files.",
    { file_path: z.string().describe("Absolute path to the pose/motion file") },
    async ({ file_path }) => {
      const err = checkFile(file_path, POSE_EXTENSIONS);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.applyPose(file_path),
        (r) => r.success ? `Applied pose ${path.basename(file_path)} (${r.method})` : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "save_character",
    "Save the current character as a .ccAvatar file (used as the clean base for batch generation).",
    { output_path: z.string().describe("Absolute path ending in .ccAvatar") },
    async ({ output_path }) => {
      const err = checkFile(output_path, [".ccavatar"]);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.saveCharacter(output_path),
        (r) => r.success ? `Saved ${r.path}` : `Failed: ${r.error}`);
    }
  );
}
```
`src/index.ts`: import and call `registerPipelineTools(server, bridge);`.

- [ ] **Step 8: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(pipeline): apply_pose and save_character"
```

---

## Phase 3 — Blender / Substance Painter / ZBrush round-trips

### Task 9: Blender FBX preset and OBJ export

**Files:**
- Modify: `cc5-plugin/cc5_api.py` (`export_fbx` target presets ~line 479; flags3 handling), `cc5-plugin/cc5_pipeline.py`, `src/tools/asset.ts:67`, `src/types.ts:233`, `src/cc5-bridge.ts`, `tests/helpers/mock-bridge.ts`, `src/tools/pipeline.ts`
- Create: `tests/py/test_export_blender.py`; extend `tests/tools/pipeline.test.ts`, `tests/tools/asset.test.ts`

**Interfaces:**
- Produces (Python, `cc5_pipeline`): `try_signatures(attempts: list[tuple[str, Callable[[], Any]]]) -> tuple[str | None, str | None]` (first label that ran without raising, or `None` plus joined errors) — reused by Tasks 10-12; `export_obj(output_path: str, y_up: bool = True) -> {"success", "path", "signature"}` (POST `/pipeline/export_obj`, LIVE-VERIFY).
- Produces: `export_fbx` accepts `target_tool="Blender"` → Default flags **plus** `EExportFbxOptions3_ExportJson`, **no** Y-up flag (Blender is Z-up; Reallusion's CC/iC Blender Tools add-on reads the JSON sidecar to rebuild materials).
- Produces (TS): `target_tool` enum gains `"Blender"`; `bridge.exportObj(outputPath: string, yUp: boolean): Promise<OperationResult & { path?: string; signature?: string }>`; MCP tool `export_obj`.

- [ ] **Step 1: Failing Python test** — `tests/py/test_export_blender.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


class BlenderPresetTest(unittest.TestCase):
    JSON_BIT = 1 << 30

    def setUp(self):
        import re
        self.rl = _support.install_fake_rlpy()
        # export_fbx ORs RLPy flag enums together; give every one it names a real int.
        with open(os.path.join(_support.PLUGIN_DIR, "cc5_api.py"), encoding="utf-8") as f:
            names = sorted(set(re.findall(r"EExportFbxOptions\w+", f.read())))
        for i, name in enumerate(names):
            setattr(self.rl, name, 1 << (i % 30))
        self.rl.EExportFbxOptions3_ExportJson = self.JSON_BIT
        self.api = _support.fresh_import("cc5_api")

    def test_blender_preset_note_and_json_flag(self):
        with mock.patch.object(self.api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.api.export_fbx(os.path.join(tempfile.mkdtemp(), "b.fbx"), 0, target_tool="Blender")
        self.assertIn("target_tool=Blender preset applied", r.get("notes", []))
        if r.get("flags_applied"):
            self.assertEqual(r["flags3"] & self.JSON_BIT, self.JSON_BIT)
            root_motion = self.rl.EExportFbxOptions_ExportRootMotion
            self.assertEqual(r["flags"] & root_motion, root_motion)


class ExportObjTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")

    def test_requires_obj_extension(self):
        self.assertFalse(self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.fbx"))["success"])

    def test_reports_signature_used(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_obj(os.path.join(tempfile.mkdtemp(), "a.obj"))
        self.assertTrue(r["success"])
        self.assertTrue(r["signature"])

    def test_try_signatures_falls_through(self):
        def boom():
            raise TypeError("bad args")
        label, err = self.pipe.try_signatures([("a", boom), ("b", lambda: None)])
        self.assertEqual(label, "b")
        self.assertIsNone(err)
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL (no Blender note, no `export_obj`).

- [ ] **Step 3: Implement**

In `cc5_api.export_fbx`, add a branch after the `MAYA` preset:
```python
    elif target_upper == "BLENDER":
        flags |= _safe_flag("EExportFbxOptions_AutoSkinRigidMesh")
        flags |= _safe_flag("EExportFbxOptions_ExportRootMotion")
        flags3 |= _safe_flag("EExportFbxOptions3_ExportJson")
        notes.append("target_tool=Blender preset applied")
```
Confirm `flags3` is already passed to the setting object where `applied_flags3` is computed (search `flags3` in `export_fbx`); if the setting object path sets flags3 only for texture options, OR in the Blender bit before that call — the result's `"flags3"` must include `EExportFbxOptions3_ExportJson` when the setting object was used.

In `cc5_pipeline.py` (above `ACTIONS`):
```python
def try_signatures(attempts: list[tuple[str, Any]]) -> tuple[str | None, str | None]:
    """Run each (label, fn) until one doesn't raise. For RLPy calls documented only as *args."""
    errors: list[str] = []
    for label, fn in attempts:
        try:
            fn()
            return label, None
        except Exception as e:
            errors.append(f"{label}: {e}")
    return None, "; ".join(errors)


def export_obj(output_path: str, y_up: bool = True) -> dict[str, Any]:
    """Export the avatar as OBJ for sculpting (LIVE-VERIFY: ExportObjFile is documented as *args)."""
    error = check_path(output_path)
    if error:
        return {"success": False, "error": error}
    if os.path.splitext(output_path)[1].lower() != ".obj":
        return {"success": False, "error": "output_path must end with .obj"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    # EExport3DFileOption is a bitmask: the part bits pick what is written and ResetToBindPose
    # keeps the rest shape that replace_mesh_from_obj needs (same topology, bind pose).
    option = 0
    for name in ("EExport3DFileOption_FullBodyPart", "EExport3DFileOption_AllClothes",
                 "EExport3DFileOption_ResetToBindPose", "EExport3DFileOption_ExportMaterial"):
        option |= getattr(RLPy, name, 0)
    if y_up:
        option |= RLPy.EExport3DFileOption_AxisYUp
    label, err = try_signatures([
        ("(avatar, path, option)", lambda: RLPy.RFileIO.ExportObjFile(avatar, output_path, option)),
        ("(avatar, path)", lambda: RLPy.RFileIO.ExportObjFile(avatar, output_path)),
    ])
    if not label:
        return {"success": False, "error": f"ExportObjFile failed: {err}"}
    return {"success": True, "path": output_path, "signature": label}
```
`ACTIONS`: `"export_obj": lambda p: export_obj(p["output_path"], bool(p.get("y_up", True))),` · `POST_ROUTES`: `"/pipeline/export_obj": "export_obj",` · `REQUIRED_PARAMS`: `"export_obj": ["output_path"],`.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS tests** — append to `tests/tools/asset.test.ts`:
```ts
describe("export_fbx Blender target", () => {
  it("schema accepts target_tool Blender", () => {
    const call = server.tool.mock.calls.find((c) => c[0] === "export_fbx")!;
    const shape = call[2] as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(shape.target_tool.safeParse("Blender").success).toBe(true);
  });
});
```
(The mock server never runs the zod shape, so this test checks the registered `target_tool` schema directly. `npm run build` does not catch a missing zod enum entry, because the handler casts `extra as ExportFbxOptions`.) Append to `tests/tools/pipeline.test.ts`:
```ts
describe("export_obj", () => {
  it("requires .obj", async () => {
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.fbx" });
    expect(r.isError).toBe(true);
  });

  it("exports", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)" });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.content[0].text).toContain("a.obj");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools` — Expected: FAIL (`exportObj` missing; `schema accepts target_tool Blender` fails with `expected false to be true`).

- [ ] **Step 7: Implement**

`src/tools/asset.ts:67` and `src/types.ts:233`: add `"Blender"` to the `target_tool` enum / union. Append to the `export_fbx` description: `target_tool "Blender" writes a JSON material sidecar for Reallusion's Blender add-on.`

`src/cc5-bridge.ts`:
```ts
  async exportObj(outputPath: string, yUp: boolean = true): Promise<OperationResult & { path?: string; signature?: string }> {
    return this.request("/pipeline/export_obj", "POST", { output_path: outputPath, y_up: yUp });
  }
```
mock: `exportObj: vi.fn(),`. In `registerPipelineTools`:
```ts
  server.tool(
    "export_obj",
    "Export the current character as OBJ (for sculpting in ZBrush or Blender). Bring the edited mesh back with replace_mesh_from_obj.",
    {
      output_path: z.string().describe("Absolute path ending in .obj"),
      y_up: z.boolean().default(true).describe("Y-up axis. Keep true for ZBrush, Maya and Blender (Blender's OBJ importer converts Y-up to Z-up); false only for a tool that expects Z-up OBJ"),
    },
    async ({ output_path, y_up }) => {
      const err = checkFile(output_path, [".obj"]);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.exportObj(output_path, y_up),
        (r) => r.success ? `Exported ${r.path}` : `Failed: ${r.error}`);
    }
  );
```

- [ ] **Step 8: Run** — `npm test && npm run test:py && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(dcc): Blender FBX preset with JSON sidecar, export_obj"
```

---

### Task 10: ZBrush GoZ export

**Files:**
- Modify: `cc5-plugin/cc5_pipeline.py`, `src/cc5-bridge.ts`, `tests/helpers/mock-bridge.ts`, `src/tools/pipeline.ts`
- Create: `tests/py/test_goz.py`; extend `tests/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: `try_signatures`, `check_path`.
- Produces (Python): `export_goz(output_dir: str, pose: str = "tpose") -> {"success", "folder", "files", "signature", "pose_applied", "notes"}` (`pose_applied` is False, with a WARNING in `notes`, when no pose setter exists on `RExportGoZMeshOption`) (`pose` ∈ `"current" | "tpose" | "apose"`; job action `export_goz`, LIVE-VERIFY).
- Produces (TS): MCP tool `export_goz` (runs via `runJob`).

- [ ] **Step 1: Failing Python test** — `tests/py/test_goz.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


class GoZTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()

    def test_rejects_unknown_pose(self):
        self.assertFalse(self.pipe.export_goz(self.dir, "sitting")["success"])

    def test_sets_pose_on_option_and_exports(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_goz(self.dir, "apose")
        self.assertTrue(r["success"])
        self.assertEqual(r["folder"], self.dir)
        self.assertTrue(self.rl.RFileIO.ExportGoZFile.called)
        self.rl.RExportGoZMeshOption.return_value.SetPose.assert_called_once_with(self.rl.EExportGoZPose_APose)
        self.assertTrue(r["pose_applied"])

    def test_reports_pose_not_applied_when_option_has_no_setter(self):
        self.rl.RExportGoZMeshOption.return_value = mock.MagicMock(spec=[])
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=mock.MagicMock()):
            r = self.pipe.export_goz(self.dir, "tpose")
        self.assertTrue(r["success"])
        self.assertFalse(r["pose_applied"])
        self.assertIn("NOT applied", r["notes"][0])
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** (above `ACTIONS`):
```python
GOZ_POSES = {"current": "EExportGoZPose_Current", "tpose": "EExportGoZPose_TPose", "apose": "EExportGoZPose_APose"}


def export_goz(output_dir: str, pose: str = "tpose") -> dict[str, Any]:
    """Write GoZ files for ZBrush (LIVE-VERIFY: RExportGoZMeshOption setter name)."""
    error = check_path(output_dir)
    if error:
        return {"success": False, "error": error}
    if pose not in GOZ_POSES:
        return {"success": False, "error": f"pose must be one of: {', '.join(GOZ_POSES)}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(output_dir, exist_ok=True)
    started = time.time() - 2  # mtime slack; report only files this export wrote
    option = RLPy.RExportGoZMeshOption()
    pose_enum = getattr(RLPy, GOZ_POSES[pose])
    pose_setter = next((s for s in ("SetPose", "SetExportPose", "SetGoZPose") if hasattr(option, s)), None)
    if pose_setter:
        getattr(option, pose_setter)(pose_enum)
    pose_applied = pose_setter is not None or pose == "current"
    label, err = try_signatures([
        ("([avatar], folder, option)", lambda: RLPy.RFileIO.ExportGoZFile([avatar], output_dir, option)),
        ("([avatar], folder, [option])", lambda: RLPy.RFileIO.ExportGoZFile([avatar], output_dir, [option])),
    ])
    if not label:
        return {"success": False, "error": f"ExportGoZFile failed: {err}"}
    notes = [] if pose_applied else [f"WARNING: pose '{pose}' NOT applied (no pose setter on RExportGoZMeshOption); files use the current pose"]
    return {"success": True, "folder": output_dir, "files": list_files(output_dir, since=started), "signature": label,
            "pose_applied": pose_applied, "notes": notes}
```
`ACTIONS`: `"export_goz": lambda p: export_goz(p["output_dir"], p.get("pose", "tpose")),` · `REQUIRED_PARAMS`: `"export_goz": ["output_dir"],` (job-only, no POST route).

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS test** — append to `tests/tools/pipeline.test.ts`:
```ts
describe("export_goz", () => {
  it("runs as a job and reports the folder", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_2" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_2", action: "export_goz", status: "done",
      result: { success: true, folder: "C:/GoZ/P1", files: [{ path: "C:/GoZ/P1/Body.GoZ", bytes: 10 }] } });
    const r = await server.getRegisteredTool("export_goz")({ output_dir: "C:/GoZ/P1", pose: "tpose" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_goz", { output_dir: "C:/GoZ/P1", pose: "tpose" });
    expect(r.content[0].text).toContain("C:/GoZ/P1");
  });

  it("warns when the pose was not applied", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_3" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_goz", status: "done",
      result: { success: true, folder: "C:/GoZ/P1", files: [], pose_applied: false } });
    const r = await server.getRegisteredTool("export_goz")({ output_dir: "C:/GoZ/P1", pose: "apose" });
    expect(r.content[0].text).toContain("WARNING");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/pipeline.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement** — in `src/tools/pipeline.ts` import `{ runJob, formatPending } from "../jobs.js"` and add:
```ts
  server.tool(
    "export_goz",
    "Export the current character as GoZ files for ZBrush (open them in ZBrush, sculpt, then export OBJ and use replace_mesh_from_obj to bring changes back).",
    {
      output_dir: z.string().describe("Absolute folder for the GoZ files"),
      pose: z.enum(["current", "tpose", "apose"]).default("tpose"),
    },
    async ({ output_dir, pose }) => {
      if (!isLocalAbsolute(output_dir)) return errorResult("output_dir must be a local absolute path without '..' (no network/UNC paths)");
      try {
        const out = await runJob(bridge, "export_goz", { output_dir, pose });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; folder?: string; files?: unknown[]; pose_applied?: boolean };
        if (out.failed || !r.success) return errorResult(`GoZ export failed: ${r.error ?? "unknown error"}`);
        const warn = r.pose_applied === false ? `\nWARNING: pose '${pose}' was NOT applied (no pose setter on RExportGoZMeshOption); files use the character's current pose.` : "";
        return { content: [{ type: "text" as const, text: `GoZ files written to ${r.folder} (${r.files?.length ?? 0} files)${warn}` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );
```

- [ ] **Step 8: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(dcc): export_goz for ZBrush"
```

---

### Task 11: Bring edits back — FBX import, mesh replacement from OBJ

**Files:**
- Modify: `cc5-plugin/cc5_pipeline.py`, `src/cc5-bridge.ts`, `src/types.ts`, `tests/helpers/mock-bridge.ts`, `src/tools/pipeline.ts`
- Create: `tests/py/test_imports.py`; extend `tests/tools/pipeline.test.ts`

**Interfaces:**
- Produces (Python):
  - `import_fbx(file_path: str, kind: str) -> {"success", "signature"}`, `kind` ∈ `"prop" | "character" | "clothing"`; prop/character → `RFileIO.LoadFbxFile` (LIVE-VERIFY with `EImportFbxOption_Prop` / `_StandardHumanCharacter`), clothing → `RFileIO.LoadClotheFromFbx(avatar, path, failed_list)` (LIVE-VERIFY: tries an `RLPy.WStringVector()` out-param first, then a plain list); job action `import_fbx`.
  - `replace_mesh_from_obj(mesh_name: str, obj_path: str) -> {"success"}` → `avatar.ReplaceMesh(mesh_name, obj_path, False, False)`; POST `/pipeline/replace_mesh`.
  - `list_meshes() -> {"success", "meshes": [str]}`; POST `/pipeline/meshes`.
- Produces (TS bridge): `replaceMeshFromObj(meshName, objPath)`, `listMeshes()`; tools `import_fbx` (job), `replace_mesh_from_obj`, `list_meshes`.

- [ ] **Step 1: Failing Python test** — `tests/py/test_imports.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.pipe = _support.fresh_import("cc5_pipeline")
        self.dir = tempfile.mkdtemp()
        self.avatar = mock.MagicMock()
        self.avatar.GetMeshNames.return_value = ["CC_Base_Body", "CC_Base_Eye"]

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_import_fbx_rejects_unknown_kind(self):
        self.assertFalse(self.pipe.import_fbx(self._file("a.fbx"), "vehicle")["success"])

    def test_import_clothing_uses_load_clothe(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.import_fbx(self._file("jacket.fbx"), "clothing")
        self.assertTrue(r["success"])
        self.assertTrue(self.rl.RFileIO.LoadClotheFromFbx.called)

    def test_import_prop_uses_load_fbx(self):
        r = self.pipe.import_fbx(self._file("stretcher.fbx"), "prop")
        self.assertTrue(r["success"])
        self.assertTrue(self.rl.RFileIO.LoadFbxFile.called)

    def test_replace_mesh_unknown_mesh(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.replace_mesh_from_obj("Nope", self._file("a.obj"))
        self.assertFalse(r["success"])
        self.assertIn("CC_Base_Body", r["error"])

    def test_replace_mesh_calls_avatar(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=self.avatar):
            r = self.pipe.replace_mesh_from_obj("CC_Base_Body", self._file("a.obj"))
        self.assertTrue(r["success"])
        self.avatar.ReplaceMesh.assert_called_once()
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** (above `ACTIONS`):
```python
FBX_KINDS = {"prop": "EImportFbxOption_Prop", "character": "EImportFbxOption_StandardHumanCharacter", "clothing": None}


def import_fbx(file_path: str, kind: str) -> dict[str, Any]:
    """Import an FBX from Blender/Maya/etc. as a prop, a character, or clothing for the current avatar."""
    if kind not in FBX_KINDS:
        return {"success": False, "error": f"kind must be one of: {', '.join(FBX_KINDS)}"}
    error = _check_existing(file_path, {".fbx"})
    if error:
        return {"success": False, "error": error}
    RLPy.RGlobal.BeginAction("Import FBX")
    try:
        if kind == "clothing":
            avatar = cc5_api.get_first_avatar()
            if not avatar:
                return {"success": False, "error": "No avatar in scene to dress"}
            failed: list[Any] = []
            label, err = try_signatures([
                ("LoadClotheFromFbx(avatar, path, WStringVector)", lambda: RLPy.RFileIO.LoadClotheFromFbx(avatar, file_path, RLPy.WStringVector())),
                ("LoadClotheFromFbx(avatar, path, list)", lambda: RLPy.RFileIO.LoadClotheFromFbx(avatar, file_path, failed)),
            ])
        else:
            option = getattr(RLPy, FBX_KINDS[kind])
            label, err = try_signatures([
                ("LoadFbxFile(path, option)", lambda: RLPy.RFileIO.LoadFbxFile(file_path, option)),
                ("LoadFbxFile(path)", lambda: RLPy.RFileIO.LoadFbxFile(file_path)),
            ])
    finally:
        RLPy.RGlobal.EndAction()
    if not label:
        return {"success": False, "error": f"FBX import failed: {err}"}
    cc5_api._invalidate_caches()
    return {"success": True, "signature": label}


def list_meshes() -> dict[str, Any]:
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    return {"success": True, "meshes": list(avatar.GetMeshNames(True) or [])}


def replace_mesh_from_obj(mesh_name: str, obj_path: str) -> dict[str, Any]:
    """Swap one avatar mesh for an edited OBJ with the same topology (sculpt round-trip)."""
    error = _check_existing(obj_path, {".obj"})
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    names = list(avatar.GetMeshNames(True) or [])
    if mesh_name not in names:
        return {"success": False, "error": f"Unknown mesh '{mesh_name}'. Meshes: {', '.join(names)}"}
    RLPy.RGlobal.BeginAction("Replace Mesh")
    try:
        avatar.ReplaceMesh(mesh_name, obj_path, False, False)
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "mesh": mesh_name}
```
`ACTIONS` add `import_fbx`, `list_meshes`, `replace_mesh_from_obj` (lambdas reading `p["file_path"], p["kind"]` / none / `p["mesh_name"], p["obj_path"]`). `POST_ROUTES` add `"/pipeline/meshes": "list_meshes", "/pipeline/replace_mesh": "replace_mesh_from_obj"`. `REQUIRED_PARAMS` add `"import_fbx": ["file_path", "kind"], "replace_mesh_from_obj": ["mesh_name", "obj_path"]`.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS tests** — append to `tests/tools/pipeline.test.ts`:
```ts
describe("import_fbx", () => {
  it("rejects non-FBX", async () => {
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/b.obj", kind: "prop" });
    expect(r.isError).toBe(true);
  });

  it("imports clothing as a job", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "import_fbx", status: "done", result: { success: true } });
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/jacket.fbx", kind: "clothing" });
    expect(r.content[0].text).toContain("jacket.fbx");
  });
});

describe("replace_mesh_from_obj", () => {
  it("passes mesh and path", async () => {
    bridge.replaceMeshFromObj.mockResolvedValue({ success: true });
    await server.getRegisteredTool("replace_mesh_from_obj")({ mesh_name: "CC_Base_Body", obj_path: "C:/s/body.obj" });
    expect(bridge.replaceMeshFromObj).toHaveBeenCalledWith("CC_Base_Body", "C:/s/body.obj");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/pipeline.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement**

`src/cc5-bridge.ts`:
```ts
  async listMeshes(): Promise<{ success: boolean; meshes?: string[]; error?: string }> {
    return this.request("/pipeline/meshes", "POST", {});
  }

  async replaceMeshFromObj(meshName: string, objPath: string): Promise<OperationResult> {
    return this.request("/pipeline/replace_mesh", "POST", { mesh_name: meshName, obj_path: objPath });
  }
```
mock: `listMeshes: vi.fn(), replaceMeshFromObj: vi.fn(),`. In `registerPipelineTools`:
```ts
  server.tool(
    "import_fbx",
    "Import an FBX made in Blender, Maya or another tool: as a 'prop', a whole 'character', or 'clothing' fitted to the current character.",
    {
      file_path: z.string().describe("Absolute path to the .fbx"),
      kind: z.enum(["prop", "character", "clothing"]),
    },
    async ({ file_path, kind }) => {
      const err = checkFile(file_path, [".fbx"]);
      if (err) return errorResult(err);
      try {
        const out = await runJob(bridge, "import_fbx", { file_path, kind });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string };
        if (out.failed || !r.success) return errorResult(`Import failed: ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text" as const, text: `Imported ${path.basename(file_path)} as ${kind}` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "list_meshes",
    "List the current character's mesh names (needed for replace_mesh_from_obj and load_texture).",
    {},
    async () => bridgeCall(() => bridge.listMeshes(),
      (r) => r.success ? (r.meshes ?? []).join("\n") : `Failed: ${r.error}`)
  );

  server.tool(
    "replace_mesh_from_obj",
    "Replace one of the character's meshes with an edited OBJ (same topology, e.g. a ZBrush or Blender sculpt of CC_Base_Body).",
    {
      mesh_name: z.string().min(1).max(256).describe("Mesh to replace, from list_meshes"),
      obj_path: z.string().describe("Absolute path to the edited .obj"),
    },
    async ({ mesh_name, obj_path }) => {
      const err = checkFile(obj_path, [".obj"]);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.replaceMeshFromObj(mesh_name, obj_path),
        (r) => r.success ? `Replaced ${mesh_name} with ${path.basename(obj_path)}` : `Failed: ${r.error}`);
    }
  );
```

- [ ] **Step 8: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(dcc): import_fbx, list_meshes, replace_mesh_from_obj"
```

---

### Task 12: Textures — per-channel load, Substance Painter import, texture export

**Files:**
- Modify: `cc5-plugin/cc5_pipeline.py`, `src/cc5-bridge.ts`, `tests/helpers/mock-bridge.ts`, `src/tools/pipeline.ts`
- Create: `tests/py/test_textures.py`; extend `tests/tools/pipeline.test.ts`

**Interfaces:**
- Produces (Python):
  - `TEXTURE_CHANNELS: dict[str, str]` — `diffuse, normal, roughness, metallic, ao, opacity, displacement, specular, glow, bump, diffuse_blend` → `EMaterialTextureChannel_*`.
  - `load_texture(mesh_name, material_name, channel, image_path) -> {"success"}` → `mat_comp.LoadImageToTexture(...)`; POST `/pipeline/load_texture`.
  - `load_substance_textures(folder: str) -> {"success", "signature"}` → `RFileIO.LoadSubstancePainterTextures(avatar, folder)`; POST `/pipeline/substance_import`.
  - `export_textures(output_dir: str, character_name: str) -> {"success", "folder", "files"}` → `cc5_api.export_fbx` with `target_tool=""`, `embed_textures=False`, `convert_image_format=True` into `<output_dir>/<name>/<name>.fbx` (gives Substance Painter a mesh + PBR texture set); job action `export_textures`.
- Produces (TS): tools `load_texture`, `load_substance_textures`, `export_textures` (job).

- [ ] **Step 1: Failing Python test** — `tests/py/test_textures.py`:
```python
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
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** (above `ACTIONS`):
```python
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


def load_texture(mesh_name: str, material_name: str, channel: str, image_path: str) -> dict[str, Any]:
    if channel not in TEXTURE_CHANNELS:
        return {"success": False, "error": f"channel must be one of: {', '.join(TEXTURE_CHANNELS)}"}
    error = _check_existing(image_path, IMAGE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    mat_comp, error = resolve_material(avatar, mesh_name, material_name)
    if error:
        return {"success": False, "error": error}
    RLPy.RGlobal.BeginAction("Load Texture")
    try:
        mat_comp.LoadImageToTexture(mesh_name, material_name, getattr(RLPy, TEXTURE_CHANNELS[channel]), image_path)
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True}


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
            ("(avatar, folder)", lambda: RLPy.RFileIO.LoadSubstancePainterTextures(avatar, folder)),
        ])
        if label:
            RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    finally:
        RLPy.RGlobal.EndAction()
    if not label:
        return {"success": False, "error": f"Substance import failed: {err}"}
    return {"success": True, "signature": label}


def export_textures(output_dir: str, character_name: str) -> dict[str, Any]:
    """Export FBX + PBR textures as image files: the starting set for Substance Painter."""
    error = check_path(output_dir)
    if error:
        return {"success": False, "error": error}
    if not SAFE_NAME.match(character_name or ""):
        return {"success": False, "error": "Character name must be 1-64 letters, digits, '_' or '-'"}
    folder = os.path.join(output_dir, character_name)
    os.makedirs(folder, exist_ok=True)
    fbx = os.path.join(folder, character_name + ".fbx")
    started = time.time() - 2  # mtime slack; report only files this export wrote
    result = cc5_api.export_fbx(fbx, 0, target_tool="", embed_textures=False, export_motion=False, convert_image_format=True)
    if not result.get("success"):
        return result
    return {"success": True, "folder": folder, "files": list_files(folder, since=started)}
```
`ACTIONS` add `load_texture`, `load_substance_textures`, `export_textures`. `POST_ROUTES` add `"/pipeline/load_texture": "load_texture", "/pipeline/substance_import": "load_substance_textures"`. `REQUIRED_PARAMS` add `"load_texture": ["mesh_name", "material_name", "channel", "image_path"], "load_substance_textures": ["folder"], "export_textures": ["output_dir", "character_name"]`.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS tests** — append to `tests/tools/pipeline.test.ts`:
```ts
describe("load_texture", () => {
  it("rejects non-image files", async () => {
    const r = await server.getRegisteredTool("load_texture")({ mesh_name: "m", material_name: "x", channel: "diffuse", image_path: "C:/a/b.exe" });
    expect(r.isError).toBe(true);
  });

  it("loads into the channel", async () => {
    bridge.loadTexture.mockResolvedValue({ success: true });
    await server.getRegisteredTool("load_texture")({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Body", channel: "normal", image_path: "C:/t/n.png" });
    expect(bridge.loadTexture).toHaveBeenCalledWith("CC_Base_Body", "Std_Skin_Body", "normal", "C:/t/n.png");
  });
});

describe("load_substance_textures", () => {
  it("calls the bridge", async () => {
    bridge.loadSubstanceTextures.mockResolvedValue({ success: true });
    const r = await server.getRegisteredTool("load_substance_textures")({ folder: "C:/SP/export" });
    expect(r.isError).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/pipeline.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement**

`src/cc5-bridge.ts`:
```ts
  async loadTexture(meshName: string, materialName: string, channel: string, imagePath: string): Promise<OperationResult> {
    return this.request("/pipeline/load_texture", "POST",
      { mesh_name: meshName, material_name: materialName, channel, image_path: imagePath });
  }

  async loadSubstanceTextures(folder: string): Promise<OperationResult> {
    return this.request("/pipeline/substance_import", "POST", { folder });
  }
```
mock: `loadTexture: vi.fn(), loadSubstanceTextures: vi.fn(),`. In `src/tools/pipeline.ts`:
```ts
export const TEXTURE_CHANNELS = ["diffuse", "normal", "roughness", "metallic", "ao", "opacity",
  "displacement", "specular", "glow", "bump", "diffuse_blend"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff"];
```
and register:
```ts
  server.tool(
    "load_texture",
    "Load an image into one texture channel of one material (e.g. a new iris, a normal map from Substance or ZBrush). Use get_material_info for mesh/material names.",
    {
      mesh_name: z.string().min(1).max(256),
      material_name: z.string().min(1).max(256),
      channel: z.enum(TEXTURE_CHANNELS),
      image_path: z.string().describe("Absolute path to the image"),
    },
    async ({ mesh_name, material_name, channel, image_path }) => {
      const err = checkFile(image_path, IMAGE_EXTENSIONS);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.loadTexture(mesh_name, material_name, channel, image_path),
        (r) => r.success ? `Loaded ${path.basename(image_path)} into ${material_name} (${channel})` : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "load_substance_textures",
    "Apply a Substance Painter texture export folder to the current character (CC5's built-in Substance import).",
    { folder: z.string().describe("Absolute path of the Substance Painter export folder") },
    async ({ folder }) => {
      if (!isLocalAbsolute(folder)) return errorResult("folder must be a local absolute path without '..' (no network/UNC paths)");
      return bridgeCall(() => bridge.loadSubstanceTextures(folder),
        (r) => r.success ? `Applied Substance textures from ${folder}` : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "export_textures",
    "Export the character as FBX plus PBR texture images into <output_dir>/<character_name>/ — the starting point for texturing in Substance Painter.",
    {
      output_dir: z.string().describe("Absolute folder"),
      character_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    },
    async ({ output_dir, character_name }) => {
      if (!isLocalAbsolute(output_dir)) return errorResult("output_dir must be a local absolute path without '..' (no network/UNC paths)");
      try {
        const out = await runJob(bridge, "export_textures", { output_dir, character_name });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; folder?: string; files?: unknown[] };
        if (out.failed || !r.success) return errorResult(`Texture export failed: ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text" as const, text: `Exported mesh and ${r.files?.length ?? 0} files to ${r.folder}` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );
```

- [ ] **Step 8: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(dcc): load_texture, Substance Painter import, export_textures"
```

---

## Phase 4 — Skin and injury states

### Task 13: Skin overlays, skin condition, wrinkle strength, makeup/skin content folders

**Files:**
- Create: `cc5-plugin/cc5_skin.py`, `tests/py/test_skin.py`, `src/tools/skin.ts`, `tests/tools/skin.test.ts`
- Modify: `cc5-plugin/server.py` (`EXTENSION_MODULES` add `"cc5_skin"`), `cc5-plugin/cc5_api.py` (`browse_content` `enum_candidates` and its file-extension filter), `src/tools/content.ts` (`browse_content` folder enum), `src/cc5-bridge.ts`, `tests/helpers/mock-bridge.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `cc5_pipeline.check_path`, `cc5_pipeline._check_existing`, `cc5_pipeline.IMAGE_EXTENSIONS`, `cc5_api._EOMTYPE_MATERIAL`.
- Produces (Python, `cc5_skin`):
  - `skin_targets(avatar, region: str) -> list[tuple[str, str]]` — `(mesh, material)` whose material name contains `skin` (not `eyelash`); `region` ∈ `"all" | "head" | "body" | "arms" | "legs"` filters on `Head`/`Body`/`Arm`/`Leg` in the material name.
  - `apply_skin_overlay(image_path, region="all", strength=100.0) -> {"success", "applied_to"}` — loads the image into `EMaterialTextureChannel_DiffuseBlend` and sets its weight with `AddTextureWeightKey(key, mesh, mat, channel, strength / 100.0)` (LIVE-VERIFY weight scale: CC's UI shows 0-100; if the key needs 0-100, drop the division). POST `/skin/overlay`.
  - `remove_skin_overlay(region="all") -> {"success", "removed_from"}` → `RemoveMaterialTexture(mesh, mat, DiffuseBlend)`. POST `/skin/overlay/remove`.
  - `SKIN_CONDITIONS = {"normal": (1.0, 1.0, 1.0), "pale": (0.93, 0.90, 0.88), "cyanotic": (0.80, 0.86, 0.98), "flushed": (1.0, 0.82, 0.80), "jaundiced": (1.0, 0.95, 0.70)}`; `set_skin_condition(condition, amount=1.0, region="all", base_rgb=None)` — writes diffuse `base_rgb * lerp((1,1,1), SKIN_CONDITIONS[c], amount)` per channel (`base_rgb` defaults to white, must be three values 0-1) via `AddDiffuseKey`. This is the same key `cc5_api.set_skin_color` writes, so the result replaces the skin colour; pass the skin tone as `base_rgb` to tint it instead of losing it (`normal` + `base_rgb` restores the tone). POST `/skin/condition` (optional body field `base_rgb`).
  - `set_wrinkle_strength(strength: float) -> {"success", "parts"}` → `SetWrinkleDetailStrength(part, strength)` for every `RLPy.EWrinkleFacePart_*` value except `_None`; returns `success: False` (no `UpdateWrinkle` call) when the build exposes no `EWrinkleFacePart_*` values. POST `/skin/wrinkle`.
- Produces (TS bridge): `applySkinOverlay(imagePath, region, strength)`, `removeSkinOverlay(region)`, `setSkinCondition(condition, amount, region, baseRgb?: [number, number, number])`, `setWrinkleStrength(strength)`; tools of the same snake_case names in `src/tools/skin.ts` (`registerSkinTools`), `SKIN_REGIONS`, `SKIN_CONDITIONS` exported.
- Produces: `browse_content` folder types `makeup_full`, `makeup_foundation`, `makeup_eye`, `makeup_lip`, `image_layer`, `skingen`, `wrinkle_mask`, `texture`. For `image_layer`, `texture` and `wrinkle_mask` it also returns image files (`.png .jpg .jpeg .tga .bmp .tif .tiff`). Every other folder keeps its existing filter (`.cc*`/`.i*` content, plus `.rl*` files for `pose`/`motion` from Task 8).

- [ ] **Step 1: Failing Python test** — `tests/py/test_skin.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


def _avatar():
    a = mock.MagicMock()
    a.GetMeshNames.return_value = ["CC_Base_Body", "CC_Base_Eye"]
    mats = {"CC_Base_Body": ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg", "Std_Eyelash"],
            "CC_Base_Eye": ["Std_Eye_R"]}
    a.GetMaterialComponent.return_value.GetMaterialNames.side_effect = lambda m: mats[m]
    return a


class SkinTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.skin = _support.fresh_import("cc5_skin")
        self.avatar = _avatar()
        self.png = os.path.join(tempfile.mkdtemp(), "bruise.png")
        open(self.png, "wb").close()
        p = mock.patch.object(self.skin.cc5_api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)

    def test_targets_skip_eyelash_and_filter_region(self):
        self.assertEqual(len(self.skin.skin_targets(self.avatar, "all")), 4)
        self.assertEqual(self.skin.skin_targets(self.avatar, "arms"), [("CC_Base_Body", "Std_Skin_Arm")])

    def test_overlay_loads_diffuse_blend_and_weight(self):
        r = self.skin.apply_skin_overlay(self.png, "head", 60)
        self.assertTrue(r["success"])
        mc = self.avatar.GetMaterialComponent.return_value
        mc.LoadImageToTexture.assert_called_once_with(
            "CC_Base_Body", "Std_Skin_Head", self.rl.EMaterialTextureChannel_DiffuseBlend, self.png)
        self.assertAlmostEqual(mc.AddTextureWeightKey.call_args.args[4], 0.6)

    def test_overlay_rejects_bad_strength(self):
        self.assertFalse(self.skin.apply_skin_overlay(self.png, "all", 150)["success"])

    def test_condition_tint(self):
        r = self.skin.set_skin_condition("pale", 0.5, "all")
        self.assertTrue(r["success"])
        self.rl.RRgb.assert_called_with(0.965, 0.95, 0.94)

    def test_condition_tints_base_skin_tone(self):
        r = self.skin.set_skin_condition("pale", 0.7, "all", (0.4, 0.3, 0.25))
        self.assertTrue(r["success"])
        self.rl.RRgb.assert_called_with(0.3804, 0.279, 0.229)
        self.assertEqual(self.skin.ACTIONS["set_skin_condition"]({"condition": "normal", "base_rgb": [0.4, 0.3, 0.25]})["rgb"], [0.4, 0.3, 0.25])
        self.assertFalse(self.skin.set_skin_condition("pale", 1.0, "all", [0.1, 0.2])["success"])

    def test_unknown_condition(self):
        self.assertFalse(self.skin.set_skin_condition("glowing", 1.0, "all")["success"])

    def test_browse_image_folders_keep_images(self):
        self.rl.RApplication.GetContentFilesInFolder.return_value = ["C:/l/Bruise.PNG", "C:/l/notes.txt", "C:/l/x.ccShoes"]
        self.assertEqual(self.skin.cc5_api.browse_content("image_layer"), ["C:/l/Bruise.PNG", "C:/l/x.ccShoes"])
        self.assertEqual(self.skin.cc5_api.browse_content("shoes"), ["C:/l/x.ccShoes"])

    def test_wrinkle_sets_every_face_part_and_clamps(self):
        self.rl.EWrinkleFacePart_Blink = "blink"
        self.rl.EWrinkleFacePart_Neck = "neck"
        r = self.skin.set_wrinkle_strength(1.7)
        self.assertTrue(r["success"])
        self.assertEqual(sorted(r["parts"]), ["EWrinkleFacePart_Blink", "EWrinkleFacePart_Neck"])
        mc = self.avatar.GetMaterialComponent.return_value
        self.assertEqual(sorted(c.args for c in mc.SetWrinkleDetailStrength.call_args_list),
                         [("blink", 1.0), ("neck", 1.0)])
        self.avatar.UpdateWrinkle.assert_called_once_with()

    def test_wrinkle_without_wrinkle_api_is_a_failure(self):
        r = self.skin.set_wrinkle_strength(0.5)
        self.assertFalse(r["success"])
        self.assertIn("EWrinkleFacePart", r["error"])
        self.avatar.UpdateWrinkle.assert_not_called()


class MakeupBrowseTest(unittest.TestCase):
    FOLDERS = {
        "makeup_full": "EContentRootFolder_FullMakeup",
        "makeup_foundation": "EContentRootFolder_FoundationMakeup",
        "makeup_eye": "EContentRootFolder_EyeMakeup",
        "makeup_lip": "EContentRootFolder_LipMakeup",
        "image_layer": "EContentRootFolder_ImageLayer",
        "skingen": "EContentRootFolder_SkinGenTools",
        "wrinkle_mask": "EContentRootFolder_WrinkleMasks",
        "texture": "EContentRootFolder_Texture",
    }

    def test_new_folder_types_resolve_and_list(self):
        rl = _support.install_fake_rlpy()
        api = _support.fresh_import("cc5_api")
        app = rl.RApplication
        app.GetDefaultContentFolder.return_value = "$/Content"
        app.GetCustomContentFolder.return_value = None
        app.GetContentFilesInFolder.return_value = ["$/Content/item.ccTemplate"]
        for key, enum_name in self.FOLDERS.items():
            with self.subTest(folder_type=key):
                app.GetDefaultContentFolder.reset_mock()
                self.assertEqual(api.browse_content(key), ["$/Content/item.ccTemplate"])
                app.GetDefaultContentFolder.assert_called_once_with(getattr(rl, enum_name))
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL (`No module named 'cc5_skin'`).

- [ ] **Step 3: Implement** — `cc5-plugin/cc5_skin.py`:
```python
"""
Skin and injury-state helpers: image overlays (bruising, dirt, blood), skin
condition tints (pallor, cyanosis), and wrinkle strength.
"""

from __future__ import annotations

from typing import Any

import RLPy

import cc5_api
from cc5_pipeline import IMAGE_EXTENSIONS, _check_existing

REGION_KEYS = {"head": "head", "body": "body", "arms": "arm", "legs": "leg"}
SKIN_CONDITIONS: dict[str, tuple[float, float, float]] = {
    "normal": (1.0, 1.0, 1.0),
    "pale": (0.93, 0.90, 0.88),
    "cyanotic": (0.80, 0.86, 0.98),
    "flushed": (1.0, 0.82, 0.80),
    "jaundiced": (1.0, 0.95, 0.70),
}


def skin_targets(avatar, region: str) -> list[tuple[str, str]]:
    mat_comp = avatar.GetMaterialComponent()
    out: list[tuple[str, str]] = []
    for mesh in avatar.GetMeshNames(True) or []:
        for mat in mat_comp.GetMaterialNames(mesh) or []:
            low = mat.lower()
            if "skin" not in low or "eyelash" in low:
                continue
            if region != "all" and REGION_KEYS[region] not in low:
                continue
            out.append((mesh, mat))
    return out


def _prepare(region: str) -> tuple[Any, list[tuple[str, str]], str | None]:
    if region != "all" and region not in REGION_KEYS:
        return None, [], f"region must be one of: all, {', '.join(REGION_KEYS)}"
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return None, [], "No avatar in scene"
    targets = skin_targets(avatar, region)
    if not targets:
        return None, [], f"No skin materials found for region '{region}'"
    return avatar, targets, None


def _now_key():
    key = RLPy.RKey()
    key.SetTime(RLPy.RGlobal.GetTime())
    return key


def apply_skin_overlay(image_path: str, region: str = "all", strength: float = 100.0) -> dict[str, Any]:
    """Blend an image (bruise, dirt, blood) over skin via the Diffuse Blend channel."""
    if not 0.0 <= float(strength) <= 100.0:
        return {"success": False, "error": "strength must be 0-100"}
    error = _check_existing(image_path, IMAGE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    mat_comp = avatar.GetMaterialComponent()
    channel = RLPy.EMaterialTextureChannel_DiffuseBlend
    applied: list[str] = []
    RLPy.RGlobal.BeginAction("Apply Skin Overlay")
    try:
        for mesh, mat in targets:
            mat_comp.LoadImageToTexture(mesh, mat, channel, image_path)
            mat_comp.AddTextureWeightKey(_now_key(), mesh, mat, channel, float(strength) / 100.0)
            applied.append(mat)
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    except Exception as e:
        return {"success": False, "error": str(e), "applied_to": applied}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "applied_to": applied}


def remove_skin_overlay(region: str = "all") -> dict[str, Any]:
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    mat_comp = avatar.GetMaterialComponent()
    removed: list[str] = []
    RLPy.RGlobal.BeginAction("Remove Skin Overlay")
    try:
        for mesh, mat in targets:
            mat_comp.RemoveMaterialTexture(mesh, mat, RLPy.EMaterialTextureChannel_DiffuseBlend)
            removed.append(mat)
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "removed_from": removed}


def set_skin_condition(condition: str, amount: float = 1.0, region: str = "all",
                       base_rgb: Any = None) -> dict[str, Any]:
    """Tint skin toward a clinical appearance (pale = shock, cyanotic = hypoxia).

    Writes the same diffuse key as cc5_api.set_skin_color, so it replaces the skin
    colour. Pass that colour as base_rgb to tint it instead of losing it.
    """
    if condition not in SKIN_CONDITIONS:
        return {"success": False, "error": f"condition must be one of: {', '.join(SKIN_CONDITIONS)}"}
    base = (1.0, 1.0, 1.0) if base_rgb is None else tuple(float(c) for c in base_rgb)
    if len(base) != 3 or not all(0.0 <= c <= 1.0 for c in base):
        return {"success": False, "error": "base_rgb must be three values 0-1"}
    amount = max(0.0, min(1.0, float(amount)))
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    tr, tg, tb = SKIN_CONDITIONS[condition]
    rgb = tuple(round(b * (1.0 + (t - 1.0) * amount), 4) for b, t in zip(base, (tr, tg, tb)))
    color = RLPy.RRgb(*rgb)
    mat_comp = avatar.GetMaterialComponent()
    RLPy.RGlobal.BeginAction("Set Skin Condition")
    try:
        for mesh, mat in targets:
            mat_comp.AddDiffuseKey(_now_key(), mesh, mat, color)
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "condition": condition, "rgb": list(rgb), "applied_to": [m for _, m in targets]}


def set_wrinkle_strength(strength: float) -> dict[str, Any]:
    strength = max(0.0, min(1.0, float(strength)))
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    parts = [n for n in dir(RLPy) if n.startswith("EWrinkleFacePart_") and not n.endswith("_None")]
    if not parts:
        return {"success": False, "error": "Wrinkle API (RLPy.EWrinkleFacePart_*) not available in this CC5 build"}
    mat_comp = avatar.GetMaterialComponent()
    RLPy.RGlobal.BeginAction("Set Wrinkle Strength")
    try:
        for name in parts:
            mat_comp.SetWrinkleDetailStrength(getattr(RLPy, name), strength)
        avatar.UpdateWrinkle()
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "parts": parts}


ACTIONS: dict[str, Any] = {
    "apply_skin_overlay": lambda p: apply_skin_overlay(p["image_path"], p.get("region", "all"), float(p.get("strength", 100))),
    "remove_skin_overlay": lambda p: remove_skin_overlay(p.get("region", "all")),
    "set_skin_condition": lambda p: set_skin_condition(p["condition"], float(p.get("amount", 1.0)), p.get("region", "all"), p.get("base_rgb")),
    "set_wrinkle_strength": lambda p: set_wrinkle_strength(float(p["strength"])),
}
POST_ROUTES: dict[str, str] = {
    "/skin/overlay": "apply_skin_overlay",
    "/skin/overlay/remove": "remove_skin_overlay",
    "/skin/condition": "set_skin_condition",
    "/skin/wrinkle": "set_wrinkle_strength",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "apply_skin_overlay": ["image_path"],
    "set_skin_condition": ["condition"],
    "set_wrinkle_strength": ["strength"],
}
```
`server.py`: `EXTENSION_MODULES: list[str] = ["cc5_pipeline", "cc5_skin"]`.

In `cc5_api.browse_content` add to `enum_candidates`:
```python
        "makeup_full": "EContentRootFolder_FullMakeup",
        "makeup_foundation": "EContentRootFolder_FoundationMakeup",
        "makeup_eye": "EContentRootFolder_EyeMakeup",
        "makeup_lip": "EContentRootFolder_LipMakeup",
        "image_layer": "EContentRootFolder_ImageLayer",
        "skingen": "EContentRootFolder_SkinGenTools",
        "wrinkle_mask": "EContentRootFolder_WrinkleMasks",
        "texture": "EContentRootFolder_Texture",
```
and add the same eight keys to the `folder_type` enum in `src/tools/content.ts`.

In the same `browse_content` function, change the file filter so the image-library folders return their image files. As Task 8 left it, the filter keeps only `.cc*`/`.i*` (plus `.rl*` for `pose`/`motion`), so `image_layer`, `texture` and `wrinkle_mask` would always come back empty. Replace:
```python
                if (ext.startswith((".cc", ".i")) or (folder_type in ("pose", "motion") and ext.startswith(".rl"))) and f not in seen:
```
with:
```python
                is_image = folder_type in ("image_layer", "texture", "wrinkle_mask") and ext in (".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff")
                if (ext.startswith((".cc", ".i")) or (folder_type in ("pose", "motion") and ext.startswith(".rl")) or is_image) and f not in seen:
```
Use a literal tuple, not `cc5_pipeline.IMAGE_EXTENSIONS`, because `cc5_pipeline` imports `cc5_api`. All other folder types behave exactly as before.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS test** — `tests/tools/skin.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerSkinTools } from "../../src/tools/skin.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSkinTools(server as any, bridge as any);
});

describe("apply_skin_overlay", () => {
  it("rejects non-image files without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/a/b.txt", region: "all", strength: 50 });
    expect(r.isError).toBe(true);
    expect(bridge.applySkinOverlay).not.toHaveBeenCalled();
  });

  it("applies and lists materials", async () => {
    bridge.applySkinOverlay.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head"] });
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "head", strength: 70 });
    expect(bridge.applySkinOverlay).toHaveBeenCalledWith("C:/o/bruise.png", "head", 70);
    expect(r.content[0].text).toContain("Std_Skin_Head");
  });
});

describe("set_skin_condition", () => {
  it("passes condition and amount", async () => {
    bridge.setSkinCondition.mockResolvedValue({ success: true, applied_to: [] });
    await server.getRegisteredTool("set_skin_condition")({ condition: "pale", amount: 0.8, region: "all" });
    expect(bridge.setSkinCondition).toHaveBeenCalledWith("pale", 0.8, "all", undefined);
  });
});

describe("set_wrinkle_strength", () => {
  it("passes strength to the bridge", async () => {
    bridge.setWrinkleStrength.mockResolvedValue({ success: true, parts: ["EWrinkleFacePart_Blink"] });
    const r = await server.getRegisteredTool("set_wrinkle_strength")({ strength: 0.4 });
    expect(bridge.setWrinkleStrength).toHaveBeenCalledWith(0.4);
    expect(r.content[0].text).toContain("Wrinkle strength set to 0.4");
  });

  it("reports a missing wrinkle API as an error", async () => {
    bridge.setWrinkleStrength.mockResolvedValue({ success: false, error: "Wrinkle API (RLPy.EWrinkleFacePart_*) not available in this CC5 build" });
    const r = await server.getRegisteredTool("set_wrinkle_strength")({ strength: 0.4 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("EWrinkleFacePart");
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/skin.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement**

`src/cc5-bridge.ts`:
```ts
  async applySkinOverlay(imagePath: string, region: string, strength: number): Promise<OperationResult & { applied_to?: string[] }> {
    return this.request("/skin/overlay", "POST", { image_path: imagePath, region, strength });
  }

  async removeSkinOverlay(region: string): Promise<OperationResult & { removed_from?: string[] }> {
    return this.request("/skin/overlay/remove", "POST", { region });
  }

  async setSkinCondition(condition: string, amount: number, region: string, baseRgb?: [number, number, number]): Promise<OperationResult & { applied_to?: string[] }> {
    return this.request("/skin/condition", "POST", { condition, amount, region, base_rgb: baseRgb });
  }

  async setWrinkleStrength(strength: number): Promise<OperationResult> {
    return this.request("/skin/wrinkle", "POST", { strength });
  }
```
mock: `applySkinOverlay: vi.fn(), removeSkinOverlay: vi.fn(), setSkinCondition: vi.fn(), setWrinkleStrength: vi.fn(),`.

`src/tools/skin.ts`:
```ts
/**
 * Skin and injury-state tools: overlays (bruises, dirt, blood), clinical skin
 * condition tints, and wrinkle strength.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult } from "../util.js";
import { checkFile, IMAGE_EXTENSIONS } from "./pipeline.js";

export const SKIN_REGIONS = ["all", "head", "body", "arms", "legs"] as const;
export const SKIN_CONDITIONS = ["normal", "pale", "cyanotic", "flushed", "jaundiced"] as const;

export function registerSkinTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "apply_skin_overlay",
    "Blend an image over the character's skin (bruising, abrasions, dirt, dried blood). The image should be laid out on the CC skin UVs (author it in Substance Painter or Photoshop, or browse_content('image_layer')). Strength 0-100.",
    {
      image_path: z.string().describe("Absolute path to a PNG/JPG/TGA overlay"),
      region: z.enum(SKIN_REGIONS).default("all"),
      strength: z.number().min(0).max(100).default(100),
    },
    async ({ image_path, region, strength }) => {
      const err = checkFile(image_path, IMAGE_EXTENSIONS);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.applySkinOverlay(image_path, region, strength),
        (r) => r.success ? `Applied ${path.basename(image_path)} at ${strength}% to: ${(r.applied_to ?? []).join(", ")}` : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "remove_skin_overlay",
    "Remove skin overlays previously added with apply_skin_overlay.",
    { region: z.enum(SKIN_REGIONS).default("all") },
    async ({ region }) => bridgeCall(() => bridge.removeSkinOverlay(region),
      (r) => r.success ? `Removed overlays from: ${(r.removed_from ?? []).join(", ")}` : `Failed: ${r.error}`)
  );

  server.tool(
    "set_skin_condition",
    "Tint the skin toward a clinical appearance: pale (shock/blood loss), cyanotic (hypoxia), flushed, jaundiced, or back to normal. amount 0-1. This replaces the colour set by set_skin_color; pass that colour as base_rgb to tint it instead (normal + base_rgb restores it).",
    {
      condition: z.enum(SKIN_CONDITIONS),
      amount: z.number().min(0).max(1).default(1),
      region: z.enum(SKIN_REGIONS).default("all"),
      base_rgb: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional()
        .describe("Skin tone to tint (the RGB given to set_skin_color); defaults to white"),
    },
    async ({ condition, amount, region, base_rgb }) => bridgeCall(() => bridge.setSkinCondition(condition, amount, region, base_rgb),
      (r) => r.success ? `Skin set to ${condition} (${Math.round(amount * 100)}%) on: ${(r.applied_to ?? []).join(", ")}` : `Failed: ${r.error}`)
  );

  server.tool(
    "set_wrinkle_strength",
    "Set facial wrinkle detail strength (0 = smooth, 1 = full). Useful for aging a patient.",
    { strength: z.number().min(0).max(1) },
    async ({ strength }) => bridgeCall(() => bridge.setWrinkleStrength(strength),
      (r) => r.success ? `Wrinkle strength set to ${strength}` : `Failed: ${r.error}`)
  );
}
```
`src/index.ts`: register `registerSkinTools`.

- [ ] **Step 8: Run** — `npm test && npm run test:py && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(skin): overlays, clinical skin conditions, wrinkle strength, makeup/skin content folders"
```

---

## Phase 5 — Prompt to fully built character

### Task 14: Headshot from photo, facial profile, content search

**Files:**
- Create: `cc5-plugin/cc5_builder.py`, `tests/py/test_builder.py`, `src/tools/builder.ts`, `tests/tools/builder.test.ts`
- Modify: `cc5-plugin/server.py` (`EXTENSION_MODULES` add `"cc5_builder"`), `src/cc5-bridge.ts`, `tests/helpers/mock-bridge.ts`, `src/index.ts`

**Interfaces:**
- Produces (Python, `cc5_builder`):
  - `headshot_from_photo(photo_path: str) -> {"success", "mode"}` — `RLPy.RHeadshot.CreateHeadFromPhoto(photo_path, mode, RLPy.RHeadshotOption())`, `mode` = `RLPy.EHSMode_Pro` if present, else the first `EHSMode_*` attribute (the `RO::EHSMode` enum: `EHSMode_Pro` / `EHSMode_Auto`, per `docs/rlpy-api-reference.md`; requires a Headshot 3 licence — the error says so). Job action `headshot_from_photo`.
  - `load_facial_profile(file_path: str) -> {"success"}` — `avatar.GetFacialProfileComponent().LoadProfile(path)`; any `.cc*`/`.i*` extension, file must exist. POST `/builder/facial_profile`.
- Produces (TS): `searchContent(bridge, query: string, folderTypes: string[]): Promise<Array<{ folder: string; path: string }>>` exported from `src/tools/builder.ts` — calls `bridge.browseContent` per folder and keeps files whose basename contains every query word (case-insensitive); `SEARCH_FOLDERS` default list; tools `search_content`, `headshot_from_photo` (job, 120 s wait), `load_facial_profile`.

- [ ] **Step 1: Failing Python test** — `tests/py/test_builder.py`:
```python
import os
import tempfile
import unittest
from unittest import mock

import _support


class BuilderTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.b = _support.fresh_import("cc5_builder")
        self.dir = tempfile.mkdtemp()

    def _file(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_headshot_rejects_non_image(self):
        self.assertFalse(self.b.headshot_from_photo(self._file("a.txt"))["success"])

    def test_headshot_picks_pro_mode(self):
        with mock.patch.object(self.b, "_headshot_modes", return_value=["EHSMode_Auto", "EHSMode_Pro"]):
            r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertTrue(r["success"])
        self.assertEqual(r["mode"], "EHSMode_Pro")

    def test_headshot_licence_message(self):
        self.rl.RHeadshot.CreateHeadFromPhoto.side_effect = RuntimeError("no licence")
        with mock.patch.object(self.b, "_headshot_modes", return_value=["EHSMode_Pro"]):
            r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertFalse(r["success"])
        self.assertIn("Headshot", r["error"])

    def test_headshot_finds_rlpy_mode_enum(self):
        # Unpatched: real RLPy exposes the mode enum as EHSMode_Pro / EHSMode_Auto.
        self.rl.EHSMode_Auto = 1
        self.rl.EHSMode_Pro = 0
        r = self.b.headshot_from_photo(self._file("face.jpg"))
        self.assertTrue(r["success"])
        self.assertEqual(r["mode"], "EHSMode_Pro")
        self.assertEqual(self.rl.RHeadshot.CreateHeadFromPhoto.call_args[0][1], 0)

    def test_facial_profile_loads(self):
        avatar = mock.MagicMock()
        with mock.patch.object(self.b.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.b.load_facial_profile(self._file("ext.ccFacialProfile"))
        self.assertTrue(r["success"])
        avatar.GetFacialProfileComponent.return_value.LoadProfile.assert_called_once()
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** — `cc5-plugin/cc5_builder.py`:
```python
"""
Character-building helpers that go beyond morphs: Headshot photo-to-head and
facial profiles. Content search lives on the TypeScript side (browse_content).
"""

from __future__ import annotations

import os
from typing import Any

import RLPy

import cc5_api
from cc5_pipeline import _check_existing, check_path

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def _headshot_modes() -> list[str]:
    return [n for n in dir(RLPy) if n.startswith("EHSMode_")]


def headshot_from_photo(photo_path: str) -> dict[str, Any]:
    """Generate a head from a front-facing photo (needs the Headshot 3 plugin)."""
    error = _check_existing(photo_path, PHOTO_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    modes = _headshot_modes()
    if not modes:
        return {"success": False, "error": "Headshot is not available in this CC5 install (Headshot 3 plugin required)"}
    mode = next((m for m in modes if "Pro" in m), modes[0])
    RLPy.RGlobal.BeginAction("Headshot From Photo")
    try:
        RLPy.RHeadshot.CreateHeadFromPhoto(photo_path, getattr(RLPy, mode), RLPy.RHeadshotOption())
    except Exception as e:
        return {"success": False, "error": f"Headshot failed ({e}). Check the Headshot 3 plugin is installed and licensed."}
    finally:
        RLPy.RGlobal.EndAction()
    cc5_api._invalidate_caches()
    return {"success": True, "mode": mode}


def load_facial_profile(file_path: str) -> dict[str, Any]:
    error = check_path(file_path)
    if error:
        return {"success": False, "error": error}
    ext = os.path.splitext(file_path)[1].lower()
    if not (ext.startswith(".cc") or ext.startswith(".i")):
        return {"success": False, "error": f"Not a CC content file: {ext}"}
    if not os.path.isfile(file_path):
        return {"success": False, "error": f"File not found: {file_path}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    RLPy.RGlobal.BeginAction("Load Facial Profile")
    try:
        avatar.GetFacialProfileComponent().LoadProfile(file_path)
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True}


ACTIONS: dict[str, Any] = {
    "headshot_from_photo": lambda p: headshot_from_photo(p["photo_path"]),
    "load_facial_profile": lambda p: load_facial_profile(p["file_path"]),
}
POST_ROUTES: dict[str, str] = {"/builder/facial_profile": "load_facial_profile"}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "headshot_from_photo": ["photo_path"],
    "load_facial_profile": ["file_path"],
}
```
`server.py`: `EXTENSION_MODULES: list[str] = ["cc5_pipeline", "cc5_skin", "cc5_builder"]`.

- [ ] **Step 4: Run** — `npm run test:py` — Expected: pass.

- [ ] **Step 5: Failing TS test** — `tests/tools/builder.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerBuilderTools, searchContent } from "../../src/tools/builder.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBuilderTools(server as any, bridge as any);
});

describe("searchContent", () => {
  it("matches every word in the file name across folders", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "cloth_upper" ? ["C:/c/Military Jacket Camo.iClothes", "C:/c/Hoodie.iClothes"] : ["C:/s/Combat Boots.ccShoes"]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "camo jacket", ["cloth_upper", "shoes"]);
    expect(hits).toEqual([{ folder: "cloth_upper", path: "C:/c/Military Jacket Camo.iClothes" }]);
  });

  it("skips folders that error", async () => {
    bridge.browseContent.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(["C:/s/Combat Boots.ccShoes"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "boots", ["cloth_upper", "shoes"]);
    expect(hits).toHaveLength(1);
  });

  it("ignores error strings browse_content returns inside its list", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "shoes" ? ["C:/s/Combat Boots.ccShoes"] : ["Unknown folder type: texture. Available: cloth, shoes, pose"]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await searchContent(bridge as any, "pose", ["shoes", "texture"])).toEqual([]);
  });
});

describe("headshot_from_photo", () => {
  it("rejects non-photos", async () => {
    const r = await server.getRegisteredTool("headshot_from_photo")({ photo_path: "C:/a/b.gif" });
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/tools/builder.test.ts` — Expected: FAIL.

- [ ] **Step 7: Implement**

`tests/helpers/mock-bridge.ts`: add `browseContent: vi.fn(), loadFacialProfile: vi.fn(),` (and `loadAsset` already exists).

`src/cc5-bridge.ts`:
```ts
  async loadFacialProfile(filePath: string): Promise<OperationResult> {
    return this.request("/builder/facial_profile", "POST", { file_path: filePath });
  }
```
`src/tools/builder.ts`:
```ts
/**
 * Character-building tools: content search across categories, Headshot from a
 * photo, and facial profiles.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult } from "../util.js";
import { runJob, formatPending } from "../jobs.js";
import { checkFile } from "./pipeline.js";
import { isLocalAbsolute } from "./unity.js";

export const SEARCH_FOLDERS = [
  "cloth", "cloth_upper", "cloth_lower", "shoes", "accessory_head", "character",
  "pose", "expression", "makeup_full", "makeup_foundation", "makeup_eye", "makeup_lip",
  "image_layer", "skingen", "texture",
];

export async function searchContent(
  bridge: Pick<CC5Bridge, "browseContent">,
  query: string,
  folderTypes: string[],
): Promise<Array<{ folder: string; path: string }>> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Array<{ folder: string; path: string }> = [];
  for (const folder of folderTypes) {
    let files: string[];
    try {
      files = await bridge.browseContent(folder);
    } catch {
      continue;
    }
    for (const file of files) {
      // browse_content reports failures as a one-element list holding an error string
      // (same prefixes src/tools/content.ts filters); never treat those as file hits.
      if (/^(Unknown folder|No content folder|Content browsing|Error)/.test(file)) continue;
      const name = path.basename(file).toLowerCase();
      if (words.every((w) => name.includes(w))) hits.push({ folder, path: file });
    }
  }
  return hits;
}

export function registerBuilderTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "search_content",
    "Search installed CC5 content (clothing, shoes, characters, poses, makeup, skin layers, textures) by keywords in the file name. Hair is not a searchable category. Load a hit with load_asset.",
    {
      query: z.string().min(1).max(200).describe("Keywords, e.g. 'camo jacket'"),
      folder_types: z.array(z.string()).optional().describe(`Categories to search (default: ${SEARCH_FOLDERS.join(", ")})`),
      limit: z.number().int().min(1).max(200).default(40),
    },
    async ({ query, folder_types, limit }) => {
      try {
        const hits = await searchContent(bridge, query, folder_types ?? SEARCH_FOLDERS);
        if (!hits.length) return { content: [{ type: "text" as const, text: `No content matched '${query}'.` }] };
        const lines = hits.slice(0, limit).map((h) => `[${h.folder}] ${h.path}`);
        return { content: [{ type: "text" as const, text: `${hits.length} match(es):\n${lines.join("\n")}` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "headshot_from_photo",
    "Generate the character's head from a front-facing photo (Headshot 3 plugin required). Takes a minute or more; returns a job id if still running.",
    { photo_path: z.string().describe("Absolute path to a .jpg/.png front-facing photo") },
    async ({ photo_path }) => {
      const err = checkFile(photo_path, [".jpg", ".jpeg", ".png"]);
      if (err) return errorResult(err);
      try {
        const out = await runJob(bridge, "headshot_from_photo", { photo_path }, { waitMs: 120_000 });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; mode?: string };
        if (out.failed || !r.success) return errorResult(`Headshot failed: ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text" as const, text: `Head generated from ${path.basename(photo_path)} (${r.mode})` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "load_facial_profile",
    "Load a facial profile file (expression set) onto the character, e.g. a CC5 MetaHuman-compatible profile.",
    { file_path: z.string().describe("Absolute path to the facial profile file") },
    async ({ file_path }) => {
      if (!isLocalAbsolute(file_path)) return errorResult("file_path must be a local absolute path without '..' (no network/UNC paths)");
      return bridgeCall(() => bridge.loadFacialProfile(file_path),
        (r) => r.success ? `Loaded facial profile ${path.basename(file_path)}` : `Failed: ${r.error}`);
    }
  );
}
```
`src/index.ts`: register `registerBuilderTools`.

- [ ] **Step 8: Run** — `npm test && npm run test:py && npm run build` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add cc5-plugin src tests
git commit -m "feat(builder): headshot_from_photo, load_facial_profile, search_content"
```

---

### Task 15: Character recipe engine, `apply_character_recipe` tool, `create_character` prompt

**Files:**
- Create: `src/recipe.ts`, `tests/recipe.test.ts`, `src/prompts/create-character.ts`, `tests/prompts/create-character.test.ts`
- Modify: `src/tools/builder.ts` (register `apply_character_recipe`), `src/index.ts`, `tests/helpers/mock-bridge.ts` (add `setSkinColor: vi.fn(),` to `createMockBridge()`; `CC5Bridge.setSkinColor` already exists but the mock never had it)

**Interfaces:**
- Consumes: bridge methods `getAvatars`, `deleteAvatar`, `createDefaultAvatar`, `loadAsset`, `setMultipleMorphs`, `setSkinColor`, `setSkinCondition`, `loadFacialProfile`, `loadTexture`, `applySkinOverlay`, `setWrinkleStrength`, `setExpression`, `applyPose`, `startJob`/`getJob`; `BODY_PRESETS` from `src/tools/character.ts`.
- Produces: `RecipeSchema` (zod), `type Recipe`, `interface StepResult { step: string; ok: boolean; detail: string }`, `applyRecipe(bridge: CC5Bridge, recipe: Recipe): Promise<StepResult[]>`, `formatReport(results: StepResult[]): string`. MCP tool `apply_character_recipe(recipe)`. MCP prompt `create_character(description)`.

Recipe step order (fixed, each optional): `base` → `headshot_photo` → `body_preset` → `morphs` → `skin_rgb` → `skin_condition` → `facial_profile` → `assets` (hair, clothing, shoes, accessories, makeup) → `textures` → `overlays` → `wrinkle_strength` → `expression` → `pose_file`. A failing step is recorded and the rest still run.

- [ ] **Step 1: Failing test** — `tests/recipe.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { applyRecipe, formatReport, RecipeSchema } from "../src/recipe.js";
import { createMockBridge } from "./helpers/mock-bridge.js";
import type { MockBridge } from "./helpers/mock-bridge.js";

let bridge: MockBridge;
const ok = { success: true };

beforeEach(() => {
  bridge = createMockBridge();
  for (const m of ["createDefaultAvatar", "loadAsset", "setMultipleMorphs", "setSkinColor", "setSkinCondition",
    "applySkinOverlay", "applyPose", "setExpression"] as const) bridge[m].mockResolvedValue(ok);
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
});

describe("applyRecipe", () => {
  it("runs steps in order and reports each", async () => {
    const recipe = RecipeSchema.parse({
      base: "default",
      body_preset: { preset: "heavy", intensity: 0.5 },
      skin_rgb: [0.8, 0.6, 0.5],
      skin_condition: { condition: "pale", amount: 0.7 },
      assets: ["C:/c/Jacket.iClothes", "C:/h/Short.ccHair"],
      overlays: [{ image_path: "C:/o/bruise.png", region: "head", strength: 60 }],
      pose_file: "C:/p/Supine.rlMotion",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results.map((r) => r.step)).toEqual([
      "base", "body_preset", "skin_rgb", "skin_condition", "asset Jacket.iClothes", "asset Short.ccHair",
      "overlay bruise.png", "pose_file"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(bridge.setMultipleMorphs.mock.calls[0][0][0].value).toBeCloseTo(0.35);
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(bridge.deleteAvatar.mock.invocationCallOrder[0]).toBeLessThan(bridge.createDefaultAvatar.mock.invocationCallOrder[0]);
    expect(bridge.setSkinCondition).toHaveBeenCalledWith("pale", 0.7, "all", [0.8, 0.6, 0.5]);
  });

  it("keeps going after a failed step", async () => {
    bridge.loadAsset.mockResolvedValueOnce({ success: false, error: "File not found" });
    const recipe = RecipeSchema.parse({ assets: ["C:/x/Missing.iClothes"], pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results[0]).toMatchObject({ ok: false, detail: "File not found" });
    expect(results[1]).toMatchObject({ step: "pose_file", ok: true });
  });

  it("records thrown errors as failed steps", async () => {
    bridge.applyPose.mockRejectedValue(new Error("bridge down"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ pose_file: "C:/p/a.rlMotion" }));
    expect(results[0]).toMatchObject({ ok: false, detail: "bridge down" });
  });
});

describe("formatReport", () => {
  it("summarises failures", () => {
    const text = formatReport([{ step: "base", ok: true, detail: "" }, { step: "pose_file", ok: false, detail: "nope" }]);
    expect(text).toContain("1 of 2 steps failed");
    expect(text).toContain("FAIL pose_file: nope");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/recipe.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — first, `tests/helpers/mock-bridge.ts`: add `setSkinColor: vi.fn(),` to `createMockBridge()`. Without it, `bridge.setSkinColor` is undefined and the test's `beforeEach` throws a TypeError on `.mockResolvedValue`. Then `src/recipe.ts`:
```ts
/**
 * Declarative character recipe: one JSON object describing a whole character,
 * applied step by step. A failed step is recorded and the rest still run.
 */

import path from "node:path";
import { z } from "zod";
import type { CC5Bridge } from "./cc5-bridge.js";
import { BODY_PRESETS } from "./tools/character.js";
import { isLocalAbsolute } from "./tools/unity.js";
import { runJob } from "./jobs.js";

const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const absPath = z.string().refine(isLocalAbsolute, "must be a local absolute path without '..' (no network/UNC paths)");

export const RecipeSchema = z.object({
  base: z.union([z.literal("default"), absPath]).optional()
    .describe("'default' for a new base character, or a .ccAvatar/.iAvatar path; omit to modify the current one. Setting it replaces any character already in the scene"),
  headshot_photo: absPath.optional(),
  body_preset: z.object({
    preset: z.enum(["athletic", "muscular", "slim", "heavy", "average"]),
    intensity: z.number().min(0).max(1).default(1),
  }).optional(),
  morphs: z.array(z.object({ morph_id: z.string(), value: z.number().min(-1).max(1) })).optional(),
  skin_rgb: rgb.optional(),
  skin_condition: z.object({
    condition: z.enum(["normal", "pale", "cyanotic", "flushed", "jaundiced"]),
    amount: z.number().min(0).max(1).default(1),
  }).optional(),
  facial_profile: absPath.optional(),
  assets: z.array(absPath).optional().describe("Hair, clothing, shoes, accessories, makeup content files (load_asset)"),
  textures: z.array(z.object({
    mesh_name: z.string(), material_name: z.string(),
    channel: z.enum(["diffuse", "normal", "roughness", "metallic", "ao", "opacity", "displacement", "specular", "glow", "bump", "diffuse_blend"]),
    image_path: absPath,
  })).optional(),
  overlays: z.array(z.object({
    image_path: absPath,
    region: z.enum(["all", "head", "body", "arms", "legs"]).default("all"),
    strength: z.number().min(0).max(100).default(100),
  })).optional(),
  wrinkle_strength: z.number().min(0).max(1).optional(),
  expression: z.array(z.object({ name: z.string(), weight: z.number() })).optional(),
  pose_file: absPath.optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;
export interface StepResult { step: string; ok: boolean; detail: string }

type Outcome = { success?: boolean; error?: string };

async function step(results: StepResult[], name: string, fn: () => Promise<Outcome>): Promise<void> {
  try {
    const r = await fn();
    const ok = r.success !== false;
    results.push({ step: name, ok, detail: ok ? "" : r.error ?? "failed" });
  } catch (e) {
    results.push({ step: name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

export async function applyRecipe(bridge: CC5Bridge, recipe: Recipe): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const base = recipe.base;
  if (base) {
    // create_default_avatar and load_asset are additive, and every later step acts on
    // avatars[0], so clear the scene first or the edits land on the old character.
    await step(results, "base", async () => {
      for (const a of (await bridge.getAvatars()) ?? []) await bridge.deleteAvatar(a.name);
      return base === "default" ? bridge.createDefaultAvatar() : bridge.loadAsset(base);
    });
  }
  const photo = recipe.headshot_photo;
  if (photo) {
    await step(results, "headshot_photo", async () => {
      const out = await runJob(bridge, "headshot_from_photo", { photo_path: photo }, { waitMs: 180_000 });
      if (!out.done) return { success: false, error: `still running as job ${out.job_id}` };
      return out.result as Outcome;
    });
  }
  const preset = recipe.body_preset;
  if (preset) {
    await step(results, "body_preset", () => bridge.setMultipleMorphs(BODY_PRESETS[preset.preset].map((m) => ({
      morph_id: m.morph_id, value: Math.max(-1, Math.min(1, m.value * preset.intensity)) }))));
  }
  const morphs = recipe.morphs;
  if (morphs?.length) await step(results, "morphs", () => bridge.setMultipleMorphs(morphs));
  const skin = recipe.skin_rgb;
  if (skin) await step(results, "skin_rgb", () => bridge.setSkinColor(skin[0], skin[1], skin[2]));
  const cond = recipe.skin_condition;
  // Pass skin_rgb as the base so the condition tints the chosen tone instead of overwriting it.
  if (cond) await step(results, "skin_condition", () => bridge.setSkinCondition(cond.condition, cond.amount, "all", skin));
  const profile = recipe.facial_profile;
  if (profile) await step(results, "facial_profile", () => bridge.loadFacialProfile(profile));
  for (const asset of recipe.assets ?? []) {
    await step(results, `asset ${path.basename(asset)}`, () => bridge.loadAsset(asset));
  }
  for (const t of recipe.textures ?? []) {
    await step(results, `texture ${t.material_name}/${t.channel}`,
      () => bridge.loadTexture(t.mesh_name, t.material_name, t.channel, t.image_path));
  }
  for (const o of recipe.overlays ?? []) {
    await step(results, `overlay ${path.basename(o.image_path)}`, () => bridge.applySkinOverlay(o.image_path, o.region, o.strength));
  }
  const wrinkle = recipe.wrinkle_strength;
  if (wrinkle !== undefined) await step(results, "wrinkle_strength", () => bridge.setWrinkleStrength(wrinkle));
  const expr = recipe.expression;
  if (expr?.length) await step(results, "expression", () => bridge.setExpression(expr));
  const pose = recipe.pose_file;
  if (pose) await step(results, "pose_file", () => bridge.applyPose(pose));
  return results;
}

export function formatReport(results: StepResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const head = failed.length
    ? `${failed.length} of ${results.length} steps failed.`
    : `All ${results.length} steps succeeded.`;
  const lines = results.map((r) => (r.ok ? `OK   ${r.step}` : `FAIL ${r.step}: ${r.detail}`));
  return `${head}\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/recipe.test.ts` — Expected: pass.

- [ ] **Step 5: Register the tool** — in `src/tools/builder.ts` import `{ applyRecipe, formatReport, RecipeSchema }` from `"../recipe.js"` and add:
```ts
  server.tool(
    "apply_character_recipe",
    "Build or modify a character in one call from a recipe: base, headshot photo, body preset, morphs, skin colour and condition, facial profile, content assets (hair, clothes, shoes, accessories, makeup), textures, injury overlays, wrinkles, expression, pose. Every step is reported; a failed step does not stop the rest.",
    { recipe: RecipeSchema },
    async ({ recipe }) => {
      const results = await applyRecipe(bridge, recipe);
      const text = formatReport(results);
      return results.some((r) => !r.ok) ? errorResult(text) : { content: [{ type: "text" as const, text }] };
    }
  );
```
Append to `tests/tools/builder.test.ts`:
```ts
describe("apply_character_recipe", () => {
  it("flags partial failure as an error", async () => {
    bridge.loadAsset.mockResolvedValue({ success: false, error: "File not found" });
    const r = await server.getRegisteredTool("apply_character_recipe")({ recipe: { assets: ["C:/x/a.iClothes"] } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("FAIL asset a.iClothes");
  });
});
```

- [ ] **Step 6: Failing prompt test** — `tests/prompts/create-character.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerCreateCharacterPrompt, buildCreateCharacterPrompt } from "../../src/prompts/create-character.js";

describe("create_character prompt", () => {
  it("embeds the description and the workflow", () => {
    const text = buildCreateCharacterPrompt("50-year-old male, heavy build, blast injury to left arm");
    expect(text).toContain("blast injury to left arm");
    expect(text).toContain("search_content");
    expect(text).toContain("apply_character_recipe");
    expect(text).toContain("check_quest_budget");
  });

  it("registers with the server", () => {
    const server = { prompt: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCreateCharacterPrompt(server as any);
    expect(server.prompt).toHaveBeenCalledWith("create_character", expect.any(String), expect.any(Object), expect.any(Function));
  });
});
```

- [ ] **Step 7: Run** — `npx vitest run tests/prompts` — Expected: FAIL.

- [ ] **Step 8: Implement** — `src/prompts/create-character.ts`:
```ts
/**
 * MCP prompt that walks the model from a text description to a finished,
 * budget-checked character exported to Unity.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function buildCreateCharacterPrompt(description: string): string {
  return [
    `Build this patient character in Character Creator 5: ${description}`,
    "",
    "Work in this order and show me a viewport capture after steps 3 and 6:",
    "1. check_cc5_connection. If there is no character, the recipe base will be 'default'.",
    "2. Find content with search_content (clothing, shoes, makeup, image_layer). Pick real file paths from the results; never invent paths. Hair is not searchable: keep the base character's hair, or use a .ccHair file path I give you.",
    "3. Call apply_character_recipe once with: base, body_preset or morphs (search_morphs for specific features), skin_rgb, skin_condition (pale for blood loss/shock, cyanotic for hypoxia), assets, and expression. Use headshot_photo only if I gave a photo.",
    "4. Read the step report. Fix any failed step with the individual tool, then capture_viewport.",
    "5. Injuries: apply_skin_overlay with overlay images I provide or from search_content('image_layer'); set_wrinkle_strength for age.",
    "6. pose_file via apply_pose if a pose is needed (browse_content('pose')). capture_viewport.",
    "7. Ask me for the Unity Assets folder and a character name, then export_for_unity with sub_d_level 0 (and include_current_pose: true if a pose was applied in step 6).",
    "8. check_quest_budget with the export folder. If it fails, tell me what is over budget and suggest fixes (fewer clothing layers, texture_size 2048 or 1024).",
    "9. Summarise: what was built, any failed steps, and the budget result.",
  ].join("\n");
}

export function registerCreateCharacterPrompt(server: McpServer) {
  server.prompt(
    "create_character",
    "Step-by-step workflow to build a complete patient character from a description and export it to Unity.",
    { description: z.string().describe("Who the patient is: age, sex, build, skin, clothing, injuries") },
    ({ description }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: buildCreateCharacterPrompt(description) } }],
    }),
  );
}
```
`src/index.ts`: import and call `registerCreateCharacterPrompt(server);`.

- [ ] **Step 9: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 10: Commit**
```bash
git add src tests
git commit -m "feat(builder): character recipe engine, apply_character_recipe, create_character prompt"
```

---

### Task 16: Batch-generate patient variations

**Files:**
- Create: `src/tools/batch.ts`, `tests/tools/batch.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `applyRecipe`, `RecipeSchema`, `formatReport` (Task 15); `runJob` (Task 5); `isInUnityAssets`, `CHARACTER_NAME`, `evaluateBudget`, `scanTextures`, `QUEST_DEFAULTS` (Tasks 6-7); bridge `getAvatars`, `deleteAvatar`, `loadAsset`, `getMeshStats`, `captureViewport`.
- Produces: `runBatch(bridge, input: BatchInput, writeManifest: (m: Manifest) => void): Promise<Manifest>`; `type Manifest = { created: string; base: string; unity_dir: string; variants: Array<{ name: string; ok: boolean; steps: StepResult[]; fbx?: string; budget_pass?: boolean; budget?: string[]; error?: string }> }`; MCP tool `batch_generate_patients`, which writes `<unity_dir>/patients_manifest.json` after every variant.

- [ ] **Step 1: Failing test** — `tests/tools/batch.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { runBatch } from "../../src/tools/batch.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";

let bridge: MockBridge;
const ok = { success: true };

beforeEach(() => {
  bridge = createMockBridge();
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: 1, type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
  bridge.loadAsset.mockResolvedValue(ok);
  bridge.setSkinCondition.mockResolvedValue(ok);
  bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, materials: 4 } });
  bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
  bridge.getJob.mockResolvedValue({ job_id: "cmd_1", action: "export_for_unity", status: "done",
    result: { success: true, fbx: "D:/P/Assets/Pt/A/A.fbx", folder: "D:/P/Assets/Pt/A", files: [] } });
});

const input = {
  base_character: "D:/Base/Male.ccAvatar",
  unity_dir: "D:/P/Assets/Pt",
  variants: [
    { name: "A", recipe: { skin_condition: { condition: "pale" as const, amount: 0.5 } } },
    { name: "B", recipe: {} },
  ],
};

describe("runBatch", () => {
  it("reloads the base for every variant, exports, and writes the manifest each time", async () => {
    const writes: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, (man) => writes.push(man.variants.length));
    expect(bridge.loadAsset).toHaveBeenCalledWith("D:/Base/Male.ccAvatar");
    expect(bridge.loadAsset).toHaveBeenCalledTimes(2);
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(m.variants.map((v) => v.ok)).toEqual([true, true]);
    expect(m.variants[0].budget_pass).toBe(true);
    expect(writes).toEqual([1, 2]);
  });

  it("records a failed export and continues", async () => {
    bridge.getJob.mockResolvedValueOnce({ job_id: "cmd_1", action: "export_for_unity", status: "failed",
      result: { success: false, error: "disk full" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0]).toMatchObject({ ok: false, error: "disk full" });
    expect(m.variants[1].ok).toBe(true);
  });

  it("exports a posed variant with include_current_pose", async () => {
    bridge.applyPose.mockResolvedValue(ok);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBatch(bridge as any, { ...input, variants: [{ name: "Supine", recipe: { pose_file: "C:/p/Supine.rlMotion" } }] }, () => undefined);
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ include_current_pose: true }));
  });

  it("records a CC5 crash on that variant, writes the manifest, and continues", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new Error("fetch failed"));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, (man) => writes.push(JSON.stringify(man)));
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: "fetch failed" });
    expect(m.variants[1]).toMatchObject({ name: "B", ok: true });
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]).variants[0]).toMatchObject({ name: "A", ok: false, error: "fetch failed" });
  });

  it("marks a variant not ok when a recipe step fails, but still exports it", async () => {
    bridge.setSkinCondition.mockResolvedValueOnce({ success: false, error: "No avatar in scene" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0].ok).toBe(false);
    expect(m.variants[0].steps).toContainEqual({ step: "skin_condition", ok: false, detail: "No avatar in scene" });
    expect(m.variants[0].fbx).toBe("D:/P/Assets/Pt/A/A.fbx");
    expect(m.variants[1].ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/tools/batch.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — `src/tools/batch.ts`:
```ts
/**
 * Batch patient generation: for each variant, reload a saved base character,
 * apply a recipe, export to Unity, and record a budget check — writing the
 * manifest after every variant so finished work survives a crash.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { errorResult } from "../util.js";
import { runJob } from "../jobs.js";
import { applyRecipe, RecipeSchema, type StepResult } from "../recipe.js";
import { CHARACTER_NAME, isInUnityAssets, isLocalAbsolute, evaluateBudget, scanTextures, QUEST_DEFAULTS } from "./unity.js";

export const BatchSchema = z.object({
  base_character: z.string().describe("Absolute path to a saved .ccAvatar base (see save_character)"),
  unity_dir: z.string().describe("Absolute folder inside a Unity project's Assets folder"),
  variants: z.array(z.object({ name: CHARACTER_NAME, recipe: RecipeSchema })).min(1).max(50),
  sub_d_level: z.number().int().min(0).max(2).default(0),
  texture_size: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
});
export type BatchInput = z.input<typeof BatchSchema>;

export type Manifest = {
  created: string;
  base: string;
  unity_dir: string;
  variants: Array<{ name: string; ok: boolean; steps: StepResult[]; fbx?: string; budget_pass?: boolean; budget?: string[]; error?: string }>;
};

export async function runBatch(bridge: CC5Bridge, input: BatchInput, writeManifest: (m: Manifest) => void): Promise<Manifest> {
  const parsed = BatchSchema.parse(input);
  const manifest: Manifest = { created: new Date().toISOString(), base: parsed.base_character, unity_dir: parsed.unity_dir, variants: [] };
  for (const v of parsed.variants) {
    const entry: Manifest["variants"][number] = { name: v.name, ok: false, steps: [] };
    try {
      for (const a of await bridge.getAvatars()) await bridge.deleteAvatar(a.name);
      const loaded = await bridge.loadAsset(parsed.base_character);
      if (loaded.success === false) throw new Error(`base load failed: ${loaded.error}`);
      entry.steps = await applyRecipe(bridge, v.recipe);
      const out = await runJob(bridge, "export_for_unity", {
        unity_dir: parsed.unity_dir, character_name: v.name,
        sub_d_level: parsed.sub_d_level, texture_size: parsed.texture_size,
        include_current_pose: Boolean(v.recipe.pose_file),
      }, { waitMs: 300_000 });
      if (!out.done) throw new Error(`export still running as job ${out.job_id}`);
      const r = out.result as { success: boolean; error?: string; fbx?: string; folder?: string };
      if (out.failed || !r.success) throw new Error(r.error ?? "export failed");
      entry.fbx = r.fbx;
      const stats = await bridge.getMeshStats();
      const textures = r.folder && fs.existsSync(r.folder) ? scanTextures(r.folder) : [];
      const budget = evaluateBudget(stats, textures, QUEST_DEFAULTS);
      entry.budget_pass = budget.pass;
      entry.budget = budget.lines;
      entry.ok = entry.steps.every((s) => s.ok);
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }
    manifest.variants.push(entry);
    writeManifest(manifest);
  }
  return manifest;
}

export function registerBatchTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "batch_generate_patients",
    "Generate many patient variations from one saved base character: each variant applies a character recipe, exports to <unity_dir>/<name>/ and gets a Quest budget check. Writes patients_manifest.json in unity_dir after every variant. Save the base first with save_character.",
    BatchSchema.shape,
    async (input) => {
      if (!isLocalAbsolute(input.unity_dir) || !isInUnityAssets(input.unity_dir)) {
        return errorResult(`unity_dir must be a local absolute folder inside a Unity project's Assets folder: ${input.unity_dir}`);
      }
      if (!isLocalAbsolute(input.base_character) || path.extname(input.base_character).toLowerCase() !== ".ccavatar") return errorResult("base_character must be a local absolute .ccAvatar path (no network/UNC paths)");
      const manifestPath = path.join(input.unity_dir, "patients_manifest.json");
      fs.mkdirSync(input.unity_dir, { recursive: true });
      const m = await runBatch(bridge, input, (man) => fs.writeFileSync(manifestPath, JSON.stringify(man, null, 2)));
      const lines = m.variants.map((v) => `${v.ok ? "OK  " : "FAIL"} ${v.name}${v.error ? `: ${v.error}` : ""}${v.budget_pass === false ? " (over Quest budget)" : ""}`);
      const failed = m.variants.filter((v) => !v.ok).length;
      const text = `${m.variants.length - failed}/${m.variants.length} variants exported. Manifest: ${manifestPath}\n${lines.join("\n")}`;
      return failed ? errorResult(text) : { content: [{ type: "text" as const, text }] };
    }
  );
}
```
`src/index.ts`: register `registerBatchTools`. `tests/helpers/mock-bridge.ts`: confirm `getAvatars`, `deleteAvatar`, `loadAsset`, `getMeshStats`, `startJob`, `getJob`, `setSkinCondition` exist (all added by earlier tasks or already present).

Note: the tool runs the whole batch inside one MCP call. Claude Code's MCP tool timeout must allow it; Task 17 documents setting `MCP_TOOL_TIMEOUT` for long batches.

- [ ] **Step 4: Run** — `npm test && npm run build` — Expected: pass.

- [ ] **Step 5: Commit**
```bash
git add src tests
git commit -m "feat(batch): batch_generate_patients with per-variant manifest and budget check"
```

---

## Phase 6 — Install, verify live, publish

### Task 17: Installer and docs

**Files:**
- Modify: `install-plugin.ps1`, `README.md`, `.claude/rules/cc5-dev.md`
- Create: `tests/py/test_install_script.py`

**Interfaces:**
- Produces: `install-plugin.ps1` copies every `cc5-plugin\*.py` plus `config.json`/`config.xml` from the script's own folder; prints the token-file location.

- [ ] **Step 1: Failing test** — `tests/py/test_install_script.py`:
```python
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class InstallScriptTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, "install-plugin.ps1"), encoding="utf-8") as f:
            self.text = f.read()

    def test_no_hardcoded_author_path(self):
        self.assertNotIn("C:\\Users\\macka", self.text)

    def test_copies_all_python_modules(self):
        self.assertIn("*.py", self.text)
```

- [ ] **Step 2: Run** — `npm run test:py` — Expected: FAIL.

- [ ] **Step 3: Implement** — `install-plugin.ps1`:
```powershell
# CC5 MCP Bridge Plugin Installer — run in an Administrator PowerShell.
$source = Join-Path $PSScriptRoot "cc5-plugin"
$dest   = "C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge"

if (-not (Test-Path (Join-Path $source "main.py"))) {
    Write-Host "Cannot find $source\main.py. Run this script from the cc5-mcp-server folder." -ForegroundColor Red
    exit 1
}
if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
    Write-Host "Removed old plugin." -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $source "*.py") $dest
Copy-Item (Join-Path $source "config.json") $dest
Copy-Item (Join-Path $source "config.xml") $dest

$count = (Get-ChildItem $dest).Count
Write-Host "Plugin installed to: $dest ($count files)" -ForegroundColor Green
Write-Host "Restart Character Creator 5. On first start it writes its access token to $env:LOCALAPPDATA\CC5_MCP_Bridge\token" -ForegroundColor Cyan
```

README: rewrite the existing **Security** section in place (do not add a second one): token file, Host/Content-Type checks, dev mode off by default; `CC5_DEV_MODE=1` only for plugin development, enables `exec_python` and `/reload`; `CC5_ALLOW_EXEC=1` also enables `exec_python` without dev mode; replace the "Reload authentication" bullet (`CC5_RELOAD_SECRET` / `X-Reload-Token`) with "every endpoint except `GET /health` needs the `X-CC5-Token` header; `/reload` also needs `CC5_DEV_MODE=1`". Add sections **New tools** (table: `job_status`, `export_for_unity`, `check_quest_budget`, `apply_pose`, `save_character`, `export_obj`, `export_goz`, `import_fbx`, `list_meshes`, `replace_mesh_from_obj`, `load_texture`, `load_substance_textures`, `export_textures`, `apply_skin_overlay`, `remove_skin_overlay`, `set_skin_condition`, `set_wrinkle_strength`, `search_content`, `headshot_from_photo`, `load_facial_profile`, `apply_character_recipe`, `batch_generate_patients`; prompt `create_character`), **Long batches** (set env `MCP_TOOL_TIMEOUT=1800000` when starting Claude Code for `batch_generate_patients`), **Budget defaults** (the four `CC5_BUDGET_*` env vars and their defaults: 65,000 faces (triangles), 20 materials, 2048 px, 66 MiB estimated texture GPU memory (`CC5_BUDGET_MAX_TEXTURE_GPU_MB`; file size on disk is reported but not limited), which match the heaviest shipping Trauma Sim patient, `Patient_FemaleWhite`, measured 2026-10-02). In the environment-variable table, change the `CC5_REQUEST_TIMEOUT_MS` default from `30000` to `35000` and note that it must stay above the bridge's 30 s command timeout. Fix the stale tool count and the `execute_python`/`execute_rlpy` names (the real tool is `exec_python`). Remove what Task 2 made wrong: in the Configuration table set the `CC5_DEV_MODE` default to `0`, delete the `CC5_RELOAD_SECRET` row, keep the `CC5_ALLOW_EXEC` row, and add a `CC5_BRIDGE_TOKEN` row (overrides the token file `$LOCALAPPDATA/CC5_MCP_Bridge/token`; read by both the plugin and the MCP server); replace both `curl` examples under "Hot-Reload the Python Plugin" with one that sets `CC5_DEV_MODE=1` and runs `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload`; in the GET Endpoints table mark `/reload` as "dev mode only, token required" and add a note that every endpoint except `/health` needs the `X-CC5-Token` header. Afterwards `grep -nE "RELOAD_SECRET|X-Reload-Token" README.md` must print nothing.

`.claude/rules/cc5-dev.md`: replace both `/reload` commands — the Bridge Operations line (line 7, `cc5_api.py を変更したら: ...`) and workflow step 4 (line 32) — with "After changing `cc5_api.py` or an extension module, `/reload` (needs `CC5_DEV_MODE=1` and the `X-CC5-Token` header: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload`)". Rewrite workflow steps 1-3 (lines 29-31) as: "1. Add the Python function to the feature module (`cc5_pipeline.py` / `cc5_skin.py` / `cc5_builder.py`, or a new module appended to `server.EXTENSION_MODULES`). 2. Register it in that module's module-level `ACTIONS`, `POST_ROUTES`, `REQUIRED_PARAMS` (`server.load_extensions` merges them); do not add new actions to `_auto_patch_server()` or to server.py's tables — `_auto_patch_server` is legacy for `cc5_api` only." Renumber the remaining steps. In workflow step 5 and the テスト section's 実機テスト / API ディスカバリ lines (lines 33, 64-65), say every request except `/health` needs the same `-H "X-CC5-Token: ..."` header, and add it to the `/api` curl. After the edit, `grep -nE "5101/reload|_auto_patch_server" .claude/rules/cc5-dev.md` must show only token-header curls and the legacy note.

- [ ] **Step 4: Run** — `npm run test:py && npm test && npm run build` — Expected: pass.

- [ ] **Step 5: Commit**
```bash
git add install-plugin.ps1 README.md .claude/rules/cc5-dev.md tests/py/test_install_script.py
git commit -m "docs: fix installer path, copy all plugin modules, document new tools and security"
```

---

### Task 18: Live verification in CC5 (gate before publishing)

Unit tests run against a fake RLPy. This task is the only proof the RLPy calls work. Every **LIVE-VERIFY** item must end PASS or be fixed here.

**Files:**
- Modify: `scripts/live_smoke_test.py`
- Possibly modify: `cc5_pipeline.py`, `cc5_skin.py`, `cc5_builder.py` (signature fixes found live)

**Interfaces:**
- Consumes: every POST route and job action above; token from `%LOCALAPPDATA%\CC5_MCP_Bridge\token`.

- [ ] **Step 1: Send the token in the smoke test** — in `scripts/live_smoke_test.py` `call()`:
```python
TOKEN_FILE = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "CC5_MCP_Bridge", "token")
TOKEN = os.environ.get("CC5_BRIDGE_TOKEN") or (open(TOKEN_FILE, encoding="utf-8").read().strip() if os.path.exists(TOKEN_FILE) else "")
```
and add `"X-CC5-Token": TOKEN` to the request headers.

Also replace the existing exec check (`scripts/live_smoke_test.py:211`, the line `s, r = call("POST", "/exec/python", {"code": "result=6*7"}); ok("exec_python", ...)`). Task 2 turns dev mode off by default, so on a default install `/exec/python` now returns 403 and the old check would FAIL. Use this instead:
```python
s, r = call("POST", "/exec/python", {"code": "result=6*7"})
if any(os.environ.get(v, "").strip().lower() in ("1", "true", "yes") for v in ("CC5_DEV_MODE", "CC5_ALLOW_EXEC")):
    ok("exec_python (dev mode)", res(r).get("success") and str(res(r).get("result")) == "42", s)
else:
    ok("exec_python blocked without dev mode", s == 403, s)
```

- [ ] **Step 2: Add live checks** — insert a `== Exonicus extensions ==` section immediately before the final summary block, which is the `print(f"\n==== {len(P)} PASS / {len(F)} FAIL / {len(S)} SKIP ====")` line near the end of the file. Do not append it at the end of the file: the file ends with `sys.exit(1 if F else 0)`, so code placed after that line never runs and its checks are never counted. It uses a scratch folder `%TEMP%\cc5_live\Assets\Test` and the fixtures `scripts/fixtures/overlay.png` (a 1024x1024 PNG, any content) and the default avatar:
```python
def job(action, params, timeout=600):
    s, r = call("POST", "/jobs/start", {"action": action, "params": params})
    jid = res(r).get("job_id") if s == 200 else None
    if not jid:
        return None
    import time
    end = time.time() + timeout
    while time.time() < end:
        _, st = call("POST", "/jobs/status", {"job_id": jid})
        st = res(st)
        if st.get("status") in ("done", "failed"):
            return st.get("result")
        time.sleep(1)
    return None

print("== Exonicus extensions ==")
scratch = os.path.join(tempfile.gettempdir(), "cc5_live", "Assets", "Test")
import urllib.request as _u
try:
    _u.urlopen(_u.Request(BASE + "/avatars"), timeout=5)
    ok("auth required", False)
except urllib.error.HTTPError as e:
    ok("auth required", e.code == 401, e.code)
s, r = call("POST", "/pipeline/mesh_stats", {}); ok("get_mesh_stats", res(r).get("success"), res(r).get("totals"))
r = job("export_for_unity", {"unity_dir": scratch, "character_name": "LiveTest", "sub_d_level": 0, "texture_size": 1024})
ok("export_for_unity", bool(r and r.get("success") and os.path.exists(r["fbx"])), r)
obj_out = os.path.join(scratch, "obj", "live.obj")
s, r = call("POST", "/pipeline/export_obj", {"output_path": obj_out}); ok("export_obj", res(r).get("success"), res(r))
# LIVE-VERIFY: the OBJ must hold the body mesh (part bits set). Also open live.obj once and confirm it is in bind pose (ResetToBindPose).
ok("export_obj has CC_Base_Body", os.path.exists(obj_out) and "CC_Base_Body" in open(obj_out, encoding="utf-8", errors="ignore").read(), obj_out)
r = job("export_goz", {"output_dir": os.path.join(scratch, "goz"), "pose": "tpose"}); ok("export_goz", bool(r and r.get("success") and r.get("pose_applied")), r)
fbx = os.path.join(scratch, "LiveTest", "LiveTest.fbx")
r = job("import_fbx", {"file_path": fbx, "kind": "prop"}); ok("import_fbx prop", bool(r and r.get("success")), r)
s, r = call("POST", "/pipeline/meshes", {}); meshes = res(r).get("meshes") or []; ok("list_meshes", bool(meshes), meshes[:3])
s, r = call("POST", "/pipeline/save_character", {"output_path": os.path.join(scratch, "base.ccAvatar")}); ok("save_character", res(r).get("success"), res(r))
overlay = os.path.join(os.path.dirname(__file__), "fixtures", "overlay.png")
s, r = call("POST", "/skin/overlay", {"image_path": overlay, "region": "head", "strength": 60}); ok("apply_skin_overlay", res(r).get("success"), res(r))
s, r = call("POST", "/skin/condition", {"condition": "pale", "amount": 0.8}); ok("set_skin_condition", res(r).get("success"), res(r))
s, r = call("POST", "/skin/wrinkle", {"strength": 0.5}); ok("set_wrinkle_strength", res(r).get("success"), res(r))
s, r = call("POST", "/skin/overlay/remove", {"region": "head"}); ok("remove_skin_overlay", res(r).get("success"), res(r))
r = job("export_textures", {"output_dir": os.path.join(scratch, "sp"), "character_name": "LiveTex"}); ok("export_textures", bool(r and r.get("success")), r)
tex = r if isinstance(r, dict) else {}
if tex.get("folder"):  # proves the LoadSubstancePainterTextures signature; the folder need not be a real Substance export
    s, r = call("POST", "/pipeline/substance_import", {"folder": tex["folder"]}); ok("load_substance_textures", res(r).get("success"), res(r))
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
obj = os.path.join(scratch, "obj", "live.obj")
if body and os.path.exists(obj):  # unedited OBJ back onto the same mesh: proves ReplaceMesh(name, path, False, False)
    s, r = call("POST", "/pipeline/replace_mesh", {"mesh_name": body, "obj_path": obj}, timeout=300); ok("replace_mesh_from_obj", res(r).get("success"), res(r))
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
    s, r = call("POST", "/pipeline/pose", {"file_path": pose}); ok("apply_pose", res(r).get("success"), res(r))
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
# LIVE-VERIFY: image_layer must list overlay images. If CC5 lists only .cc* content here, FAIL and change apply_skin_overlay's
# description and create_character step 5 to say overlays are PNG/JPG/TGA files the user provides (drop the image_layer pointer).
layers = [p for p in (res(call("POST", "/content/browse", {"folder_type": "image_layer"})[1]) or []) if isinstance(p, str)]
images = [p for p in layers if os.path.splitext(p)[1].lower() in (".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff")]
if layers:
    ok("browse image_layer returns overlay images", bool(images), layers[:3])
else:
    skip("browse image_layer returns overlay images", "no image-layer content installed")
cloth = os.environ.get("CC5_LIVE_CLOTH_FBX", "")
if os.path.isfile(cloth):
    r = job("import_fbx", {"file_path": cloth, "kind": "clothing"}); ok("import_fbx clothing", bool(r and r.get("success")), r)
else:
    skip("import_fbx clothing", "set CC5_LIVE_CLOTH_FBX to a clothing FBX")
if os.path.exists(fbx):  # last: adds a second character to the scene
    r = job("import_fbx", {"file_path": fbx, "kind": "character"}); ok("import_fbx character", bool(r and r.get("success")), r)
else:
    skip("import_fbx character", "export_for_unity failed")
skip("headshot_from_photo", "run manually with a real photo if Headshot 3 is licensed")
```
Create the fixture once: `py -3 -c "import struct,zlib;w=h=1024;raw=b''.join(b'\x00'+b'\x80\x30\x30\xff'*w for _ in range(h));c=lambda t,d:struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d));open('scripts/fixtures/overlay.png','wb').write(b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))"` (after `mkdir scripts/fixtures`).

- [ ] **Step 3: Install and run against real CC5** (scratch project; this mutates the scene)

```powershell
# Administrator PowerShell
powershell -ExecutionPolicy Bypass -File D:\_Repos\cc5-mcp-server\install-plugin.ps1
```
Start CC5 with a default character. Leave `CC5_DEV_MODE` and `CC5_ALLOW_EXEC` unset so the run checks that `exec_python` is blocked by default. If you set either variable for CC5 while debugging, set it the same way in the shell that runs the smoke test, because the exec check reads the client's environment. The final recorded run must have both variables unset. Then run:
```bash
py -3 scripts/live_smoke_test.py
```
Expected: every check PASS (or SKIP with a reason). A SKIP is not a PASS: for each skipped check (`apply_pose`, `load_facial_profile`, `import_fbx clothing`, `headshot_from_photo`, or any other), re-run with the named env var pointing at a real file (`CC5_LIVE_POSE`, `CC5_LIVE_FACIAL_PROFILE`, `CC5_LIVE_CLOTH_FBX`) or run that tool by hand in CC5; anything still unverified goes in the Task 19 Step 4 report. For each FAIL on a LIVE-VERIFY item: set `CC5_DEV_MODE=1` in the environment CC5 starts from (restart CC5; the flag is read at startup), inspect with `exec_python` (e.g. `result = [m for m in dir(RLPy.RFileIO) if 'Obj' in m]`, `result = dir(RLPy.RExportGoZMeshOption())` for the GoZ pose setter name; an `export_goz` FAIL with `pose_applied: false` means none of the guessed setters exists), fix the signature list (or the pose-setter tuple in `export_goz`) in the module **in the repo** (`cc5-plugin/`), then copy it to the installed plugin, because CC5 loads the copy under `C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\` and `/reload` only re-imports that copy. To copy, re-run `install-plugin.ps1` from an Administrator PowerShell (or copy the changed `.py` into that folder; do not use `scripts/copy_to_installed.ps1`, which is hard-coded to another user's paths and copies only `cc5_api.py`). Then reload with `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload` and re-run. Record what was fixed in the commit message. For each `browse <type>` FAIL, check the `EContentRootFolder_*` name in `browse_content`'s `enum_candidates` against `dir(RLPy)` via `exec_python`. For each `browse <type>` SKIP where CC5's Content Manager does show items for that type (most likely `image_layer`, `wrinkle_mask` or `texture`), check those files' extensions against the filter in `browse_content`: it keeps `.cc*`/`.i*` content, `.rl*` files only for `pose`/`motion` (Task 8) and image files only for `image_layer`, `texture` and `wrinkle_mask` (Task 13).

`get_mesh_stats` (LIVE-VERIFY the scope of `GetMeshes(True)`): with `CC5_DEV_MODE=1`, run `result = [m.GetName() for m in RLPy.RScene.GetAvatars()[0].GetMeshes(True)]` through `exec_python` and record whether worn clothing/hair mesh names appear in it. The dedupe handles either answer. Then confirm that each mesh name appears only once in the tool's `meshes` list, and that `totals.faces` is no higher than the triangle count Unity shows for the imported `LiveTest.fbx`. A higher figure means meshes are being counted twice.

- [ ] **Step 4: Visual checks** (capture_viewport after each, keep the PNGs in the PR description)
  - Overlay at strength 60 visibly darkens the face; removing it restores the skin.
  - `pale` 0.8 visibly lightens and desaturates the skin; `normal` restores it.
  - `LiveTest.fbx` imports into a Unity 6 project with materials and textures resolved.
  - LIVE-VERIFY face unit: compare the `get_mesh_stats` `totals.faces` printed in Step 3 with the total triangle count Unity reports for `LiveTest.fbx` (add up each mesh's tris in the model importer preview; the export used `sub_d_level: 0`, the same mesh the stats read). If the two are within about 5%, `GetFacesCount` counts triangles and nothing changes. If Unity's count is roughly 1.5-2x higher, `GetFacesCount` counts polygons. In that case, make Task 7's `get_mesh_stats` report triangles instead, as `sum(len(mesh.GetFace(i)) - 2 for i in range(mesh.GetFacesCount()))` (or `faces * 2` if `GetFace` is unusable). Keep the `faces` key and the `maxFaces` / `max_faces` names so the TS interfaces and tests stay valid, change the `evaluateBudget` label from `Faces:` to `Triangles:`, update the fake mesh in `tests/py/test_pipeline_stats.py` to match, re-run Step 5, and add `src/tools/unity.ts` and `tests/py/test_pipeline_stats.py` to the Step 6 commit. Record the finding in the commit message and tell Chad.
  - The GoZ folder opens in ZBrush (if available); the OBJ opens in Blender.
  - A Blender-preset FBX plus its `.json` imports with Reallusion's CC/iC Blender Tools add-on (if installed).

- [ ] **Step 5: Full test run** — `npm test && npm run test:py && npm run build` — Expected: pass.

- [ ] **Step 6: Commit**
```bash
git add scripts cc5-plugin
git commit -m "test(live): smoke checks for extension routes; signature fixes from live CC5"
```

---

### Task 19: Publish to the fork and update the intern runbook

**Files:** none in the repo; the runbook is the Claude Doc "CC5 + Claude Setup Runbook".

- [ ] **Step 1: Whole-branch review** — dispatch a fresh code reviewer on `git diff upstream/main...exonicus-extensions`; fix findings; re-run all tests.

- [ ] **Step 2: Create the private repo and push** (outward-facing — confirm with Chad first. Per the Task 0 ruling in the SDD ledger, this is the first step that touches GitHub; the repo must be private, see Global Constraints)
```bash
gh repo create cjosewski/cc5-mcp-server --private
git remote get-url origin 2>/dev/null || git remote add origin https://github.com/cjosewski/cc5-mcp-server.git
git push origin upstream/main:refs/heads/main
git fetch origin
gh repo view cjosewski/cc5-mcp-server --json visibility   # must print "PRIVATE"; stop and tell Chad if not
git push -u origin exonicus-extensions
```
Then, with Chad's go-ahead, merge to the fork's `main` (or set `exonicus-extensions` as the default branch) so the runbook's clone gets the new code.

- [ ] **Step 3: Update the runbook**
  - Step 1 clone URL → `https://github.com/cjosewski/cc5-mcp-server`. The repo is private: Chad adds the intern as a collaborator (read access) first, and the runbook gets a step before the clone: install GitHub CLI, run `gh auth login`, accept the invite.
  - Step 2 → run the fixed installer: `powershell -ExecutionPolicy Bypass -File C:\Tools\cc5-mcp-server\install-plugin.ps1` (Administrator); "done" check becomes "folder has 7 or more files".
  - Step 3 (safety setting) → remove: dev mode is now off by default and the token is automatic. Replace with a one-line note: "CC5 creates a private access key the first time it starts; you don't need to do anything."
  - Step 4 unchanged.
  - Step 5 → add example requests: "Use the create_character prompt for a 40-year-old woman, slim, pale from blood loss, in a hospital gown", "Export this patient to Unity at <path>", "Check the Quest budget".
  - Troubleshooting → add: "CC5 rejected the bridge token" → start CC5 once, then retry; "Still running in CC5 (job …)" → ask Claude to check the job status, don't repeat the request.

- [ ] **Step 4: Tell Chad** the branch URL, the live-test results, any LIVE-VERIFY items that needed signature changes, and any Task 18 check that never ran live (still SKIP) so its tool is known to be unverified.

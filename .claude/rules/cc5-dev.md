# CC5 MCP Server — Development Rules

## Bridge Operations

- The bridge starts automatically when CC5 launches (port 5101; live starts took up to about 70 seconds, and `scripts/cc5-restart.ps1` waits up to 240 s, F-93)
- Check whether the bridge is alive: `curl -s http://127.0.0.1:5101/health`
- CC5 runs the installed copy of the plugin (`C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\`), not the repo, and `/reload` re-imports that copy. After changing `cc5_api.py`, `cc5_changes.py` or an extension module (`cc5_pipeline.py`, `cc5_skin.py`, `cc5_builder.py`, `cc5_scene.py`), update the installed copy: re-run `install-plugin.ps1` (Administrator PowerShell; it copies every `cc5-plugin/*.py`, new modules included) or copy each changed or new `.py` into that folder, then `/reload` (needs `CC5_DEV_MODE=1` and the `X-CC5-Token` header: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload`). Without the copy, `/reload` reports success and nothing changes.
- After changing server.py or main.py: re-run `install-plugin.ps1`, then restart CC5

## Important Notes When Restarting CC5

When CC5 needs a restart, always use this order:
1. **Ask the user before quitting CC5.** The user saves their work and closes CC5. Never kill it with `taskkill //F` (or `Stop-Process`): unsaved work is lost.
2. Launch with `CharacterCreator.exe &`
3. Wait for the bridge to start (poll the health check, up to 240 s; with no answer by then, check the CC5 window: the 3D Creator / AI Studio chooser, a startup dialog)
4. **Never send keys or clicks to CC5.** The user answers CC5's startup dialogs themselves (until they do, the viewport does not render correctly):
   - "Unsaved project data found": OK restores the auto-saved changes, Cancel discards them. Exception (Chad, 2026-10-05, F-52): a CC5 launched with `CC5_RECOVERY_ANSWER=cancel` (`scripts/cc5-restart.ps1` does this by default; from bash: `CC5_RECOVERY_ANSWER=cancel "/c/Program Files/.../CharacterCreator.exe" &`) has the plugin answer Cancel itself; tell the user when `get_cc5_dialog` reports it
   - Welcome screen: tick "Don't show this again" (it then stays closed), or close it by hand

## Viewport Capture

`capture_viewport` uses a three-stage fallback: RenderImage → ForceViewportUpdate+retry → Windows screenshot.
After a .ccProject is loaded, RenderImage sometimes does not work, so the fallback is important.
The capture undoes its own render step (F-53), and a render made while CC5 still loads a file's images took the load back with it (F-104). So the queue holds `capture_viewport` and `replace_mesh_from_obj` (`server.SETTLE_ACTIONS`) until 0.3 s after the previous command and until CC5's image load is done (at most 20 s), and a capture whose own undo still changed the scene redoes once, with a WARNING note. That check sees only objects and worn items, not a material, texture, preset or morph change, so a capture that runs while `server._images_loading` is still set (after those 20 s) does not undo its own step at all, with a WARNING (batch F review #2). A failed capture has its notes in `error` too, one line each: the bridge answers it with HTTP 400, and the MCP server keeps only `error` (batch F review #5).

## Code Change Workflow

1. Add the Python function to the feature module (`cc5_pipeline.py` / `cc5_skin.py` / `cc5_builder.py` / `cc5_scene.py`, or a new module appended to `server.EXTENSION_MODULES`). A helper module without ACTIONS (`cc5_changes.py`) is imported where it is used and never added to `server.EXTENSION_MODULES` (`load_extensions` needs ACTIONS).
2. Register it in that module's module-level `ACTIONS`, `POST_ROUTES`, `REQUIRED_PARAMS` (`server.load_extensions` merges them); do not add new actions to `_auto_patch_server()` or to server.py's tables — `_auto_patch_server` is legacy for `cc5_api` only.
3. After changing `cc5_api.py`, `cc5_changes.py` or an extension module (`cc5_pipeline.py`, `cc5_skin.py`, `cc5_builder.py`, `cc5_scene.py`), update the installed copy CC5 runs: re-run `install-plugin.ps1` (Administrator PowerShell; it copies every `cc5-plugin/*.py`, new modules included) or copy each changed or new `.py` into `C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\`. Then `/reload` (needs `CC5_DEV_MODE=1` and the `X-CC5-Token` header: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload`). A `server.py` or `main.py` change needs the reinstall and a CC5 restart instead.
4. Live test with `curl` — every request except `/health` needs the same `-H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)"` header
5. Add the TypeScript side (types.ts → cc5-bridge.ts → tools/*.ts → index.ts), then the README.md and CLAUDE.md tool counts (tests/index-wiring.test.ts)
6. Check the build with `npm run build`
7. Check the tests with `npm test` and `npm run test:py` (the Python suite includes `tests/py/test_py38_compat.py`, the check against CC5's Python 3.8.8)

## RLPy API Reference

- Complete API reference: `docs/rlpy-api-reference.md` (5,393 lines)
- 163 classes, 90 Enum groups, 287 global functions
- When adding a new feature, first confirm in this file that the API exists

## RLPy Constraints

- RLPy is NOT thread-safe — it can only be called from the main thread via QTimer
- SWIG bindings — invalid arguments can cause a C++ segfault
- Always validate arguments before calling RLPy
- `BeginAction()` / `EndAction()` — always wrap modifying operations in these. Guarantee EndAction with try/finally
- `ObjectModified()` — always call it after a change (required for the viewport to update)

## How the Plugin Works

- Entry points: `initialize_plugin()` / `uninitialize_plugin()` (load/unload are not supported)
- Plugin info: `rl_plugin_info = {"ap": "iClone", "ap_version": "8.0"}`
- CC5 is built on the iClone 8 engine — `"Character Creator"` and `"4.0"` are not recognized
- PySide2 required (PySide6 not supported)
- CC5 5.13 runs Python 3.8.8 (F-96, live 2026-10-07), so the plugin may use no Python 3.9+ feature (e.g. `list[str]` or `X | None` outside annotations, `str.removeprefix`, `match`), and every module with annotations needs `from __future__ import annotations`. `tests/py/test_py38_compat.py` checks every `cc5-plugin/*.py`; outside annotations it refuses `[...]` on a builtin generic or on `collections.*`, `collections.abc.*`, `queue.Queue`, `re.Pattern` and `re.Match` (also through an import alias), a `|` with a builtin type, `None` or a typing name (`Any`, `Optional`, `Union`, `Callable`, ...) on either side, and any `|` in the classes `isinstance()` or `issubclass()` takes. RLPy enum flag ORs stay allowed. It checks a fixed list, not every 3.9+ feature (batch F review #32): two classes or two dict variables joined with `|`, and library names not on its list (`tomllib`, `itertools.pairwise`), pass, so keep to 3.8 by hand too

## Tests

- Unit tests: `npm test` (TypeScript) and `npm run test:py` (Python plugin, fake RLPy). `test:py` runs under the developer's Python, so `tests/py/test_py38_compat.py` checks the plugin's source against CC5's Python 3.8 (F-96)
- Coverage: `npm run test:coverage` (80%+ threshold)
- Live test: send requests directly to the bridge with `curl`; every request except `/health` needs the same `-H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)"` header
- API discovery: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/api` (the full endpoint list needs `CC5_DEV_MODE=1`)

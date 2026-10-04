# CC5 MCP Server — Development Rules

## Bridge Operations

- The bridge starts automatically when CC5 launches (port 5101, about 7-10 seconds)
- Check whether the bridge is alive: `curl -s http://127.0.0.1:5101/health`
- CC5 runs the installed copy of the plugin (`C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\`), not the repo, and `/reload` re-imports that copy. After changing `cc5_api.py` or an extension module, first re-run `install-plugin.ps1` (Administrator PowerShell) or copy the changed `.py` into that folder, then `/reload` (needs `CC5_DEV_MODE=1` and the `X-CC5-Token` header: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload`). Without the copy, `/reload` reports success and nothing changes.
- After changing server.py: re-run `install-plugin.ps1`, then restart CC5

## Important Notes When Restarting CC5

When CC5 needs a restart, always use this order:
1. **Ask the user before quitting CC5.** The user saves their work and closes CC5. Never kill it with `taskkill //F` (or `Stop-Process`): unsaved work is lost.
2. Launch with `CharacterCreator.exe &`
3. Wait for the bridge to start (poll the health check)
4. **Never send keys or clicks to CC5.** The user answers CC5's startup dialogs themselves (until they do, the viewport does not render correctly):
   - "Unsaved project data found": OK restores the auto-saved changes, Cancel discards them
   - Welcome screen: tick "Don't show this again" (it then stays closed), or close it by hand

## Viewport Capture

`capture_viewport` uses a three-stage fallback: RenderImage → ForceViewportUpdate+retry → Windows screenshot.
After a .ccProject is loaded, RenderImage sometimes does not work, so the fallback is important.

## Code Change Workflow

1. Add the Python function to the feature module (`cc5_pipeline.py` / `cc5_skin.py` / `cc5_builder.py`, or a new module appended to `server.EXTENSION_MODULES`).
2. Register it in that module's module-level `ACTIONS`, `POST_ROUTES`, `REQUIRED_PARAMS` (`server.load_extensions` merges them); do not add new actions to `_auto_patch_server()` or to server.py's tables — `_auto_patch_server` is legacy for `cc5_api` only.
3. After changing `cc5_api.py` or an extension module, update the installed copy CC5 runs: re-run `install-plugin.ps1` (Administrator PowerShell) or copy the changed `.py` into `C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\`. Then `/reload` (needs `CC5_DEV_MODE=1` and the `X-CC5-Token` header: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload`). A `server.py` change needs the reinstall and a CC5 restart instead.
4. Live test with `curl` — every request except `/health` needs the same `-H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)"` header
5. Add the TypeScript side (types.ts → cc5-bridge.ts → tools/*.ts → index.ts)
6. Check the build with `npm run build`
7. Check the tests with `npm test`

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
- `from __future__ import annotations` required (Python 3.10 type-hint compatibility)

## Tests

- Unit tests: `npm test` (TypeScript) and `npm run test:py` (Python plugin, fake RLPy)
- Coverage: `npm run test:coverage` (80%+ threshold)
- Live test: send requests directly to the bridge with `curl`; every request except `/health` needs the same `-H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)"` header
- API discovery: `curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/api` (the full endpoint list needs `CC5_DEV_MODE=1`)

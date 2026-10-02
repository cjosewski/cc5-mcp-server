# CC5 MCP Server — Development Rules

## Bridge Operations

- The bridge starts automatically when CC5 launches (port 5101, about 7-10 seconds)
- Check whether the bridge is alive: `curl -s http://127.0.0.1:5101/health`
- After changing cc5_api.py: `curl http://127.0.0.1:5101/reload` applies it immediately
- After changing server.py: a CC5 restart is required

## Important Notes When Restarting CC5

When restarting CC5, always use this order:
1. Exit with `taskkill //F //PID <pid>`
2. Launch with `CharacterCreator.exe &`
3. Wait for the bridge to start (poll the health check)
4. **Auto-close the dialogs** — CC5 shows dialogs at launch:
   - "Unsaved project data found" → press OK with `SendKeys('{ENTER}')`
   - Welcome screen → close with `SendKeys('{ESCAPE}')`
   - **If these are not closed, the viewport does not render correctly**
5. Permanent fix: have the user check "Don't show this again"

## Viewport Capture

`capture_viewport` uses a three-stage fallback: RenderImage → ForceViewportUpdate+retry → Windows screenshot.
After a .ccProject is loaded, RenderImage sometimes does not work, so the fallback is important.

## Code Change Workflow

1. Add/modify the Python function in cc5_api.py
2. Add the new action to `_auto_patch_server()` (ACTION_MAP + routes)
3. Add ACTION_MAP / POST_ROUTES / REQUIRED_PARAMS to server.py
4. Reload with `curl http://127.0.0.1:5101/reload`
5. Live test with `curl`
6. Add the TypeScript side (types.ts → cc5-bridge.ts → tools/*.ts → index.ts)
7. Check the build with `npm run build`
8. Check the tests with `npm test`

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

- Unit tests: `npm test` (314 tests)
- Coverage: `npm run test:coverage` (80%+ threshold)
- Live test: send requests directly to the bridge with `curl`
- API discovery: `curl http://127.0.0.1:5101/api`

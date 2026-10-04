# End-to-end check: CC5 -> Blender -> Unity

`run_e2e.py` builds one patient with this repo's MCP tools, exports it from Character Creator 5, brings it through
Blender, and imports everything into a throwaway Unity project. Exit code 0 means every step passed; any FAIL
exits 1. Nothing is skipped silently: a step that cannot run is recorded as FAIL with the reason.

## Run it

1. Start CC5 with the MCP Bridge plugin. Close any dialog it shows (the "Unsaved project data found" recovery
   prompt, What's New); the bridge refuses commands while a modal dialog is open.
2. Build the server: `npm run build`.
3. Run:

   ```
   py -3 scripts/e2e/run_e2e.py --blender "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"
   ```

| Option | Default |
|---|---|
| `--scratch` | `%TEMP%\cc5-e2e`: every output goes here |
| `--blender` | `C:/Program Files/Blender Foundation/Blender 4.5/blender.exe` |
| `--unity` | `C:/Program Files/Unity/Hub/Editor/6000.2.10f1/Editor/Unity.exe` (signed in to Unity Hub) |
| `--base` | `CC4 Kevin.ccAvatar` from the Reallusion templates (`default` = CC5's neutral mannequin, which has no skin textures, so the texture checks fail) |
| `--pose` | `1.Male Pose/Sitting_Floor.rlPose` from the Reallusion templates |
| `--overlay` | `scripts/fixtures/overlay.png` |

**How long it takes:** about 2 minutes (103 s measured on 2026-10-03, CC4 Kevin): CC5 leg ~76 s (40 s of it are
the 10 s waits after each export), Blender ~4 s, Unity ~20 s. The first run also creates the Unity project
(11 s here; allow several minutes on a slower machine or a cold Unity package cache).

**CC5 5.13 often crashes on the first FBX export of a session** (README, Known issues). The script saves the
character, then makes a throwaway warm-up export before the checked ones. If CC5 crashes there (the
"CC5 alive 10 s after the warm-up export" step FAILs), restart CC5, answer its recovery prompt in CC5, and run
again until the warm-up survives.

## What it does

**CC5 leg.** Starts the built MCP server (`node build/index.js`) and talks MCP JSON-RPC to it over stdio, as an
agent's client does, so the checks go through the TypeScript tools: `apply_character_recipe` (base, body preset
slim 0.5, skin condition pale 0.6, the overlay at strength 60, a pained expression), `check_quest_budget`,
`save_character` (`cc5/E2E_Patient.ccAvatar`), a warm-up `export_fbx`, `export_for_unity` (`E2E_Patient`,
texture_size 2048, sub_d_level 0), `check_quest_budget` on that export folder, `export_fbx` with target_tool
`Blender` (FBX + JSON sidecar), `apply_pose`, and `export_for_unity` with `include_current_pose`
(`E2E_Patient_Posed`). Long tools are followed with `job_status`. Three steps call the bridge's HTTP endpoints
directly because they have no TypeScript logic: `/health`, `/avatars` (dialog and alive checks, 10 s after every
export) and `/pipeline/mesh_stats` (`get_mesh_stats`, which has no MCP tool of its own). The bridge token is read
from `CC5_BRIDGE_TOKEN` or `%LOCALAPPDATA%\CC5_MCP_Bridge\token` and never printed.

**Blender leg.** `blender -b --factory-startup --python blender_check.py` imports the Blender-preset FBX and
reports mesh objects, triangles, armature and bones, materials, image textures (each resolved on disk or not) and
shape keys, then exports `E2E_Patient_from_Blender.fbx` (all objects, `path_mode` COPY, textures not embedded).

**Unity leg.** Creates `<scratch>/UnityE2E` on the first run (`-createProject`, default template) and marks it
with `cc5-e2e-project.txt`; the script refuses to use an existing folder without that marker, so it never opens a
real project. It copies the three FBX files with their texture folders into `Assets/E2E/` and
`Editor/E2EImportCheck.cs` into `Assets/Editor/`, then runs
`Unity.exe -batchmode -nographics -projectPath <project> -executeMethod E2EImportCheck.Run -logFile <project>/e2e-unity.log -quit`.
`E2EImportCheck` re-imports each model and logs its importer warnings and errors, renderer counts, triangles,
materials (and which lack a main texture), rig type, bones, animation clips, and the world positions of the head,
hand and foot bones, as imported and after sampling the first clip at time 0. It writes
`<scratch>/e2e-unity-report.json` and exits 1 if a model failed to import or has no renderers.
The models import with Unity's default rig, Generic. A one-off re-import of both Unity exports as Humanoid
(avatar created from the model, as the Trauma Sim patient body is set up) gave the same pose result, with one
"Rig Error ... CC_Base_NeckTwist02" importer warning per model, posed or not.

**Pass criteria.**

- Every step ran, every export left CC5 alive 10 s later, and CC5's process id did not change during the run.
- Each Unity model imports with no errors and has renderers; its skin materials have a main texture.
- Blender resolves every image on disk, and its skin materials have image textures.
- Triangles: Unity's total for `E2E_Patient.fbx` equals `get_mesh_stats` `totals.triangles` (any per-mesh
  difference is listed); Blender and the other two Unity models are within 5 % of it.
- `E2E_Patient_Posed.fbx` comes in posed: a head, hand or foot bone is more than 5 cm away from where it is in
  `E2E_Patient.fbx`, as imported or after sampling the clip.

## Output (in the scratch folder)

| File | What |
|---|---|
| `e2e-report.md` | Steps, per-leg table, Unity models, triangles, Quest budget, pose distances, importer messages |
| `e2e-results.json` | Everything the report is built from |
| `mcp-server.log` | The MCP server's stderr |
| `cc5/` | The `.ccAvatar`, the Unity exports (`Unity/Assets/Patients/`), the Blender export (`Blender/`) |
| `blender/` | `blender-report.json`, `blender.log`, `E2E_Patient_from_Blender/` |
| `UnityE2E/` | The throwaway project and `e2e-unity.log`; `e2e-unity-report.json` sits next to it |

Each run deletes `cc5/`, `blender/` and `UnityE2E/Assets/E2E/` from the previous run first.

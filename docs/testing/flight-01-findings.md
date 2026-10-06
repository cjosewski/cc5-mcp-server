# Flight 01 findings: live test of the MCP server against CC5 5.13

In-flight test of every MCP tool against a running Character Creator 5 (5.13), run by Chad from his runbook,
2026-10-04 to 2026-10-05. Step numbers (P2-11, P4-65) are the steps reported during the run.

Fix policy (agreed 2026-10-05): fix blockers at once; log everything else here and fix open bugs in one batch at
the end of a part, so each plugin change costs one reinstall and one CC5 restart.

**Severity:** blocker (a workflow cannot be done) · bug (wrong result or false report) · minor (works, but
inconsistent or awkward) · doc (description, docs or runbook wrong) · gap (missing capability).
**Status:** open · fixed (commit) · runbook (the runbook needs changing, not the code) · retest.

## Summary

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| F-01 | blocker | fixed (`499ea45`) | No way to select scene items; character presets need the character selected |
| F-02 | bug | fixed (`499ea45`) | `load_asset` reported success for a `.ccEye` that did nothing |
| F-03 | blocker | fixed (`499ea45`, `af5ddfb`) | A command that opens a CC5 dialog timed out blind and stalled every later command |
| F-04 | bug | fixed (`af5ddfb`) | Dialog lane never ran: it shared the command timer |
| F-05 | bug | fixed (`af5ddfb`) | `answer_cc5_dialog` reported clicks CC5 never received |
| F-06 | doc | fixed (`499ea45`) / runbook | Camera guidance said to create a second camera; CC5 cannot |
| F-07 | minor | fixed (`499ea45`) | `get_selection` showed an unknown object type as `0` |
| F-08 | bug | not reproduced after F-53 (live, Batch B) | `get_diffuse_color` reads the base color (white), not the applied color |
| F-09 | bug | fixed by F-53 (live, Batch B) | Undoing a diffuse color change is unreliable |
| F-10 | bug | fixed, live (Batch A) | `set_eye_color` has no visible effect and reports materials that do not exist |
| F-11 | bug | open | `reset_morphs` also zeroes a template's identity morphs |
| F-12 | doc | fixed, live (Batch C); parameter examples still wrong (C2) | `adjust_morph` description points to a `get_morph_catalog` tool that does not exist |
| F-13 | minor | fixed, live (Batch B) | Morph and expression values come back as raw float32 (0.800000011920929) |
| F-14 | minor | fixed, live (Batch B) | Colors set from 0-1 are truncated to 0-255 steps (0.3 → 0.298), not rounded |
| F-15 | minor | fixed, live (Batch C) | `delete_avatar` on an empty scene is an error; a named delete then says "No avatars in scene" |
| F-16 | doc | fixed, live (Batch C); tool description still silent (C2) | `set_subdivision_level` refusal does not say to run Modify > Subdivide |
| F-17 | minor | partly fixed, live (Batch C); build sentence can be false (F-60) | `describe_character` says "average build" for templates and for heavy at 50% |
| F-18 | minor | fixed, live (Batch B) | `reset_expression` reports every slider (172), not the ones it changed |
| F-19 | gap | fixed (live P4-82) | `search_content` did not cover eye presets |
| F-20 | doc | runbook | `search_morphs` matches IDs too; several display names repeat with different IDs |
| F-21 | minor | partly fixed, live (Batch C); three refusal styles and four tools left (C2) | Error wording differs across tools for the same situation |
| F-22 | minor | fixed, live (Batch C); large-capture fallback broken (F-58) | `capture_viewport` without a path always overwrites the same temp file |
| F-23 | doc | fixed, live (Batch C); wording and progress windows (F-56, F-59) | `check_cc5_connection` passes while a CC5 dialog blocks every command |
| F-24 | gap | partly fixed, live (Batch B): visibility read-back for props/lights/characters, IBL image the bridge loaded; worn items and camera framing still capture-only | Some changes cannot be read back: IBL image, item visibility, camera framing |
| F-25 | bug | retest | `get_camera_info` placed the camera at the side right after the home view |
| F-26 | minor | retest | The home view cropped Kevin's feet |
| F-27 | minor | fixed, live (Batch C) | `set_light_shadow` with no settings is only refused inside CC5 |
| F-28 | gap | open | Every second character preset stops on "Replace / Material Only"; batch runs need a preset answer |
| F-29 | doc | runbook | Runbook placeholders ("‹first jaw ID›") are ambiguous; give real IDs |
| F-30 | doc | runbook | Value checks need a tolerance (float32 and 0-255 storage) |
| F-31 | retest | open | Worn accessory selection (duplicate-name risk) untested: Kevin has no accessories |
| F-32 | minor | open | Claude Code showed a stale `load_asset` schema (no `target`) after restarts; the build is correct |
| F-33 | blocker | fixed (live P4-78 to P4-81) | Hair could not be loaded at all: every CC5 hairstyle is `.rlHair`, which `load_asset` refused |
| F-34 | gap | open (to become MCP protocol) | Presets override more than they are named for (lip makeup hid hair, brows, probably the Boxers and possibly the torso skin, reset skin); `load_asset` reports a clean load |
| F-35 | bug | not a bug (P4-102) | `get_material_properties` read-back: works on a clean character; the earlier 100 came from F-34 |
| F-36 | blocker | fixed (live P4-104 to P4-106) | Material setters sent 0-1 to CC5's 0-100 scale: opacity 1.0 = 1%, the skin vanished |
| F-37 | bug | not a bug (P4-107) | Opacity undo: works on a clean character; the earlier failure came from F-34 |
| F-38 | doc + bug | fixed, live (Batch A; legacy specular storage not probed) | Glossiness/specular are legacy non-PBR values: skin shine is the roughness shader parameters; specular also stored erratically |
| F-39 | bug | fixed by F-53 (live, Batch B) | `undo` does not reverse `load_texture`; a texture load is effectively permanent (no undo, no read-back of the old texture) |
| F-40 | minor | fixed, live (Batch A) | `list_clothes` shows the item type as a raw number (`Type: 1`); it should list what is worn or say "No clothes are applied" |
| F-41 | bug | fixed, live (Batch A) | `browse_content("cloth_upper")` lists nothing: it reads `EContentRootFolder_Upper`, not the Shirts/Coats clothing folders; `cloth_lower` the same |
| F-42 | bug | fixed, live (Batch A) | `accessory_head` / `accessory_body` both list the 8 handheld/outfit items in Accessory/Others; real head (11), torso (20) and arm (47) accessories are never listed |
| F-43 | bug | wrinkle_mask fixed, live (Batch A); texture total still capped | `wrinkle_mask` lists nothing; `texture` stops at 200 of 437 images |
| F-44 | gap | open | No collision check after applying items, and no way to fix a poke-through (Kevin's scalp shows through Hat_DarkBlue) |
| F-45 | bug | fixed, live (Batch A) | `frame_camera("home")` right after `"left"` reported success but did not move the camera; `"left"` framed a hip close-up, not the whole body |
| F-46 | bug | fixed with F-53, live | `undo` after `remove_scene_item` reports success but does not bring the item back (Oval Afro stayed removed) |
| F-47 | doc | runbook | The runbook's test inputs (`C:\CC5Test\inputs\`: cube.fbx, overlay.png, notes.txt...) do not exist; file tests only exercise "not found" |
| F-48 | doc + gap | fixed, live (Batch A) | `import_fbx` description says to answer Import Settings in CC5 (the dialog tools now do it); no tool moves, scales or deletes a prop |
| F-49 | blocker | fixed, live (Batch A) | Add a "Delete object" tool: nothing can delete a prop (or other scene object) today |
| F-50 | bug | fixed (Batch A; not run live: FBX imports crash a fresh session, F-51) | `import_fbx` as clothing always dresses the first character: no `target`, ignores the selection (unlike `load_asset`) |
| F-51 | bug | open | CC5 crashed during an FBX prop import, right after "Convert All" (second session, box_01.fbx that imported fine before) |
| F-52 | blocker | fixed, live (Batch A) | The crash-recovery prompt stops an unattended run: only the user may answer it. Chad: Claude-launched CC5 answers Cancel automatically |
| F-53 | blocker | fixed, live (Batch A) | `capture_viewport` adds an undo step (it re-sets the render size), so `undo` after any capture reverses the capture, not the change |
| F-54 | bug (CC5) | open | CC5 crashed on its own 2-3 minutes after a launch, before any MCP command; Chad: CC5 often crashes on the first launch attempt |
| F-55 | bug | fixed, live (C2) | `redo` after a capture reports success but brings nothing back: the capture's own undo step takes the redo slot |
| F-56 | bug | fixed, live (C2) | A progress window (an export's, only button Cancel) is reported as a dialog waiting for an answer, inviting an agent to cancel it |
| F-57 | bug | fixed, live (C2); failed requests still print (F-63) | The bridge's request log filter never matches, so every request is printed from HTTP threads (and lands in exec_python output) |
| F-58 | bug | fixed, live (C2) | A capture over 10 MB (e.g. 8K) is overwritten by a full-screen desktop screenshot; a unit test takes a real screenshot on every npm test |
| F-59 | doc | fixed, live (C2) | check_cc5_connection overstates what an open dialog does and never shows the automatic recovery answer |
| F-60 | bug | fixed, live (C2) | describe_character's "no body-shape slider set: the template's own build" can be false (light presets, negative sliders, non-templates) |
| F-61 | minor | open | With no character in the scene, list_clothes / list_hair / list_accessories say "No clothes are applied." (as for a character wearing nothing) |
| F-62 | minor | open | `get_avatar_info` still prints raw float32 morph weights (0.3499999940395355): F-13's fix covered get_morph_value and expressions only |
| F-63 | minor | open | Failed bridge requests (4xx/5xx) are still printed from HTTP threads, into CC5's console and a running exec_python's output |
| F-64 | minor | open | The CC5-window screenshot fallback starts PowerShell without CREATE_NO_WINDOW: a console window may flash over CC5 and land in the capture |

## Details

### Fixed

**F-01: no selection; character presets need the character selected** (P4-19 to P4-24)
A `.ccEye` loaded with nothing selected did nothing; with Kevin selected by hand it applied. No MCP tool could
select. Fixed: `select_objects` / `get_selection` / `clear_selection` (`cc5_scene.py`, `selection.ts`), and
`load_asset` aims character content at `target`, else the selected character, else the first, and selects it.
Live: P4-25, P4-56 to P4-63 (several at once, add, unknown name, clear, props, not an undo step).

**F-02: `load_asset` ignored `LoadFile`'s result** (P4-21)
It returned success whatever CC5 did. Fixed: the status is checked for every load. Live: `.ccAvatar`, `.iProp`,
`.ccCam` and `.ccEye` loads still succeed (P4-38, P4-60, P4-63).

**F-03: a command that opens a CC5 dialog timed out blind** (P4-27)
A second `.ccEye` load asked "The target object layer already exists ... Replace / Material Only / Cancel"; the call
timed out after 35 s and every later command stalled. Fixed: the call returns within about 1 s with the question,
buttons and a job id; `get_cc5_dialog` / `answer_cc5_dialog`; jobs report waiting dialogs. Answering rule: Claude
answers plain confirmations, asks Chad on real choices, never answers "Unsaved project data found".
Live: P4-47 to P4-55.

**F-04: the dialog lane never ran** (P4-30, P4-31)
Qt never fires a timer again while its own callback runs; a command waiting in a dialog is that callback. Fixed:
the dialog lane has its own 50 ms timer (`main.py`, `server.process_dialog_lane`).

**F-05: `answer_cc5_dialog` clicks never reached CC5** (P4-35, P4-37, P4-45)
Deferred clicks (`QTimer.singleShot(0, callable)`, then a kept-alive `QTimer`, both behind `shiboken2.isValid`)
were reported as made but never arrived. A probe showed a direct `click()` on CC5's `QMessageBox` works. Fixed:
`answer_dialog` clicks directly.

**F-06: camera guidance** (P2-28 to P2-37)
The focal-length refusal and CLAUDE.md said "create a new camera in CC5"; CC5 has only the Preview Camera, whose
lens the API cannot change. Fixed: text now points to loading a `.ccCam` preset, which replaces the Preview Camera.
Runbook: the "set 85 mm on the new camera" step cannot pass; test the refusal instead.

**F-07: unknown object type shown as `0`** (P4-28)
Fixed: shown as "Other (type 0)".

### Open

**F-08: `get_diffuse_color` reads the base color** (P4-6, P4-10, P4-65) · bug
After `set_diffuse_color` (0.2, 0.4, 0.9) the torso is visibly blue, but the read-back is RGB(1, 1, 1). Cause
(likely): `set_diffuse_color` writes an animation key (`AddDiffuseKey`); `GetDiffuseColor(mesh, material)` has no
time argument and returns the material's base color. Fix needs an `exec_python` probe (CC5 started with
`CC5_ALLOW_EXEC=1`) to find a call that returns the keyed color. Until then, check color changes with a screenshot.

**F-09: undoing a diffuse color change is unreliable** (P4-12, P4-13) · bug
Of two undos, the first reverted the Boxers color and the second reported success with no visible effect (torso
stayed blue; morphs and facial profile unchanged). Workaround: set the color back explicitly (P4-15, P4-67).

**F-10: `set_eye_color`** (P4-16 to P4-18) · bug
No visible change on textured eyes (the iris is a texture; the tool's description warns of this). It also reported
applying to `CC_Base_Eye/Eye_R` and `Eye_L`, which do not exist (only `Std_Eye_R/L`, `Std_Cornea_R/L`): failed
`AddDiffuseKey` calls are only printed (`cc5_api.py` around lines 2245-2280). Fix: report only materials actually
changed; consider pointing to eye presets (`.ccEye` via `load_asset`), which do work.
Fix found live (P4-122 to P4-125): the iris color is the cornea's Digital_Human Eye shader, not the eye material
(`Std_Eye_R/L` is plain PBR with no parameters). Setting `Iris Color` and `Iris Inner Color` on `Std_Cornea_R` and
`Std_Cornea_L` turned Kevin's irises red. `set_eye_color` should set those two parameters on both corneas (and
mind `Iris Color Brightness`, 1.718 on Kevin, which brightens the chosen color).

**F-11: `reset_morphs` zeroes template identity morphs** (P3-28) · bug
On Kevin it reset 8 morphs including `cc4 kevin_body` and `cc4 kevin_head` (100% → 0), leaving Kevin's textures on
a neutral body. One `undo` restores them (P3-30). Fix: warn in the description, or offer "reset to template".

**F-12: `adjust_morph` description** (P3-5) · doc
Says "use get_morph_catalog first"; there is no such MCP tool. Should say `search_morphs`.

**F-13: raw float32 values** (P3-6, P3-10, P3-34) · minor
`get_morph_value` and `set_expression` return 0.800000011920929 for 0.8. Round for display, or document.

**F-14: 0-1 colors truncated to 0-255** (P2-56) · minor
`set_ambient` 0.3 / 0.1 stored as 76/255 = 0.298 and 25/255 = 0.098 (truncated, not rounded). Round to nearest.

**F-15: `delete_avatar` on an empty scene** (P2-2, P2-16) · minor
Errors instead of reporting nothing to delete, while `list_avatars` / `get_avatar_info` return a normal message.
A named delete on an empty scene says "No avatars in scene", not "Avatar not found: <name>".

**F-16: subdivision refusal** (P2-11) · doc
"Requested level 2 exceeds the mesh's max subdivision level 0" should add: run Modify > Subdivide in CC5 first.

**F-17: `describe_character`** (P3-1, P3-25) · minor
Built only from morph values: a template ("average build", 2 identity morphs) and heavy at 50% both read
"average build". Skin, eyes, hair and clothing are not described.

**F-18: `reset_expression` count** (P3-35) · minor
Reports 172 (all sliders) after only 2 were set. Report the number changed, or say "all".

**F-19: `search_content` misses eye presets** (P4-19) · gap · fixed with F-33; live: `search_content` "green" in `eye` found both green presets (P4-82)
"eye green" and "iris" found nothing; presets are in `Reallusion Templates/Actor/Eye/` (`.ccEye`). Fixed: an `eye`
category (`EContentRootFolder_Eye`) in `browse_content` and the `search_content` defaults.

**F-20: `search_morphs` IDs and duplicate names** (P3-2) · doc / runbook
The search matches IDs (`pack_jaw10` = "Neck Front Smooth"), and "Jaw Height", "Jaw Outer Define", "Jaw Scale"
("Jaw  Scale" with a double space) each appear twice with different IDs. Use IDs in scripts and the runbook.

**F-21: error wording** (P3-8, P3-38, P2-58, P2-13, P2-52) · minor
"Avatar not found", "Light not found", "Item not found", "Unknown morph ID", "File not found", "IBL image not
found". Unify on "<thing> not found: <name>".
Also "Unknown shader parameter: Not_A_Param" (P4-121), which, unlike "Material not found" (P4-70), lists no valid
names: suggest close matches or point to `get_shader_parameters`.
Also (P5-29) `load_asset` on a `.png` says only "Disallowed file extension: .png" (`src/tools/asset.ts:28`,
`cc5_api.py:69` and `:428`). Point to the right tool for images: `load_texture` for a material map,
`apply_skin_overlay` for a skin overlay. The same applies to other near-miss extensions (`.jpg`, `.tga`, `.fbx` →
`import_fbx`, `.obj` → `replace_mesh_from_obj`).

**F-22: `capture_viewport` default path** (P2-23) · minor
Without a path it always writes `%TEMP%\cc5_viewport.png`, overwriting the last capture.

**F-23: `check_cc5_connection` and dialogs** (P1-6, P1-7) · doc
`/health` bypasses the command queue, so it reports "connected" while a dialog blocks every command. Say so in the
description, or add the open dialog (`/dialog`) to the check.

**F-24: changes that cannot be read back** (P2-21, P2-59, P2-61) · gap
`get_visual_settings` does not report the IBL image; no tool reads an item's visibility; `frame_camera` only
acknowledges. Only screenshots confirm these.

**F-25: camera position after the home view** (P2-27) · retest
`get_camera_info` reported (-677.6, 2.6, 87.8), a side position, right after `frame_camera("home")`; a later
home view framed correctly from the front (P2-66). Retest: home view, then `get_camera_info`.

**F-26: home view cropped the feet** (P2-66) · retest
With the 105 mm `.ccCam` lens loaded earlier, the home view cut Kevin off mid-shin. With the default 80 mm
viewport preset, the home view shows the feet (P4-66). Probably the lens; retest.

**F-27: `set_light_shadow` validation** (P2-51) · minor
The MCP schema makes both settings optional, so an empty call reaches CC5 before being refused. Validate in
TypeScript.

**F-28: presets stop on "Replace / Material Only"** (P4-27, P4-44, P4-52) · gap
Even on a freshly loaded Kevin, an eye preset asks. Interactive use is handled (F-03), but recipes and batch runs
will stop on it every time. Add a `load_asset` option (e.g. `if_layer_exists: "material" | "replace"`) that
answers this dialog by policy.

**F-29: runbook placeholders** (P3-7, P3-9, P3-12) · runbook
"‹first jaw ID›" / "‹second jaw ID›" were read two ways. Give literal IDs.

**F-30: value checks need a tolerance** (F-13, F-14) · runbook
Compare floats to about 0.004 (one 0-255 step) or round to 3 decimals.

**F-31: worn accessory selection** · retest
The reviewer's open question: whether a worn accessory resolves to one item or a duplicate name. Kevin has no
accessories; worn clothing (Boxers) resolved to one item. Retest on a character with an accessory.

**F-32: stale tool schema in Claude Code** · minor (environment). Seen again after the F-33 restart: `search_content`
still showed "Hair is not a searchable category" while the server searched hair. Call with explicit options.
After the MCP server restarts, the `load_asset` schema Claude Code showed had no `target` option, while
`build/tools/asset.js` has it and the server runs `build/index.js`. The dialog tools loaded fine. Check whether
Claude Code caches tool schemas across restarts.

**F-33: hair could not be loaded** (P4-77) · blocker · fixed
"Apply a short cropped hairstyle to Kevin": all 233 hairstyles under `Reallusion Templates/Hair` are `.rlHair`, and
`load_asset` refused them ("Disallowed file extension: .rlhair") before reaching CC5. `search_content` and
`browse_content` had no hair category. Fixed: `.rlHair` is character content in `load_asset` (TypeScript and
plugin), aimed at the target character; a `hair` category (`EContentRootFolder_Group`, the `Hair/Group` folder;
CC5 has no `EContentRootFolder_Hair`) lists `.rlHair` files; the create_character prompt no longer says hair is
not searchable. Live (P4-78 to P4-81): `search_content` "buzz cut" in `hair` found Buzz Cut and Afro Buzz Cut; `load_asset`
applied Buzz Cut to Kevin with no dialog (he had no hair); `list_hair` shows `Buzz_Cut`; a 4K face capture shows
the cut. `EContentRootFolder_Group` does resolve to `Hair/Group`.

**F-34: presets override more than they are named for** (P4-87 to P4-91) · gap
"Red Velvet" (`.ccSkinGenPreset`, lip makeup) made Kevin's lips red, but his Buzz Cut hair and eyebrows stopped
rendering (meshes still listed; `set_item_visible` did not bring them back) and the skin lost the `set_skin_color`
tone. Chad: a known CC5 complication; presets, especially Reallusion store content, override things you want to
keep. `load_asset` said only "Asset loaded". Fix ideas: capture and compare before/after around character presets
(hair, brows, skin, eyes, morph count) and report every change beyond the intended one, offering `undo`; at minimum,
say in `load_asset`'s description that presets can override other parts of the character.
Chad (2026-10-05): this must be baked into the MCP as protocol: every preset load checks before/after and
reports what else changed, not left to the agent's judgment.

**F-35: material property read-back** (P4-93 to P4-95) · bug
`set_material_opacity` 0.3 on `Std_Skin_Body` applied (the torso vanished in the viewport) but
`get_material_properties` still reported Opacity 100. Same pattern as F-08 (keyed value vs base value); fix together.
Also: 0.3 rendered as fully invisible, not 70% see-through; the viewport probably treats skin opacity as a cut-off.
Chad: a CC5 quirk; the control that makes a change happen is often buried in another feature (layered controls).
Find which layer decides partial transparency (material/shader mode) before treating this as an MCP bug.

**F-36: opacity scales differ** (P4-92 to P4-94) · minor
`set_material_opacity` takes 0.0-1.0; `get_material_properties` reports 0-100 (Opacity 100, Glossiness 20,
Specular 100). Use one scale (0-1, like the color tools) in both.

**F-37: opacity undo and a lagging read-back** (P4-96 to P4-98) · bug
Opacity read back: 100 before the set; 100 right after `set_material_opacity` 0.3 (torso already invisible); after one
`undo`, 0.30000001192092896 (0-1 scale, raw float) while the torso stayed invisible. So the undo did not revert the
opacity (what it reverted is unknown), and the getter returns values from different sources/steps. Same family as
F-08, F-09, F-35, F-36: material changes are made as keys, and neither undo nor the getters handle them reliably.
Workaround: set the value back explicitly and check the viewport.

**Correction to F-35 / F-37** (P4-99) · setting opacity back to 1.0 did not bring the torso back either. The
full body was never captured between the Red Velvet lip preset (P4-88) and the opacity change, and the first
full-body view after the preset already showed the torso and Boxers missing. So the missing torso may be a preset
side effect (F-34), not opacity; whether `set_material_opacity` and its undo work is unknown. Retest on a freshly
loaded Kevin: capture, opacity 0.3, capture, read back, opacity 1.0, capture, read back.

**Retest on a fresh Kevin (P4-100 to P4-103) resolves F-35 / F-36 / the Boxers.** Baseline read 100 / 20 / 100.
Opacity 0.3: torso vanished, Boxers stayed (so the missing Boxers were F-34), read back 0.30000001192092896.
Opacity 1.0: torso still invisible, read back 1. Cause (`cc5_api.py`): `set_material_opacity`, `set_material_glossiness`
and `set_material_specular` passed their 0-1 value straight to `AddOpacityKey` / `AddGlossinessKey` /
`AddSpecularKey`, but CC5 uses 0-100, so 1.0 meant 1%. Fixed: the setters scale to 0-100 and
`get_material_properties` reports 0-1 (rounded to 3 decimals). F-37 (opacity undo) still needs a retest.

**Live check after the F-36 fix (P4-104 to P4-108).** Baseline read 1 / 0.2 / 1. Opacity 0.3 read 0.3 and cut the
torso out (the skin shader treats low opacity as a cut-out, not a blend: a CC5 layered-controls behavior); opacity 1.0
restored it and read 1; opacity 0.3 then one `undo` restored it (F-37 not a bug).

**F-38: glossiness and specular do nothing on skin** (P4-108) · bug
`set_material_glossiness` 0.8 and `set_material_specular` 0.5 on `Std_Skin_Body` reported success, but
`get_material_properties` still read 0.2 / 1 and the viewport did not change. Likely cause: Kevin's skin uses the
Digital Human skin shader, whose shine comes from shader parameters (`set_shader_parameter`), so the legacy
material-level values are ignored or not stored. Fix: verify the value after setting and fail if it did not take;
say in both descriptions that Digital Human materials use `set_shader_parameter`. Confirm on a non-skin material.

**Correction to F-38 (P4-109, P4-110).** Setting glossiness 0.8 again and reading back gave glossiness 0.8 and
specular 0.5, the values set in P4-108. So the setters do store; the read-back lags one step for glossiness and
specular (opacity read back at once). Open: whether the getter lags or CC5 commits late, and whether glossiness and
specular have any visible effect on Digital Human skin (P4-108 capture showed none).

**F-38 specular check (P4-111 to P4-113).** Specular 0 then two reads: 0.5, 0.5 (not a lagging read). Re-setting
glossiness did not bring it through either. Specular 0.25, read: 0.5; re-set glossiness, read: 0.5. So specular stored
one value (0.5, from P4-108, first seen in P4-110) and ignored later ones. RLPy lists `AddSpecularKey(self, *args)`
(overloaded); a probe should call `AddSpecularKey` / `GetSpecularWeight` / `AddGlossinessKey` directly through
`exec_python` (CC5 started with `CC5_ALLOW_EXEC=1`). Kevin's skin is left at glossiness 0.8, specular 0.5.

**F-38 resolved in principle (Chad, 2026-10-05).** CC5 uses PBR metallic/roughness. Skin shine is the texture's
Roughness section in Modify > Materials, which matches the Digital Human shader parameters 1:1 (`get_shader_parameters`
on `Std_Skin_Head`: `Keep Original Roughness` 0, `Original Roughness Strength` 0.85, `Cavity Strength` 1,
`Micro Roughness Scale` 0.1, `Nose` 0, `Mouth` -0.05, plus per-region scales and `_Specular` 0.45). Specular only
affects the highlight, a barely visible change. Fix: say in `set_material_glossiness` / `set_material_specular` that
they are legacy and point to the roughness shader parameters; consider a `set_skin_roughness` shortcut across the four
skin materials (like `set_skin_color`). The erratic specular storage (P4-111 to P4-113) is still worth a probe.
Live (P4-114 to P4-119): `Original Roughness Strength` 0.4 on the head alone left a seam at the shoulders; on all four
skin materials it gave an even glossy look. `_BaseColorMap Brightness` 0.1 on the head alone left a seam at the neck.
So the shortcut should be general: `set_skin_shader(parameter, values)` applied to Std_Skin_Head/Body/Arm/Leg together.

**F-39: texture loads cannot be undone** (P4-126 to P4-129) · bug
`load_texture` Blend_01.jpg into `Std_Skin_Body` diffuse replaced the torso skin; one `undo` reported success but the
texture stayed, and the eye shader changes made before it were intact, so what the undo reversed is unknown. The
load is wrapped in BeginAction/EndAction (`cc5_pipeline.py:550`), so CC5 itself does not record `LoadImageToTexture`
in its undo history. Fix: warn in the description; better, record the material's current texture path first (check
`GetShaderTextureNames` / texture path APIs) so the change can be reversed. Workaround: reload the character.

**F-40: `list_clothes` shows a raw type number** (P5-1) · minor
`list_clothes` on clean Kevin returned `- Boxers (ID: 4173611991808, Type: 1)`. The `Type: 1` is CC5's internal enum
value and means nothing to the user. Wanted (Chad, 2026-10-05): list what is applied, by name (with a readable type
if one is shown), or return "No clothes are applied" when nothing is worn (today: "No clothing items on the avatar.").
`list_hair` prints the same raw `Type:` (`src/tools/content.ts:37`); fix both the same way.
P5-28: the number is not a garment kind either: Boxers 1, Slim Jeans 1, Canvas shoes 2, Basic T-shirts 4,
Ankle_socks 4. Find what the enum really is (check RLPy's cloth type enum) before naming it; if it has no useful
meaning to the user, drop it and list names only.

**F-41: `cloth_upper` browses the wrong folder** (P5-7) · bug
`browse_content("cloth")` listed 13 full-body outfits (Templates/Cloth/Full-body), but `browse_content("cloth_upper")`
returned "No content files found", although Templates/Cloth/Shirts and Templates/Cloth/Coats hold dozens of `.ccCloth`
files (Basic T-shirts, Biker Vest, Punk Leather Jacket, Business Suit...). Cause: `cc5_api.py:2078` maps `cloth_upper`
to `EContentRootFolder_Upper` and `cloth_lower` to `EContentRootFolder_Lower`; those sit among the body/morph folder
enums, not the clothing ones. CC5's clothing enums are `_Shirts`, `_Coats`, `_Pants`, `_Skirts`, `_Underwear`,
`_Gloves`, `_ClothOthers`, `_FullBody`, matching the folders on disk. Fix: `cloth_upper` → Shirts + Coats,
`cloth_lower` → Pants + Skirts (browse_content must accept several enums per category); consider adding `underwear`,
`gloves` and `cloth_other` (Others holds the outfit sets: Aaron, Mila, Light Armor...). Check `search_content` uses the
same mapping. A Python test should pin each category to its enum(s).
Workaround for the rest of the run (Chad, 2026-10-05): load upper/lower clothing by its file path under
`C:/Users/Public/Documents/Reallusion/Reallusion Templates/Cloth/` (Shirts, Coats, Pants, Skirts).

**F-42: accessory categories browse only Accessory/Others** (P5-12) · bug
`browse_content("accessory_head")` returned 8 files, all from Accessory/Others (Earings, Goggles, Gun, Helmet, Bow,
Arrow, Quiver, Viking Axe): a gun and an axe are not head accessories. On disk, Accessory/ holds Head (11: Beret,
Hats...), Torso (20), Arm (47), Leg (0) and Others (8). Cause: `cc5_api.py:2083-2084` map both `accessory_head` and
`accessory_body` to `EContentRootFolder_AccessoryOthers` (the comment says no head/body enum exists), but RLPy has
`EContentRootFolder_Head`, `_Torso`, `_Arm`, `_Leg` (rlpy-api-reference.md:508-511), listed with the clothing enums.
Fix with F-41: verify live that `_Head`/`_Torso`/`_Arm`/`_Leg` resolve to the Accessory folders, then
`accessory_head` → Head, `accessory_body` → Torso + Arm + Leg, and add `accessory_other` → Others.

**F-43: `wrinkle_mask` empty; `texture` capped** (P5-13 to P5-15) · bug
`browse_content("wrinkle_mask")` → "No content files found". `EContentRootFolder_WrinkleMasks` lists nothing on this
install, while wrinkle content exists elsewhere: Actor/Expression Wrinkles (45, `.rlWrinkle`), Skin/Normal
Effects/1_Facial Wrinkle (42, `.ccSkinGenPreset`) and Others/Skin Textures/Wrinkle References (18 `.png`). Find out
which folder CC5's Wrinkle Masks library really uses (check `GetContentFolder` for the enum) and what
`apply_skin_overlay` expects there. `browse_content("texture")` said "200+" (the MAX_BROWSE_RESULTS cap); the folder
holds 437 images, so the count is a floor, not a total. The cap note already points to `search_content`; consider
returning the true total alongside the capped list.

**F-44: no collision check or fit correction after applying items** (P5-26, P5-34) · gap
Chad spotted Kevin's scalp poking through the front of Hat_DarkBlue (the skin-coloured patch on the crown, P5-34
face capture). Claude read the patch as a logo and reported the load as clean: a capture alone did not catch it.
Wanted (Chad, 2026-10-05): after items are applied, a collision check; and the ability to correct it.
Check: capture face and body from several views (front, sides, back; `frame_camera`) after each load and look for
skin through cloth or hats, then report it. RLPy has no penetration test, so the check is visual unless CC5's
collision calculation can be read.
Correct: RLPy exposes, for clothes, `RICloth.SetClothConformingEnable` / `SetClothConformValue(name, value)` /
`CalculateCollision()` (rlpy-api-reference.md:2835-2839); for accessories, `RIAccessory` has only
`TransferSkinWeight` plus the `RIObject` transform (move/rotate/scale, e.g. enlarge or raise a hat). CC5's UI tools
(Conform / Collision Shape, Hide Inner Mesh / Hide Body Mesh by Cloth) need checking against RLPy. Proposed tools:
`check_fit` (multi-view capture), `conform_cloth` (conform + collision recalc) and `adjust_accessory`
(offset/scale), each one undo step.

**F-45: `frame_camera` reports moves it did not make** (P5-47 to P5-50) · bug
`frame_camera("left")` framed a tight side close-up of Kevin's hips, not a side view of the body. The next
`frame_camera("home")` returned "Camera framed to 'home' view.", but the capture after the hat removal still showed
the same hip close-up. `"face"` then worked, and `"home"` after `"face"` gave the full body. So a view right after
`"left"` can be silently skipped, and the tool's message is not evidence (same pattern as F-25 / F-26). Fix: read the
camera back after the move (`get_camera_info`) and fail if it did not change; check how `"left"` picks its target
(it may frame the selected object, which was the Boxers just loaded).
P5-56 to P5-59 support that: with the Oval Afro just loaded (and so selected), `"right"` and `"back"` framed the
head, not the body. So the side/back views frame the selection; say so in the description, or frame the character.
Reproduced (P5-60): `"home"` right after `"back"` also reported success and did not move; so `"home"` fails after any
side/back view and works after `"face"`. Workaround: `"face"`, then `"home"`.
Cause found (P5-61 to P5-63): every view frames the **selected object**. With the Oval Afro selected (load_asset
selects what it loads), `"home"` framed the head; after `select_objects(["Kevin"])`, `"home"` framed the full body.
So the earlier "did not move" cases were the camera re-framing the same selected item. Fix: `frame_camera` selects the
character (or takes a `target`) before framing, and restores the selection after.

**F-46: removing an item cannot be undone** (P5-67 to P5-69) · bug
`remove_scene_item("Oval Afro")` (P5-64), then `undo` → "Undo successful", but `list_hair` still returned "No hair
items" and the face capture still showed Kevin bald; clothes (Boxers) and accessories (none) were unchanged, so what
the undo reversed, if anything, is unknown. `remove_scene_item` wraps `RLPy.RScene.RemoveObject(item)` in
BeginAction("Remove Item")/EndAction (`cc5_api.py:2035-2042`), so as with F-39 CC5 does not record `RemoveObject` in
its undo history. `undo` also reports success whether or not anything changed. Fix: say in `remove_scene_item` that
it cannot be undone and that the item must be loaded again from its file (record the source path at load time so it
can be restored); make `undo` report what it reversed, or at least not claim a change it cannot see.
Workaround: load the item again (`load_asset` with the same file).

**F-47: test input files missing** (P5-72) · doc / runbook
`import_fbx("C:\CC5Test\inputs\cube.fbx", "prop")` → "Import failed: File not found". The whole
`C:\CC5Test\inputs\` folder is missing (`C:\CC5Test` holds only `exports\screenshots`). So earlier "wrong file"
steps that named files there (P4 `load_texture` with notes.txt / missing.png, P5-29 overlay.png, P5-30
nothing.ccShoes) only partly tested what they meant to: overlay.png was refused for its extension before any file
check, but notes.txt could only ever return "not found", never a type refusal, and a real FBX import has not been
tested. P5-85: `skinned_top.fbx` (a garment skinned to Kevin's skeleton) is also missing, so a successful clothing
import is untested. Fix: add a setup step to the runbook that creates `C:\CC5Test\inputs\` with the fixtures (a small cube.fbx,
an overlay.png, a notes.txt), or ship them in the repo (e.g. `tests/fixtures/flight/`) with a copy script.

**F-48: `import_fbx` works; description outdated; props cannot be placed** (P5-73 to P5-79) · doc + gap
`import_fbx("C:\CC5Test\inputs\box_01.fbx", "prop")` returned "Still running" (job), CC5 opened "Import Settings"
(FBX fps note, project 60 fps; buttons Convert All / Cancel); `get_cc5_dialog` read it, `answer_cc5_dialog("Convert
All", expect="FBX Import Settings")` clicked it (a plain confirmation of the asked import), then a brief "Updating user
interface ..." window (no buttons, correctly not a question) and `job_status` → success, `LoadFbxFile(path, option)`.
`get_scene_objects` lists the prop `box_01`. The box sits centred on the origin at real scale (looks like Blender's
default 2 m cube): its top is at Kevin's waist and he stands buried inside it. Doc: the `import_fbx` description and
its "still running" message still say "answer it in CC5"; point to `get_cc5_dialog` / `answer_cc5_dialog`. Gap: no
tool moves, rotates, scales or deletes a prop (`remove_scene_item` covers worn items, `delete_avatar` avatars), so the
box cannot be put beside Kevin or removed. Proposed: `set_object_transform(name, position, rotation, scale)` and
`delete_object(name)` for props, each one undo step (check F-46: `RemoveObject` may not be undoable).
P5-80/81: `undo` after the import → "Undo successful", but `box_01` stayed (scene list and capture), so an FBX
import cannot be undone either (same as F-39 / F-46). P5-82: `exec_python` (`RScene.RemoveObject` on `box_01`) was
refused, "/exec/python disabled" (CC5 not started with `CC5_DEV_MODE` / `CC5_ALLOW_EXEC`). With no delete tool, the
box can only be removed by hand in CC5. `delete_object` is a blocker for any prop workflow.

**F-49: add a "Delete object" tool** (Chad, 2026-10-05; P5-80 to P5-82) · blocker
Requested for the toolkit. Today nothing removes a scene object: `remove_scene_item` covers worn clothes, hair and
accessories only, `delete_avatar` only avatars, `undo` does not reverse an import (P5-81), and `exec_python` is off
by default. The imported `box_01` could only be deleted by hand in CC5.
Spec: `delete_object(names)`. Resolves names the way `select_objects` does (`cc5_scene.py`: props, lights,
cameras, avatars, worn items); refuses unknown or ambiguous names and changes nothing; refuses the Preview Camera
(CC5 has no other camera, see the camera troubleshooting row) and asks before deleting an avatar (same confirmation
rule as `delete_avatar`). Calls `RLPy.RScene.RemoveObject` inside BeginAction("Delete Object")/EndAction, then
re-reads the scene and reports what is gone. Its description must say it cannot be undone (F-46: CC5 does not record
`RemoveObject`); for a loaded item, say which file restores it. Python tests with the fake RLPy; TS tool in
`src/tools/selection.ts` or a new `scene` tool file; CLAUDE.md tool table.

**F-50: `import_fbx` clothing ignores which character is meant** (P5-83) · bug
`import_fbx(kind="clothing")` takes `cc5_api.get_first_avatar()` (`cc5_pipeline.py:415`) and has no `target`
parameter, so with several characters it dresses the first one whatever is selected. `load_asset` already solves this
for character content with `_pick_target_avatar(target, ext)` (named target, else one selected character, else the
first; refuses duplicates and several selected). Fix: give `import_fbx` the same optional `target` and reuse
`_pick_target_avatar`. Wider: `get_first_avatar()` is called in about 46 places in `cc5_api.py` / `cc5_pipeline.py`
(e.g. `remove_scene_item`, `cc5_api.py:2021`, and the list_* tools); audit which tools act on "the" character and
give them the same targeting before multi-character scenes are tested.
Batch A review: the new `set_eye_color` and `set_skin_shader` also act on the first character; include them in
that audit.
Confirmed working (P5-83/84): an unskinned box as clothing is refused with the skinning explanation; CC5 itself
reported success, and the tool caught it by comparing worn items before and after. Nothing was added.

**F-51: CC5 crashed during an FBX prop import** (fix-round probe, 2026-10-05 ~16:00) · bug
Fresh CC5 session started with `CC5_ALLOW_EXEC=1`; CC4 Kevin loaded; four read-only `exec_python` probes (content
folder enums, cornea shader parameters, RGlobal/object method lists, the Shadow Catcher's transform via
`GetControl("Transform").GetValue`). Then `import_fbx("C:\CC5Test\inputs\box_01.fbx", "prop")` → job, "Import
Settings" dialog, `answer_cc5_dialog("Convert All", expect="FBX Import Settings")` clicked; the next `job_status` got
ECONNRESET and the CharacterCreator.exe process was gone. No crash dump or bridge log found. The same file and steps
worked in the earlier session (P5-73 to P5-77; that time Kevin had been in the scene a long while and no exec probes
had run). Matches the known pattern "the first FBX export of a CC5 session crashes most of the time" (CLAUDE.md,
Task 18): this was the first FBX operation of the session. Next: retest the import as the first FBX operation of a
clean session without exec probes, then with; if it is first-FBX-of-session, document it with the export crash and
consider a warning in `import_fbx`.

**F-52: the recovery prompt blocks unattended runs** (after F-51, 2026-10-05 16:01) · blocker
After the F-51 crash, the relaunched CC5 sat on "Unsaved project data found ... OK / Cancel" and every command
waited; by design (CLAUDE.md, `answer_dialog`'s fail-closed rule) only the user could answer it. Chad: "This needs to
be solved. Having Claude run this autonomously is part of the problem." Decision (Chad, 2026-10-05): when Claude
launches CC5, the prompt is answered **Cancel (discard)** automatically. Cleared by hand this time through
`exec_python` (found the modal, checked its label text, clicked Cancel).
Design: an env var `CC5_RECOVERY_ANSWER` = `cancel` | `ok` | `ask` (default `ask`, today's behaviour, for a CC5
started by hand). The Claude launcher (`scripts/cc5-restart.ps1` and the documented bash launch) sets `cancel`. The
plugin's dialog lane (`process_dialog_lane`, 50 ms timer, runs from startup) recognises the prompt with
`_is_recovery_prompt`, clicks the configured button directly (`_click_now`), and records it (title, text, button,
time) so `get_cc5_dialog` / `check_cc5_connection` report "recovery prompt answered: Cancel (discarded unsaved
data)". `answer_cc5_dialog` may then answer the prompt only when the policy is not `ask`. Update CLAUDE.md (modal
dialogs, dialog lane, restart procedure), `.claude/rules/cc5-dev.md`, the README's known issue, and the tests in
`tests/py/test_dialogs.py`.

**F-53: `capture_viewport` adds an undo step** (fix-round probe, 2026-10-05 ~16:10) · blocker
Root cause of F-46, and most likely of F-39, F-09 and the P5-80 box undo: in each case a `capture_viewport` ran
between the change and the `undo`. Live (fresh session, Kevin + Oval Afro): remove → undo brought the afro back;
remove → `frame_camera` → undo: back (camera moves record nothing); remove → `select_objects` → undo: back;
remove → `capture_viewport` → undo: still removed, a second undo brought it back. So a capture is exactly one undo
step. Isolated: `cc5_api._set_render_resolution(1280, 720)` alone also takes one undo step; it calls
`RGlobal.SetRenderExportParameter`, which CC5 records. `RenderImage` itself records nothing.
Other probe results: prop move/scale through `GetControl("Transform").SetValue(time, RTransform(scale, rot, pos))`
inside BeginAction/EndAction works (Box_001: x 0 → 150 cm, scale 1 → 1.5) and one `undo` reverses it; prop delete
with `RScene.RemoveObject` also undoes cleanly. So F-48 / F-49 tools can be one undo step each.
Fix: `_set_render_resolution` reads `GetRenderExportImageParameter()` first and calls `SetRenderExportParameter`
only when the size differs, so captures at the usual size add no undo step; say in `capture_viewport` that a size
change is recorded once. Then retest F-09, F-39 and F-46.

### Batch A live check (2026-10-05, after reinstall; commit 5c90be0 plus the corrections below)

CC5 started with `CC5_RECOVERY_ANSWER=cancel CC5_ALLOW_EXEC=1`, clean CC4 Kevin.
- F-52: the recovery prompt appeared and was answered Cancel by the plugin at 16:42:28; `get_cc5_dialog` reported
  it. Nobody touched CC5.
- F-53, corrected: the 5c90be0 fix (set the render size only when it changes) was not enough. Probes: a bare
  `RenderImage` is itself one undo step; `SetRenderExportParameter` alone is one step; a size change followed by
  `RenderImage` is ONE step together. A first correction undid two steps for a size change plus a render and also
  undid the user's removal (the afro came back). Final fix: `capture_viewport` undoes exactly one step when it
  changed the size or a render wrote the file (`_drop_capture_undo_steps`), never more. Live: remove afro ->
  capture at a new size -> capture at the same size -> afro still removed -> one `undo` -> afro back.
- F-43, corrected: the Wrinkle Mask folder does exist on disk (14 PNGs); CC5's `GetContentFilesInFolder` lists none
  of them, so the parent-folder fallback found nothing. Now an empty CC5 listing for `wrinkle_mask` is replaced by
  the image files on disk (`RApplication.GetTemplateDataPath()` + the `$/` folder). Live: 14 files.
- F-45, completed: framing the selection was half of it. CC5's Home keeps the camera's current direction and only
  re-fits, so "home" right after "left" stayed a side view; "home" now turns to Front first. Live: hair selected ->
  "home" framed Kevin's full body and the hair stayed selected; "left" -> full-body side view; "home" -> front.
- F-41/F-42: cloth_upper 107 files (Shirts + Coats), accessory_head the 11 hats and glasses.
- F-10: Iris Color on both corneas gave visibly green eyes; one `undo` (after a capture) restored them.
- F-38: `set_skin_shader('Original Roughness Strength', [0.4])` gave an even gloss on head, body, arms and legs
  (no seam); one `undo` restored it.
- F-48/F-49: Box_001 at the origin -> `set_object_transform` (80, 0, 0) cm, scale 0.5, read back and seen beside
  Kevin -> `delete_object` deleted it; Kevin and the Preview Camera were refused -> one `undo` brought the box back
  at (80, 0, 0), scale 0.5.
- Seen on the way: `get_selection` shows worn hair as "Other (type 0)": CC5 does not report hair as
  `EObjectType_Hair`, which is why `delete_object` decides by where an item was found, not by its type.

### Batch B retests (2026-10-05, fresh CC5 with the 6523971 plugin)

Each change was followed by a `capture_viewport` before the `undo`, the step that used to break it (F-53).
- F-08: `set_diffuse_color` (0.2, 0.4, 0.9) on Std_Skin_Body turned the torso blue and `get_diffuse_color` read
  back (0.200, 0.400, 0.898) (0.898 = F-14). The P4 white read-back did not come back; P4 had presets and earlier
  captures in play, so it is recorded as not reproduced.
- F-09: one `undo` restored the skin.
- F-39: `load_texture` Blend_01.jpg into Std_Skin_Body diffuse, capture, one `undo`: the skin texture came back.
  So texture loads are undoable; the P4 failure was the capture's undo step.
- Undo reporting what it reversed: not possible, RGlobal has only Undo / Redo / BeginAction / EndAction (no
  history read). With F-53 fixed, undo reverses the last change.

### Batch B live check (2026-10-05, 25d8319 installed, CC5 relaunched with CC5_RECOVERY_ANSWER=cancel)

- F-14: `set_ambient` 0.32 stored as 0.322 (82/255, nearest; truncation gave 0.318). 0.3 / 0.1 / 0.9 are exact
  half-steps (76.5, 25.5, 229.5), so they land on 0.302 / 0.102 / 0.902 now. Two undos restored the ambient.
- F-13: `set_expression` Brow_Raise_Inner_L 0.8 read back as 0.8.
- F-18: `reset_expression` -> "Reset 1 expression slider(s) to neutral: Brow_Raise_Inner_L."; again -> "The face was
  already neutral".
- F-24: Boxers hidden / shown -> "CC5 cannot report this item's visibility" (no IsVisible on worn items).
  Box_001 hidden -> "(CC5 confirms)", and the capture showed it gone; shown -> "(CC5 confirms)". So `IsVisible`
  follows `RScene.Hide/Show` on props (the review's open question). `set_ibl` Birchwood.hdr ->
  `get_visual_settings` "IBL image last loaded by set_ibl: ...Birchwood.hdr (CC5 cannot report the current image;
  it may since have been undone or replaced in CC5)"; one undo reverted the load.

**F-54: CC5 crashes on its own soon after launch** (Batch C live check, 2026-10-05 ~19:05-19:08) · bug (CC5)
CC5 was launched with `CC5_RECOVERY_ANSWER=cancel CC5_ALLOW_EXEC=1`; the bridge answered `/health` after 22 s. The
first MCP call, about 2-3 minutes later (19:08:02), got ECONNREFUSED and the CharacterCreator.exe process was gone;
nothing had been sent to CC5 in between. Chad: "CC5 has a tendency to crash on first launch attempt. I would try
again." The second launch was watched for 120 s after the bridge came up and stayed up. This may also explain
F-51 (the crash during an FBX import a few minutes into a fresh session). Proposed: `scripts/cc5-restart.ps1` (and
the documented bash launch) wait about two minutes after the bridge answers, check that the process is still
running, and relaunch once if it died (the recovery prompt that follows is answered by `CC5_RECOVERY_ANSWER`).
Chad (2026-10-06): the crash happens when CC5 goes from loading the plug-ins and the back end to loading the UI;
once the UI has loaded, CC5 has started correctly and there is no need to wait. The bridge answers `/health` before
that point (the plug-in starts it while the back end loads), so `/health` alone does not show a safe start. The UI
is up when CC5's main window is showing: live, `exec_python` listed a visible `QMainWindow` titled
"Character Creator 5 - Default.ccProject" two minutes after launch. Revised proposal: the launcher waits for that
window (for example a `ui_ready` flag the plug-in's main-thread timer sets and `/health` reports), relaunches once
if the process dies before it, and does not wait after it.

### Batch C live check (2026-10-05 19:10-19:23, workflow: six sequential CC5 steps, two verifiers each, critic)

All six steps passed and all 12 verifier verdicts confirmed (0 refuted). L1: `get_cc5_dialog` showed the recovery
prompt answered Cancel at 19:10:05 (F-52 live again after the F-54 relaunch); `delete_avatar` on the empty scene ->
"The scene has no characters: nothing to delete."; named -> "Avatar not found: Kevin (the scene has no characters)";
`check_cc5_connection` -> "connected and ready". L2: CC4 Kevin -> "average build (no body-shape slider set: ...)",
"Wearing: Boxers", "Hair: none", "Accessories: none"; heavy 50% -> "slightly heavy build"; one undo restored it;
subdivision 2 -> the Modify > Subdivide refusal. L3: .jpg and .fbx load_asset hints, shader close match
("Original Roughness Strength"), "Item not found: nope. Worn now: Boxers.", "Morph not found: ...", F-27 refusal.
L4: two captures -> two files in %TEMP%\cc5_captures with 13-digit names; the restarted MCP server shows the Batch C
descriptions. L5: an exec_python QMessageBox -> 409 with a job id; `check_cc5_connection` reported the open dialog;
`answer_cc5_dialog` OK; `job_status` -> "closed". L6: clean Kevin, Boxers only.

Follow-up probes (main loop, same session): undo -> capture -> redo: "Redo successful" but the heavy preset did not
come back (F-55). heavy 50% -> `delete_avatar("Nobody")` -> undo: the preset was undone, so a failed named delete
records no empty step. A 3840x2160 capture through exec_python: 8.95 MB, returned with base64 (the >10 MB path needs
8K, F-58). `check_cc5_connection` during an 8 s exec sleep: "connected." plus the 3 s fallback line; the exec output
contained "GET /health 200" from an HTTP thread (F-57). A non-blocking QMessageBox no command waits on: the check
reported it; `list_avatars` failed after ~5 s with "answer or close it in CC5" (F-59). A non-blocking QProgressDialog
("Cancel" only): reported as "a dialog open, and commands wait until it is answered ... Buttons: Cancel" (F-56).
`get_morph_value("not_a_real_morph")` -> "current value: 0" (no not-found check); `set_skin_shader` with a typo -> no
close matches; `set_item_visible("nope")` -> "Item not found: nope" with no hint (F-21 left).

**F-55: redo after a capture** · bug. A capture records one CC5 undo step and undoes it at once (F-53), so the
capture sits in the redo slot, and CC5 dropped the user's undone change from redo when the capture was recorded.
`redo` then replays the invisible render and says "Redo successful". Fix: the plugin remembers that the redo slot
holds a capture and `redo` refuses with a plain message instead of calling CC5 (an undo through the MCP makes redo
normal again). Redo of something undone in CC5 itself is not visible to the plugin.

**F-56: progress windows reported as questions** · bug. `get_dialog` (server.py) does not drop progress windows the
way `_note_command_dialog` does, and `answer_dialog` would click their Cancel. Fix: report a progress window as
"CC5 is busy" with the rule not to cancel it unless the user asks.

**F-57: request log filter** · bug. `BridgeHandler.log_message` tests `args[0]` (the request line) instead of the
status code, so every request is printed from an HTTP thread into CC5's Python stdout (and into a running
exec_python's captured output, since it redirects sys.stdout process-wide). Printing from non-main threads into CC5's
console is a crash candidate for F-51 / F-54. Fix the filter to log only non-2xx/3xx.

**F-58: large captures** · bug. For a render over MAX_IMAGE_BYTES (10 MB) the plugin returns the path without image
data and a warning; the TypeScript tool then takes a PowerShell screenshot of the whole primary screen and copies it
over that file (Batch C pointed the fallback at result.path), so the real render is destroyed and the warning lost.
tests/tools/scene.test.ts mocks exactly that reply without mocking execSync, so every npm test screenshots the
desktop. Fix: return the path and the warning; take a screenshot only when there is no file; mock it in tests.

**F-59: connection check wording** · doc. "An open dialog holds every command until it is answered" is too strong:
behind a dialog no command opened, a queued command fails after MODAL_WAIT_SECONDS (5 s); behind a dialog a command
opened, a new command times out after 30 s; exec_python and the dialog tools keep running. The check also drops the
recovery answer that `/dialog` returns, though the F-52 design said it would show it. The recovery line says neither
that it happened at startup nor that the time is local.

**F-60: describe_character build sentence** · bug. "no body-shape slider set: the template's own build" is printed
whenever the three build sliders are below 0.15: false after a light preset (heavy 20% sets Body Fat A 0.14), with a
negative slider (Body Fat A -0.8), and for create_avatar's base body; it also sits above "cc4 kevin_body: 100%", a
shaping morph that reset_morphs zeroes (F-11). Fix the wording and warn in reset_morphs' description.

### C2 review (2026-10-05, workflow: five angles, each finding verified adversarially)

45 findings: 32 confirmed, 4 plausible, 9 refuted. Fixed before commit (C2b):
- Queue guard (server.py `_modal_dialog_error`): it runs only while no MCP command runs, so no command waits on the
  dialog it reports. C2 had invited the agent to answer it with answer_cc5_dialog (it may be the user's own): it now
  says "probably the user's own or CC5's: ask the user". A progress window reads "CC5 is busy" (F-56 was only half
  applied), and a dialog whose text could not be read goes to the user.
- Redo guard: the slot is marked before the capture undoes its own step, so a failed undo still counts, and it
  survives /reload. Known limit, now in the undo and redo descriptions: RLPy's Undo/Redo report nothing, so an undo
  with nothing left to undo, or a new change after an undo, is not seen (redo then asks CC5 and says it succeeded).
- Morph ID checks read the catalog once more before refusing (the per-avatar cache can be stale) and skip the check
  when the catalog cannot be read; get_morph_value used to fail on a catalog read error.
- set_skin_shader says when CC5 could not read the parameter (it blamed the value count).
- check_cc5_connection: behind a dialog an MCP command waits on, new commands wait about 30 s and are cancelled;
  behind any other, they fail after about 5 s and the user is asked first. A refused dialog check (a wrong token, an
  old plugin) shows CC5's error instead of "CC5 is probably busy". get_cc5_dialog adds "No MCP command is waiting on
  this dialog: it may be the user's own, so ask the user before answering it."; answer_cc5_dialog's description too.
- describe_character grades whole percents (CC5 sends float32 weights: Muscular 0.4 / Fat 0.3 read "average"), names
  both sliders when two lead together (Muscular 100% with Fat 100% read "average build"), and says "build not graded"
  when no build slider is set (a template's own shape comes from its identity morph).
- reset_morphs' warning no longer reads as "set the identity morphs to 0".
- search_content stops at the first folder that fails because CC5 is down, timed out, waits on a dialog or is held
  by the open-dialog guard (22 folders x 5 s), and passes CC5's text on.
- Job tools (export_goz, import_fbx, export_textures, export_for_unity) show CC5's question instead of "still
  running" (`pendingResult`); a client-side timeout is shown as it is, without "Is CC5 running".
- capture_viewport: the desktop-screenshot fallback could never run (a capture without a file is a 400) and is gone;
  the plugin already falls back to a screenshot of CC5's window.
- README (dialog tools, undo/redo) and CLAUDE.md (the dev note said to restart CC5 with taskkill).
- Tests for each, including a QProgressDialog fake, redo through capture_viewport, the large-capture reply, the log
  filter's 304 and status-less lines, the job tools' error paths, exact hint texts and the corrected descriptions.

Second review round (C2b, four angles plus a completeness critic): 26 findings, 9 confirmed, 17 refuted, plus one from
the critic. Fixed:
- The plugin's CC5-window screenshot fallback (`_capture_window_screenshot`) never wrote a file: its output path was
  passed after `-Command`, where PowerShell appends it to the command text instead of binding it to `param()`
  (checked with a harmless script: the path read back empty, exit code 1), and the no-window branch used Windows
  Forms before loading it. The path now travels in the environment (`CC5_CAP_OUT`). Not yet verified live.
- A job queued behind another command's dialog said "Still running" and a recipe's later steps waited 120 s each.
  `/jobs/status` now reports the question for it too (`blocked_by`: it has not started and runs after the answer),
  so job tools, recipe steps and `job_status` show it at once. check_cc5_connection no longer says every command
  sent behind such a dialog is cancelled: direct calls are, jobs wait.
- Redo's refusal said anything undone in CC5 could still be redone with Edit > Redo: only what was undone after the
  capture can (Edit > Redo would otherwise replay the capture's own step).
- describe_character named a runner-up below the 15% floor ("slightly muscular, heavy" for 20% / 12%).
- Tests that would have passed on a revert: the stale-catalog read through the real cache, the morph setters' checks,
  search_content's stop on 504/409/timeouts, and the batch export's dialog text.
  Suites: 764 TypeScript, 364 Python, all passing.

Left for Chad (Batch D's first question): batch_generate_patients carries on after a CC5 question, so with the queue
stalled behind it every later variant times out after about 30 s (50 variants: about 25 minutes, no way to answer
meanwhile). Recipes carry on the same way, now without the 120 s waits.

For the C2 live check: probe `REventCallback.OnUndoRedoDone`. If CC5 fires it only when an undo or redo did
something, undo can report "nothing to undo" and the redo guard can see a change made after an undo.

### C2 live check (2026-10-06 07:40-08:45, workflow: seven sequential CC5 steps, two verifiers each, critic)

CC5 launched with `CC5_RECOVERY_ANSWER=cancel CC5_ALLOW_EXEC=1`, up at the first try (Chad: the first-launch crash
happens between the back end and the UI loading; once CC5's main window shows, it has started correctly, F-54). It
opened Default.ccProject without a character (F-61 came from the first attempt), so CC4 Kevin was loaded and the
check run again. 74 of 75 checks passed; all 14 verifier verdicts confirmed every check (0 refuted). The one failed
check was the spec's: live CC5 lists three close matches for "Original Roughnes Strength" (Original Roughness
Strength, Keep Original Roughness, Chin Roughness Scale; difflib n=3, cutoff 0.6), where the spec expected one.
- L1: CC5 ran the new plugin; "connected and ready"; Kevin read "build not graded: the build sliders are not set
  (a template's own shape comes from its identity morph)", Wearing: Boxers, Hair: none, Accessories: none.
- L2 (F-60): heavy 20% "average build (build sliders below 15%)", heavy 50% "slightly heavy build", muscular 100%
  "muscular build", Muscular 100 + Fat 100 "muscular, heavy build (...)", 20/12 "slightly muscular build", 20/15
  "slightly muscular, heavy build (...)"; Oval Afro showed in the Hair line and came off with remove_scene_item.
- L3 (F-21, C2): every refusal text exact, including set_morph_value / set_multiple_morphs ("Morph(s) not found:
  nope_not_real ..." with nothing applied), set_item_visible, set_skin_shader (no match, wrong count), the named
  delete, the .fbx hint, the plugin-side .png hint through a recipe asset and the subdivision refusal.
- L4 (F-53, F-55, F-58, F-22, C2b): undo -> capture -> redo refused with the new text and the preset stayed off;
  heavy -> capture -> undo reached the preset, and redo brought it back; with MAX_IMAGE_BYTES lowered the capture
  came back as its path and "Image too large to embed (1265446 bytes)", no screenshot; 55 dummy files plus a capture
  were pruned to the newest 50; `_capture_window_screenshot` wrote a 2575x1407 PNG through `CC5_CAP_OUT` (checked
  by header only, not looked at).
- L5 (F-56, F-59, C2 review): a probe QProgressDialog read "CC5 is busy" in get_cc5_dialog and check_cc5_connection,
  answer_cc5_dialog refused its Cancel and, renamed, its Abort, and list_avatars failed with "CC5 is busy with ...";
  a probe question no command waited on gave the "No MCP command is waiting on this dialog ... ask the user" lines,
  list_avatars failed with the guard text, and search_content stopped at its first folder with that text.
- L6 (F-59, C2b): an exec_python question returned the 409 text with job X; check_cc5_connection gave the
  waiting-job lines; save_character came back at once with "Job Y has not started: it is queued behind job X ...
  runs after that answer" (job_status the same); a direct list_avatars was cancelled after 30 s; after answering,
  X finished ("answered OK") and Y saved the file. F-57 held: the successful requests made while X's stdout was
  redirected were not printed into its output, but its own 409 and the cancelled 504 were (F-63).
- L7: OnUndoRedoDone fires synchronously, once for each undo or redo that did something, and not for a redo with
  nothing to redo (2 of 2); RGlobal.Undo/Redo return None either way. An undo with nothing to undo was not tried
  (the history held other actions). If it is silent too, undo and redo can say "nothing to undo/redo" and keep the
  redo guard honest: probe it at the start of a fresh session, before anything is loaded.

**F-61: list tools with no character** (C2 live check L1, 2026-10-06) · minor. CC5 opened Default.ccProject with no
character. `get_avatar_info` and `describe_character` said "No avatar in the scene.", but `list_clothes`,
`list_hair` and `list_accessories` said "No clothes are applied." / "No hair is applied." / "No accessories are
applied.": the TypeScript formatter (src/tools/content.ts) turns any empty list into that text, so "no character"
reads like "a character wearing nothing". Fix: the list tools say "No avatar in the scene." when there is none.

**F-62: get_avatar_info prints raw float32** (C2 live check L4) · minor. Heavy 50% read back as Body Fat A
0.3499999940395355 and Muscular 0.10000000149011612. F-13's fix rounded get_morph_value and the expression reads
only; cc5_api.get_avatar_info returns GetShapingMorphWeight unrounded. Round to 4 decimals there.

**F-63: failed requests still printed from HTTP threads** (C2 live check L6) · minor. F-57's filter keeps successful
requests out of the log, but every 4xx/5xx is still printed from an HTTP thread: live, a running exec_python's
output held '"POST /exec/python HTTP/1.1" 409 -' and '"GET /avatars HTTP/1.1" 504 -' (exec_python's
redirect_stdout swaps sys.stdout for the whole process). Printing from non-main threads into CC5's console stays a
crash candidate (F-51, F-54). Fix: write the request log to a file, never to stdout.

**F-64: the window screenshot may show a console window** (C2 live check critic) · minor. `_capture_window_screenshot`
starts powershell.exe from CC5 (a GUI process) without `creationflags=CREATE_NO_WINDOW`, so a console window can open
over CC5 while CopyFromScreen copies that area. Pass CREATE_NO_WINDOW. Also: set_skin_shader's third close match
("Chin Roughness Scale", ratio about 0.61) is noise; a cutoff near 0.75 keeps only the real match.

## Ideas (not findings)

**I-01: a panel inside CC5** (Chad, 2026-10-05) · after the run
CC5's plugin API can add docked panels, menus and hotkeys (`RUi.CreateRDockWidget`, `RUi.AddMenu`,
`RUi.AddHotKey`, `RUi.GetMainWindow`), and the plugin already runs PySide2 inside CC5. Options, smallest first:
a bridge activity log panel (live view of MCP commands, waiting dialogs and jobs); a Python console panel (RLPy
commands on CC5's main thread; must obey the same `CC5_DEV_MODE` / `CC5_ALLOW_EXEC` switch as `exec_python`); a
shell panel (PowerShell/cmd through a pipe; not a real terminal, so full-screen programs such as Claude Code do not
render); a Claude chat panel (needs its own link to Claude; separate design). Decide the purpose first.

**I-02: look in the Reallusion store when the local content has no match** (Chad, 2026-10-05) · protocol
When the user asks for something the installed catalogue does not have (`browse_content` / `search_content` find
nothing acceptable), search the Reallusion store (Content Store, Marketplace) for a suitable option and show the user
what was found: name, link, price, and whether it fits CC5 (CC4/CC5 compatible, the right content type). Claude
only suggests; the user decides and buys or downloads it in their own account, then Claude loads it from where it
was installed. Pair with F-34: store content is the most likely kind to override other parts of the character.
To build into the MCP: a `search_store` step in the create-character prompt (and the tool descriptions for
`browse_content` / `search_content`) for when nothing local matches.

**I-03: show the pick list before applying a general ask** (Chad, 2026-10-05) · protocol
When the user's ask is general or leaves the choice open ("dress him top to bottom", "give him a hat", "make him
look older"), Claude first presents the list of items it will apply (name, file, what it changes) as a check and
waits for the user's go-ahead before loading anything. Seen at P5-23 to P5-26: Claude picked Slim Jeans, Basic
T-shirt, Ankle socks A and Hat_DarkBlue and loaded them without showing the list. A specific ask ("load the Canvas
Shoes") needs no check. Pairs with F-34 (capture before/after) and I-02 (offer store items when nothing local
fits). To build into the MCP: a "propose, confirm, apply" step in the create-character prompt and in the
`load_asset` / `apply_character_recipe` descriptions.

**I-04: hair from scratch** (Chad, 2026-10-05) · capability
The current tools cannot create a hairstyle: they load, remove and recolour existing hair and tweak its materials,
shaders and textures (`load_texture`, not undoable: F-39), but nothing creates hair geometry. CC5's Hair Builder is
UI-only (no hair-creation calls in `docs/rlpy-api-reference.md`). RLPy does have `ConvertToHair(eHairType)`
(`EHairType_Hair_Top` / `_Base` / `_Rear` / `_Bangs` / `_Accessory`) and `ConvertToFaceHair(eFaceHairType)` (brows,
beard types) on `RIAccessory` and `RIHair` (rlpy-api-reference.md:2625, 2685), so an imported mesh can become real CC5
hair. Proposed route: (1) model the hair mesh outside CC5 (Blender, via the Blender MCP; it failed to connect this
session) or reshape an existing style (export its mesh, edit, `replace_mesh_from_obj`); (2) bring it in with
`import_fbx` (kind clothing or prop); (3) a new `convert_to_hair(item, hair_type)` tool calls `ConvertToHair` /
`ConvertToFaceHair`, one undo step; (4) colour, materials and textures then work as for any hair. Check live whether
`ConvertToHair` binds the mesh to the head (skin weights; `RIAccessory.TransferSkinWeight` may be needed first) and
whether the result saves as `.rlHair`.

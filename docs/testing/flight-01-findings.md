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
| F-28 | gap | fixed (`f03cf52`), live-checked 2026-10-07: recipe and batch stop at the question (D1), the user's button answers the rest of that run (D3), a new run asks again, a Cancel is not carried | Every second character preset stops on "Replace / Material Only"; batch runs need a preset answer |
| F-29 | doc | runbook | Runbook placeholders ("‹first jaw ID›") are ambiguous; give real IDs |
| F-30 | doc | runbook | Value checks need a tolerance (float32 and 0-255 storage) |
| F-31 | retest | open | Worn accessory selection (duplicate-name risk) untested: Kevin has no accessories |
| F-32 | minor | open | Claude Code showed a stale `load_asset` schema (no `target`) after restarts; the build is correct |
| F-33 | blocker | fixed (live P4-78 to P4-81) | Hair could not be loaded at all: every CC5 hairstyle is `.rlHair`, which `load_asset` refused |
| F-34 | gap | partly fixed (Batch D): before/after data check built; picture check pending (F-34-phase2) | Presets override more than they are named for (lip makeup hid hair, brows, probably the Boxers and possibly the torso skin, reset skin); `load_asset` reports a clean load |
| F-35 | bug | not a bug (P4-102) | `get_material_properties` read-back: works on a clean character; the earlier 100 came from F-34 |
| F-36 | blocker | fixed (live P4-104 to P4-106) | Material setters sent 0-1 to CC5's 0-100 scale: opacity 1.0 = 1%, the skin vanished |
| F-37 | bug | not a bug (P4-107) | Opacity undo: works on a clean character; the earlier failure came from F-34 |
| F-38 | doc + bug | fixed, live (Batch A; legacy specular storage not probed) | Glossiness/specular are legacy non-PBR values: skin shine is the roughness shader parameters; specular also stored erratically |
| F-39 | bug | fixed by F-53 (live, Batch B) | `undo` does not reverse `load_texture`; a texture load is effectively permanent (no undo, no read-back of the old texture) |
| F-40 | minor | fixed, live (Batch A) | `list_clothes` shows the item type as a raw number (`Type: 1`); it should list what is worn or say "No clothes are applied" |
| F-41 | bug | fixed, live (Batch A) | `browse_content("cloth_upper")` lists nothing: it reads `EContentRootFolder_Upper`, not the Shirts/Coats clothing folders; `cloth_lower` the same |
| F-42 | bug | fixed, live (Batch A) | `accessory_head` / `accessory_body` both list the 8 handheld/outfit items in Accessory/Others; real head (11), torso (20) and arm (47) accessories are never listed |
| F-43 | bug | wrinkle_mask fixed, live (Batch A); texture total still capped | `wrinkle_mask` lists nothing; `texture` stops at 200 of 437 images |
| F-44 | gap | partly fixed (Batch D): check_fit built; fit corrections pending (F-44-phase2) | No collision check after applying items, and no way to fix a poke-through (Kevin's scalp shows through Hat_DarkBlue) |
| F-45 | bug | fixed, live (Batch A) | `frame_camera("home")` right after `"left"` reported success but did not move the camera; `"left"` framed a hip close-up, not the whole body |
| F-46 | bug | fixed with F-53, live | `undo` after `remove_scene_item` reports success but does not bring the item back (Oval Afro stayed removed) |
| F-47 | doc | runbook | The runbook's test inputs (`C:\CC5Test\inputs\`: cube.fbx, overlay.png, notes.txt...) do not exist; file tests only exercise "not found" |
| F-48 | doc + gap | fixed, live (Batch A) | `import_fbx` description says to answer Import Settings in CC5 (the dialog tools now do it); no tool moves, scales or deletes a prop |
| F-49 | blocker | fixed, live (Batch A) | Add a "Delete object" tool: nothing can delete a prop (or other scene object) today |
| F-50 | bug | fixed (Batch A; not run live: FBX imports crash a fresh session, F-51) | `import_fbx` as clothing always dresses the first character: no `target`, ignores the selection (unlike `load_asset`) |
| F-51 | bug | open; not reproduced 2026-10-07 (two prop imports with Convert All, no crash) | CC5 crashed during an FBX prop import, right after "Convert All" (second session, box_01.fbx that imported fine before) |
| F-52 | blocker | fixed, live (Batch A) | The crash-recovery prompt stops an unattended run: only the user may answer it. Chad: Claude-launched CC5 answers Cancel automatically |
| F-53 | blocker | fixed, live (Batch A) | `capture_viewport` adds an undo step (it re-sets the render size), so `undo` after any capture reverses the capture, not the change |
| F-54 | bug (CC5) | open | CC5 crashed on its own 2-3 minutes after a launch, before any MCP command; Chad: CC5 often crashes on the first launch attempt |
| F-55 | bug | fixed, live (C2) | `redo` after a capture reports success but brings nothing back: the capture's own undo step takes the redo slot |
| F-56 | bug | fixed, live (C2) | A progress window (an export's, only button Cancel) is reported as a dialog waiting for an answer, inviting an agent to cancel it |
| F-57 | bug | fixed, live (C2); failed requests still print (F-63) | The bridge's request log filter never matches, so every request is printed from HTTP threads (and lands in exec_python output) |
| F-58 | bug | fixed, live (C2) | A capture over 10 MB (e.g. 8K) is overwritten by a full-screen desktop screenshot; a unit test takes a real screenshot on every npm test |
| F-59 | doc | fixed, live (C2) | check_cc5_connection overstates what an open dialog does and never shows the automatic recovery answer |
| F-60 | bug | fixed, live (C2) | describe_character's "no body-shape slider set: the template's own build" can be false (light presets, negative sliders, non-templates) |
| F-61 | minor | fixed (`f03cf52`), live-checked 2026-10-07 | With no character in the scene, list_clothes / list_hair / list_accessories say "No clothes are applied." (as for a character wearing nothing) |
| F-62 | minor | fixed (`f03cf52`), live-checked 2026-10-06 | `get_avatar_info` still prints raw float32 morph weights (0.3499999940395355): F-13's fix covered get_morph_value and expressions only |
| F-63 | minor | fixed (`f03cf52`), live-checked 2026-10-06 | Failed bridge requests (4xx/5xx) are still printed from HTTP threads, into CC5's console and a running exec_python's output |
| F-64 | minor | fixed (`f03cf52`), live-checked 2026-10-06 | The CC5-window screenshot fallback starts PowerShell without CREATE_NO_WINDOW: a console window may flash over CC5 and land in the capture |
| F-65 | minor | partly fixed (`f03cf52`): stale read-backs are reported; live, SetTime(GetTime()) and one frame forward and back do not refresh the read, only a render does, so the refresh stays off | An overlay's strength reads back stale (0.0) until CC5 renders; `apply_skin_overlay` reports the strength it was asked for, not a read-back |
| F-66 | bug | fixed (`f03cf52`), live-checked 2026-10-06 | `load_texture` into `diffuse_blend` never sets the channel's strength: on a skin material that never had an overlay (0.0) the image does not show, yet the tool reports success; `remove_skin_overlay` leaves the old strength behind |
| F-67 | bug | open | `set_skin_condition` tints are weak: cyanotic at full strength barely changes the skin (a little darker and less orange) and does not read as cyanosis; flushed and jaundiced at 0.7 are mild and body-wide |
| F-68 | doc | fixed (`f03cf52`), live-checked 2026-10-06: BMP and TIFF overlays work; the "not yet tested" wording removed in batch E | `apply_skin_overlay` says PNG/JPG/TGA but also accepts .jpeg, .bmp, .tif and .tiff; whether CC5 loads BMP or TIFF overlays is untested |
| F-69 | minor | fixed (`f03cf52`), live-checked 2026-10-06 | `get_shader_parameters` lists `SSS Metallic Threshold = []` (no value) and `padding1` / `padding Last4` (shader filler) as if they were settings |
| F-70 | doc + gap | fixed (`f03cf52`), live-checked 2026-10-06: wrinkle 1 vs 0 changes the forehead during a brow raise; aging a resting face needs I-05 | `set_wrinkle_strength` is described as aging a patient, but it scales CC5's expression wrinkles: at a neutral face, 1 changed nothing visible; no read-back exists |
| F-71 | bug | fixed (`f03cf52`), live-checked 2026-10-07 | The `create_character` prompt receives only the first word of its description in Claude Code (`"Adult`); the rest of the patient description is lost from the prompt text |
| F-72 | bug | fixed (`f03cf52`), live-checked 2026-10-06 | `browse_content` / `search_content` never list CC5's Custom tab (Reallusion Custom): the user's own US Army uniform was invisible, and the search said "No content matched 'army'" |
| F-73 | minor | partly fixed (`f03cf52`), live-checked 2026-10-06: the merge hint and remove_tearline_occlusion work; slots or distinct materials still to be decided | The Unity export writes a copy of identical textures for each of the uniform's three same-named materials, and `check_quest_budget` failed the soldier at 22/20 material slots; Unity itself imports them as one shared material (20 distinct), so whether the Quest limit counts slots or distinct materials must be decided |
| F-74 | minor | open | The uniform rendered glossy right after the recipe and matte 13 minutes later (after save and the first FBX export), with nothing done to it; cause unknown |
| F-75 | blocker | partly fixed (`f03cf52`), live-checked 2026-10-06: ask, omit, separate (bridge record and GetImage) and bake work; a stale record fails closed; the bake matches its formula within JPEG noise; calibration against CC5's look pending | `export_for_unity` drops the injury overlay (Diffuse Blend): the FBX and its textures carry no trace of it, so the Unity patient has no injuries; the pale condition does not reach the Unity export either (P9-13: skin diffuse files byte-identical at pale 0.6 / 0.8 / 0.9; no exported file carries the shader offsets; not rendered in Unity) |
| F-76 | minor | fixed (`f03cf52`), live-checked 2026-10-06 | `export_for_unity` accepts any path with an `Assets` folder in it, even where no Unity project exists, and creates the folders |
| F-77 | bug | partly fixed (`f03cf52`): the save reply lists the expression (live-checked 2026-10-06); the pose (P8-10) is named, not read back | A character saved with `save_character` (`.ccAvatar`) and loaded again with `load_asset` (recipe or batch base) comes back with a neutral face (read back) and standing (one capture; whether the save or CC5's load drops the pose is untested), so every batch variant made from a saved base comes out neutral-faced while the batch reports OK |
| F-78 | doc | runbook | Part 7's Unity paths use `C:\CC5Test\UnityTest\Assets\...`, which does not exist; the project is `C:\CC5Test\unity\UnityTest_6.2` |
| F-79 | gap | fixed (`f03cf52`), live-checked 2026-10-06 | `batch_generate_patients` accepts a variant with an empty recipe: it exported an unchanged copy of the base ("Refused", `steps: []`) and reported OK |
| F-80 | bug | fixed (`f03cf52`), live-checked 2026-10-07: merge, rerun, earlier_export after a stopped rerun | A second batch into the same folder overwrites `patients_manifest.json`: the earlier variants' entries vanish while their exports stay |
| F-81 | bug | fixed (`f03cf52`), live-checked 2026-10-06 | `apply_character_recipe`'s base step deletes every character in the scene before it checks that the base file exists, so a mistyped base empties the scene |
| F-82 | minor | fixed (`f03cf52`), live-checked 2026-10-06 | Applying a pose file sets the character's motion clip and CC5's project length to 0, so a Unity export without include_current_pose writes a zero-length "Default" take and Unity warns "contains animation clip 'Default' which has length of 0 frames"; a standing character's export has a one-frame take and no warning. Live: a one-frame project length during the export fixes it |
| F-83 | blocker | fixed (`f03cf52`), live-checked 2026-10-06; an active facial expression is baked in (F-88) | The `export_obj` → `replace_mesh_from_obj` round trip distorts the body: CC5 reads the OBJ as the mesh in the character's current pose, but `export_obj` writes the bind pose (no OBJ option writes the current pose), so with no edit the body stands arms-out (or contorts when posed); the tool reports success. Live: a T-pose OBJ replaced while the character has no motion clip (it then stands in the T-pose) round-trips exactly |
| F-84 | bug | fixed (`f03cf52`), live-checked 2026-10-06; the bake command it then missed is F-87 | `bake_skin_textures` triggers SkinGen's About box (a buttonless modal: until it is closed by hand, every later command except exec_python, the export/mixer status reads and the dialog tools fails after 5 s) and reports "Skin Editor / Skin Gen panel was opened"; its "Skin bake initiated at Npx" header, success:true and texture-size note are also false |
| F-85 | bug | fixed (`f03cf52`), live-checked 2026-10-06 | Dialog messages (the queue-guard error, the waiting error, job_status, get_cc5_dialog, check_cc5_connection) repeat a window's label text (errors up to 300/400 characters, the dialog tools all of it), so SkinGen's About box puts its licence serial into the conversation and the MCP server's stderr log |
| F-86 | bug | refuted live 2026-10-06: an FBX export does not clear CC5's undo history (F-89) | An FBX export clears CC5's undo history: afterwards `undo` cannot take back any earlier change and still reports "Undo successful"; nothing says so |
| F-87 | minor | fixed in batch E and F, live-checked 2026-10-07 (batch F); the bake itself not yet seen (needs SkinGen layers applied in the Appearance Editor) | `bake_skin_textures` misses CC5 5.13's real bake command, "Bake All &Skin Textures" (`qtBakeAllSkinTextureAction`, Character menu): the '&' and "All" defeat its phrase match; the command stayed disabled in every state tried |
| F-88 | bug | fixed in batch E (uncommitted), live-checked 2026-10-07 | The OBJ round trip bakes an active facial expression into the mesh: the T-pose OBJ carries it, the replace makes it part of the body and the expression applies on top again (head up to 0.36 cm off); the post-check's 0.5 cm tolerance passes it as a match |
| F-89 | bug | fixed in batch E (uncommitted); plugin side live-checked 2026-10-07, tool texts pending | Batch D's F-86 line is false: an FBX export does not clear CC5's undo history (morph and skin-shader changes undo across exports; only a light's intensity change before an export did not). Every export reply, export_fbx's failure text and the undo description say it does |
| F-90 | bug | fixed in batch E and F; plugin side live-checked 2026-10-07 (batch F) (the colour just set read back with its note, a shoe load after skin_rgb without a skin-colour CHECK) | The F-34 comparison reads a material colour CC5 reports late (until it renders): a colour set just before a load (a recipe's skin_rgb) shows up as that load's CHECK line |
| F-91 | minor | cause found 2026-10-07 (a SkinGen session); fixed in batch E and F, live-checked 2026-10-07 (batch F) | A SkinGen makeup preset (Red Velvet) hides hair, brows and ALL clothing in the viewport; the items stay worn and are exported, set_item_visible does not bring them back, and the NOT CHECKED line names only hair or brows |
| F-92 | bug | cause found 2026-10-07; workaround in batch E, live-checked 2026-10-07 (delete, recipe base, batch clear); batch F: delete_avatar deletes nothing unless CC5's selection reads empty after the clear, the recipe base step and batch scene clear show its notes, a .ccProject load clears the selection first; live check pending | CC5 crashes (CCAvatarShaping.dll, access violation) when a character is deleted while one of its worn items that carries its own shaping morphs (the custom US Army uniform) is selected; load_asset leaves the loaded item selected, so delete_avatar right after loading the uniform crashed 5 of 5 times |
| F-93 | minor | cause found and fixed 2026-10-07 (batch E), live-checked | `scripts/cc5-restart.ps1` reported "The bridge did not answer within 120 s" on every launch, although the bridge was up after about 70 s: its health check never succeeded (Invoke-WebRequest without -UseBasicParsing throws in Windows PowerShell 5.1) |
| F-94 | minor | fixed in batch E (formatDialog) and batch F (the waiting texts, job_status, recipe and batch stops), live check pending | The recipe's open-dialog pre-check shows CC5's Welcome page as an "(untitled)" dialog "no MCP command is waiting on ... ask the user before answering it", while the queue guard names it and says to close it |
| F-95 | minor | fixed in batch E (uncommitted), live-checked 2026-10-07 (new build, load_asset) | load_asset's reply runs its first line into the report in Claude Code: "... (applied to Kevin)Compared before and after: ..." (two text blocks shown without a separator) |
| F-96 | doc | fixed in batch E (uncommitted): the docs, and tests/py/test_py38_compat.py | CC5 5.13 runs Python 3.8.8 (sys.version; python38.dll in the crash dumps), while CLAUDE.md and .claude/rules say 3.10: plugin code using 3.9+ features would pass the tests (run under Python 3.14) and fail only inside CC5 |
| F-97 | minor | fixed in batch F, live-checked 2026-10-07 (batch F) | An eye preset's own cornea opacity (Std_Cornea_R/L 1 -> 0.8 after _Blue1 Eyes) is reported as a CHECK line, a side effect, instead of as what the load is for |
| F-98 | minor | fixed in batch F, live-checked 2026-10-07 (batch F) (a single load through job_status, and a recipe) | After the user's Cancel in Replace / Material Only, the recipe reports the step as "OK ... (after the answer)" and "All 2 steps succeeded", though CC5 applied nothing |
| F-99 | minor | fixed in batch F, live-checked 2026-10-07 (batch F) | Dialogs built in QML (CC5's Export FBX dialog, IC::CFbxExportDialog, one QQuickWidget) report "Buttons: none found": their buttons are QML items the bridge cannot see or click |
| F-100 | minor | fixed in batch F, live-checked 2026-10-07 (batch F) | batch_generate_patients' reply says only "OK <variant>": a layer question answered with the run's carried answer, and the injury files written beside the FBX, appear only in patients_manifest.json |
| F-101 | minor | two causes found 2026-10-07: a replace while CC5 still loads a texture's images (fixed by F-104's gate) and a replace right after an undo of a texture load (the tool tries it once more after 3 s); both live-checked 2026-10-07 (batch F) | In scripts/live_smoke_test.py, replace_mesh_from_obj refused its unedited OBJ after the script's other steps ("the mesh differs by up to 95.44 cm", undone); run again on the same character it matched (0.00 cm) |
| F-102 | minor | fixed in batch F, live-checked 2026-10-07 (batch F) | set_shader_parameter echoes raw float32 values ("set to [0.019999999552965164, ...]") |
| F-103 | minor | fixed in batch F, live-checked 2026-10-07 (batch F) | search_morphs on an empty scene replies "No morphs found matching 'height'" instead of saying that no character is loaded |
| F-104 | blocker | fixed in batch F, live-checked 2026-10-07 (batch F) | capture_viewport takes back a load that CC5 has not finished: its one undo (F-53) undoes the load too, so the loaded item is gone (live: Box_001 after a capture sent while its load job ran) |
| F-105 | minor (CC5) | known CC5 behaviour (Chad, 2026-10-07): CC5 leaks memory; restarting CC5 usually fixes it | In a long session CC5 grows to many gigabytes and slows down: 5.9 GB when a delete took over 30 s and a SkinGen preset load about 3.5 minutes (then Chad's machine had to restart); 9.3 GB after this afternoon's probes |

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
Seen again 2026-10-06 20:40 after the Batch D build, the reinstall and a Claude Code restart that resumed the session: ToolSearch served the old schemas and descriptions of apply_character_recipe (no continue_after, no layer_answer), export_for_unity (no injuries, wait_seconds 25), export_obj, replace_mesh_from_obj and undo, while search_content, load_asset, bake_skin_textures, answer_cc5_dialog and check_fit came back new. A fresh instance of build/index.js listed 89 tools with the new schemas, and the client still passed continue_after to the server. So the model is shown stale text, likely from the resumed transcript; start a new session, not a resumed one, after a build.

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
P7-3 (2026-10-06): clothing does it too. `apply_character_recipe` loaded CC4 Kevin plus the US Army uniform from the
Custom tab (shirt, pants, boots) and reported "All 5 steps succeeded", but the template's Boxers were gone afterwards
(`list_clothes`: Shirt, Pants, Boots). CC5 swapped them out when the pants loaded, and the patient description
had asked to keep the template's clothes. The before/after protocol should cover clothing loads as well, listing
items removed or replaced.

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

### Part 6 (2026-10-06, CC4 Kevin, `db0358d` installed)

Setup: `C:\CC5Test\inputs\overlay.png` created for this part (1024 x 1024, 8-bit RGB, every pixel 128, 48, 48).

**F-65: overlay strength reads back stale until CC5 renders** (P6-1) · minor. `apply_skin_overlay` (head, 60)
reported "Applied overlay.png at 60% to: Std_Skin_Head", which repeats the request rather than reading anything
back. RLPy's `GetTextureWeights` (list index = `EMaterialTextureChannel` value, 7 = DiffuseBlend) still returned 0.0
for Std_Skin_Head twice in the minute after the apply. It returned 0.6 only after a `capture_viewport` render.
`HasImage` was right at once, and the capture showed the tint (head material only). A strength read-back, whether
in the apply's report or in a future overlay-state read, must refresh first. P6-2 (arms, 100) reproduced it:
Std_Skin_Arm read 0.0 right after the apply, still 0.0 after `RGlobal.ForceViewportUpdate()` in the same call and
again in a separate call after an event-loop turn, and 1.0 after a `capture_viewport`. So the viewport refresh is
not what updates it; the capture's `RenderImage` (or its undo of its own step) is. Untried: re-evaluating the
current frame (`RGlobal.SetTime(RGlobal.GetTime())`) on a later apply.
P7-12: `apply_character_recipe` ran an overlay step (all skin, 60) followed by an expression step, and all four skin
materials read 0.6 right after the recipe, with no capture first. The expression step, which keys face weights at the
current time, seems to refresh the material keys too. That supports the "re-evaluate the current frame" idea.

**F-66: `load_texture` into `diffuse_blend` loads an image that does not show** (P6-3; confirmed live after Part 6)
· bug. `cc5_pipeline.load_texture` calls `LoadImageToTexture` but never sets the channel's strength
(`AddTextureWeightKey`). Every skin material's Diffuse Blend strength read 0.0 before any overlay (setup read-back),
and CC4 Kevin's corneas carry a Diffuse Blend image at 0.0, which suggests 0.0 means the blend is off. Then
`load_texture(..., "diffuse_blend", ...)` would report success for an image that does not show. Also,
`remove_skin_overlay` removes the image but leaves the strength: after P6-3, Std_Skin_Head had no image and still
read 0.6 after a capture, so a later `load_texture` there would show at 60%. P6-4 left Std_Skin_Arm at 1.0 the
same way. `apply_skin_overlay` always sets the strength, so it is not affected.
Confirmed after Part 6 on a freshly loaded CC4 Kevin. `load_texture(CC_Base_Body, Std_Skin_Leg, diffuse_blend,
overlay.png)` replied "Loaded overlay.png into Std_Skin_Leg (diffuse_blend)", and the image was in the channel at
strength 0.0, but the legs did not change. Setting the strength to 1.0 by hand (`AddTextureWeightKey`, as
`apply_skin_overlay` does) turned them dark red. Both steps were undone, and the capture afterwards matched the fresh
load (largest difference 3/255). Fix: `load_texture` sets the strength for `diffuse_blend` (1.0, or a strength
parameter), and `remove_skin_overlay` resets the strength to 0.

**F-67: cyanotic at full strength does not read as cyanosis** (P6-7) · bug. `set_skin_condition('cyanotic', 1.0)`
set the diffuse tint exactly as designed: (0.80, 0.86, 0.98), stored as 204, 219, 250, on all four skin materials.
It also reset the pallor offsets to 0. But the render only got a little darker and less orange. Against the setup
capture, red was ×0.88-0.91, green ×0.92-0.93 and blue ×0.99, and the hue moved from about 17° to 13°. Side by side
with the setup and pale captures (P6-6), it reads as slightly darker, duller skin, not blue or grey, and the lips
stay pink. The tint is a multiply, so it can only darken; the code says the same about pale. The fix is probably
the route Task 18 took for pale: tune it live on CC4 Kevin until it reads as cyanosis (blue-grey lips, nail beds and
face), for example a stronger tint plus lower saturation through the Digital Human skin shader. Check flushed and
jaundiced the same way.
P6-8 checked those two at 0.7. Both were set exactly as designed on all four skin materials, flushed as
(255, 223, 219) and jaundiced as (255, 246, 201), with the pallor offsets at 0. Flushed rendered red ×1.00,
green ×0.93 and blue ×0.92: a slightly rosier tone over the whole body, whereas flushing shows on the face, neck and
chest. Jaundiced rendered green ×0.98 and blue ×0.88, with the hue moving from 17° to 21°: a slightly yellower tone
that reads more like a tan. The whites of the eyes, where jaundice shows first, are outside a skin tool's reach.
Both are visible but mild at 0.7.

**F-68: the overlay description lists fewer file types than the tool accepts** (P6-5) · doc. `apply_skin_overlay`'s
description and its `image_path` text say PNG/JPG/TGA (`src/tools/skin.ts:19`, `:21`), and so does the
create-character prompt (`src/prompts/create-character.ts:18`). The tool accepts `.png .jpg .jpeg .tga .bmp .tif
.tiff` (`IMAGE_EXTENSIONS` in `src/tools/pipeline.ts` and `cc5_pipeline.py`), and P6-5's refusal listed all seven.
Whether CC5 loads a BMP or TIFF overlay is untested. Fix: test BMP and TIFF live, then either list every accepted
type in the descriptions or narrow the accepted list to the types that work.

**F-69: `get_shader_parameters` lists entries that are not settings** (P6-6) · minor. On CC4 Kevin's Std_Skin_Head
(56 parameters) it lists `SSS Metallic Threshold = []` (CC5 returns no value for it) and two filler entries,
`padding1` (3 values) and `padding Last4` (1 value). An agent reading the list may try to set them. By the code,
`set_shader_parameter` refuses `SSS Metallic Threshold` before calling CC5, so it is safe, but the reason given
("expects 0 value(s), got 1") is confusing. The padding entries can be written, though they are shader filler, not
settings. Fix: leave out (or mark) parameters with no value and the `padding*` entries, and word the refusal for a
parameter CC5 reports no value for.

**F-70: `set_wrinkle_strength` does not age a resting face** (P6-11) · doc + gap. The description says "Set facial
wrinkle detail strength (0 = smooth, 1 = full). Useful for aging a patient." The plugin calls
`SetWrinkleDetailStrength(part, strength)` for each `EWrinkleFacePart` (Blink, BrowDrop, BrowRaise, Cheek, Chin,
Jaw, MouthStretch, Neck, Nose, PurseLips, Smile, Squint, Sneer), then `UpdateWrinkle()`. Those parts are CC5's
expression wrinkles, which show while the matching expression is active. Live, on CC4 Kevin's neutral face, face
close-ups before and after strength 1 were identical: 176,400 pixels compared, the largest channel difference 3/255
(noise). The reply "Wrinkle strength set to 1" cannot be checked, because RLPy has no getter for it. Untested: an
expression (for example a brow raise) at strength 0 and then 1, which would show what the tool does change. Fix:
describe it as the strength of expression wrinkles, not aging; aging a resting face needs other means (morphs, skin
textures or SkinGen layers).
Chad (2026-10-06): this is where content packs come in. "All the controls live as additional layers in the Modify
panel": for example, Face Wrinkle M.ccSkinGenPreset adds extra skin controls to CC4 Kevin. "The built in tools are
the bare bones minimum setup." See I-05.

### Part 7 (2026-10-06, end to end with the `create_character` prompt)

**F-71: the `create_character` prompt gets only the first word of the description** (P7-1) · bug. Chad ran
`/mcp__cc5__create_character "Adult male soldier, about 30, average build, pale from blood loss, keep the template's
clothes and hair"`. The prompt text arrived as `Build this patient character in Character Creator 5: "Adult`: the
single `description` argument (`src/prompts/create-character.ts`) received the first whitespace-separated word,
quote included, and the rest was dropped. The model could recover the full text only because Claude Code also showed
the typed arguments; another client, or a model that trusts the prompt text, would build an "Adult". Fix options:
take no argument and have the prompt ask for the description, or keep it and add "if this description looks cut
off, use the full text the user typed after the command, or ask for it".

**F-72: the content tools never list CC5's Custom tab** (P7-1) · bug. Chad pointed at a US Army uniform in CC5's
Content panel (Custom tab, Cloth > Shirts). On disk it is `C:\Users\Public\Documents\Reallusion\Reallusion
Custom\Cloth\`: `Shirts\US_Army_Uniform_Shirt.ccCloth`, `Shirts\US Army Uniform Shirt.ccCloth`,
`Pants\US_Army_Uniform_Pants.ccCloth` and `Shoes\US_Army_Uniform_Boots.ccShoes`. Yet `search_content('army')` over
every clothing category answered "No content matched 'army'". Cause, probed live: `browse_content` asks
`RApplication.GetDefaultContentFolder(enum)`, which returns CC5 content strings such as `$/Cloth/Shirts`, and
`GetCustomContentFolder(enum)`, which returns a plain path
(`C:/Users/Public/Documents/Reallusion/Reallusion Custom/Cloth/Shirts`). `GetContentFilesInFolder` lists the `$/...`
folders but returns nothing for the plain path (0 files for Shirts, Pants, Shoes and Others), so custom content
never reaches either tool. The user's own and imported content, typically the most relevant (Exonicus uniforms),
is therefore invisible to the agent, and the create-character prompt's "pick real file paths from the results"
cannot find it. Fix: when the custom getter returns a filesystem path, list it with `os.walk` and the same
extension filter. Check `Shared Custom` and `Shared Templates` too (they also exist under
`C:\Users\Public\Documents\Reallusion`).

**F-73: the Unity export splits a shared material into one copy per mesh** (P7-8) · minor. The US Army uniform's
shirt, pants and boots share one material in CC5 (`M_BipPMilUniform_US` on all three meshes, `get_material_info`).
`export_for_unity` (`C:\CC5Test\unity\UnityTest_6.2\Assets\CC5Patients\Soldier_Pale_01`, 43 files, 63 MB) wrote it
once per mesh. The FBX names `M_BipPMilUniform_US` three times, and `Soldier_Pale_01.fbm` holds three byte-identical
copies of its textures (`_Diffuse`, `_Diffuse_0001`, `_Diffuse_0002` and the same for Normal, each set with one
MD5). `check_quest_budget` then failed the character at 22 materials against 20. Triangles passed (45,774 of
65,000) and estimated texture memory passed (52.5 of 66 MiB). With one shared material the count would be 20 (a
pass), with four fewer textures in memory and 14.7 MB less on disk. The prompt's stock fixes (fewer clothing layers,
texture_size 1024) do not lower the material count here. Fix ideas: have `check_quest_budget` spot byte-identical
texture sets behind same-named materials and say "merge these in Unity: the count would be N"; or merge them on
export or on Unity import.
Correction (P7-9): in CC5 the three are separate material instances that share a name and textures (Traditional
shader, Diffuse and Bump). Their legacy settings differ: specular 31 on the shirt and 25 on the pants and boots;
glossiness 0 on the shirt and pants and 25 on the boots. Merging all three into one Unity material reaches 20, but
picks one setting for all three, which slightly changes the boots' gloss. Merging only the shirt and pants gives 21,
still over.
P9-16 (Unity data): Unity imports PromptPatient and Soldier_Pale_01 with 20 distinct materials: the shirt, pants
and boots share one Unity material, M_BipPMilUniform_US (`E2EImportCheck` dedups by reference). `check_quest_budget`
counts 22 material slots. So which count the Quest limit of 20 (Patient_FemaleWhite) means must be decided: distinct
materials (20, a pass) or slots / draw calls (22). `check_quest_budget` should say which it counts, and its GPU
estimate should leave out unreferenced duplicate textures.

**F-74: the uniform's look changed between captures with nothing done to it** (P7-9) · minor. The front capture
right after `apply_character_recipe` (10:12) showed the shirt and pants with a strong wet-looking sheen. The front
capture at 10:25, after the arms overlay, showed them matte. A difference map put the change on the whole shirt and
both trouser legs (about 27,000 pixels over 8/255), beyond the hands the overlay tinted; the boots and face were
unchanged. Nothing between the two captures touched the uniform: back, left and right captures, `save_character`,
the session's first `export_for_unity`, and the overlay on Std_Skin_Arm. Its materials now read Traditional shader,
Diffuse and Bump images, glossiness 0/0/25, specular 31/25/25; there is no earlier read to compare. Two likely
causes: CC5 finished loading a texture (the Bump map) after the first capture, or the export changed material values
in the scene. It matters because a capture taken right after a load may not show the final look, and the FBX may
have caught either look. Check: load the uniform, capture at once and again two minutes later with no export, read
the material values each time, then export and read again.
The second export (10:28) left the values unchanged (glossiness 0/0/25, specular 31/25/25, Diffuse and Bump images),
so at least a later export does not change them. The first export is still a suspect.
Live 2026-10-06 21:13-21:23 (not reproduced): US_Army_Uniform_Shirt/Pants/Boots read glossiness 25 / specular 25 and showed the sheen at once, two minutes later, after an export, after save_character, and in a fresh CC5 session after its first export. The other shirt file, "US Army Uniform Shirt.ccCloth", reads glossiness 0 (matte). Part 7's 0/0/25 and 31/25/25 remain unexplained.

**F-75: the Unity export drops the injury overlay** (P7-10) · blocker for "injured patient in Unity". After
`apply_skin_overlay(overlay.png, arms, 60)`, the hands rendered red-pink in CC5 and Std_Skin_Arm's Diffuse Blend
read 0.6. Chad had Soldier_Pale_01 re-saved and re-exported (`export_for_unity`, 10:28, 43 files rewritten). The
export carries no trace of the overlay. None of the 42 textures is a blend or overlay image. `Std_Skin_Arm_Diffuse.jpg`
averages (150, 109, 91), like the body (154, 109, 86), head (150, 115, 99) and legs (149, 107, 90), where a baked 60%
multiply of (128, 48, 48) would roughly halve green and blue. The FBX never mentions `overlay.png`: its arm material
references only `Std_Skin_Arm_Diffuse.jpg` and `Std_Skin_Arm_Normal.png`. No sidecar file was written. So injuries
made with `apply_skin_overlay` exist only in the CC5 scene, and the Unity patient arrives without them. The tool
reported "Exported ... Switch to Unity to import it." The pale condition is a Digital Human skin shader offset
(`_BaseColorMap Brightness` / `Saturation`) that FBX cannot carry, so it is probably lost too (superseded by P9-13
below: it is lost). This defeats the project goal "injury skin overlays
... exported into Unity" (plan, `docs/superpowers/plans/2026-10-02-exonicus-extensions.md`). Fix directions: bake the
overlay and the skin condition into the diffuse textures before or during export (CC5's texture bake, or compose the
Diffuse and Blend images in the plugin and write them in place of the exported `*_Diffuse` files), or export the
overlay as its own texture with a Unity-side material that blends it. `export_for_unity` and `check_quest_budget`
should at least warn when the character has overlays or skin-condition offsets the FBX will not carry.
P7-11: the export to `...\UnityTest_6.2\Assets\Patients\PromptPatient` (10:37) is the same: no reference to
`overlay.png` in `PromptPatient.fbx`.
P9-13 / P9-16: the pale condition does not reach the export either. The exported `Std_Skin_Head/Body/Arm_Diffuse.jpg`
files are byte-identical (same MD5) across five exports covering three skin states:
- TestPatient: pale 0.6, overlay on all skin at 60.
- Refused: TestPatient's saved base, the same state as TestPatient.
- Batch_Pale: pale 0.9, the same overlay.
- PromptPatient and Soldier_Pale_01: pale 0.8, arm overlay at 60.

Pale 0.6, 0.8 and 0.9 give the same files, so the export bakes no pallor. Pallor lives only in two Digital Human
shader offsets (`cc5_skin.py:28`). CC5 writes them into the Blender export's JSON (`exports\blender\TestPatient.json`:
`_BaseColorMap Brightness` 0.036 and `Saturation` -0.15 on the four skin materials), but the Unity export writes them
nowhere. Unity uses these textures in Standard materials, so the Unity patients show the texture's colour without
pallor (from the files; nothing was rendered).

**F-76: the Unity folder check only looks for a folder named Assets** (P7-11; by the code, not run) · minor. The
runbook's first P7-11 path, `C:\CC5Test\UnityTest\Assets\Patients`, is not a Unity project: `C:\CC5Test\UnityTest`
does not exist. Chad corrected it before the call. Both checks would have accepted it. `isInUnityAssets`
(`src/tools/unity.ts:24`) and `is_in_unity_assets` (`cc5_pipeline.py:42`) only look for a path segment named
`Assets`, and `export_for_unity` then runs `os.makedirs` and exports. The result would have been a 63 MB export into a
folder no Unity project sees, reported as "Exported ... Switch to Unity to import it." Fix: require an existing
Unity project around that Assets folder (a `ProjectSettings` folder, or `ProjectSettings/ProjectVersion.txt`, beside
it), else refuse with "not inside a Unity project", naming the folder that was checked.

**F-77: batch variants lose the base's facial expression** (P7-15) · bug, cause to confirm. TestPatient was built with
Brow_Compress_L/R 0.6, Mouth_Frown_L/R 0.4 and Eye_Squint_L/R 0.3 (read back exactly) and saved with
`save_character` (`C:\CC5Test\saves\TestPatient.ccAvatar`). `batch_generate_patients` (Batch_Pale: pale 0.9;
Batch_Seated: `1.Male Pose/Sitting_Floor.rlPose`) reported 2/2 OK, and both passed the budget (37,644 triangles,
20/20 materials, 40.1 MiB). The scene's character afterwards, the reloaded base plus Batch_Seated's pose, read 0 on
all six expression sliders and showed a neutral face. Its pale 0.6 and overlays (0.6) did come back from the save, so
the variants did not leak into each other: pale 0.9 stayed in Batch_Pale. Two possible causes: the `.ccAvatar` does
not store the expression, or applying the pose reset it. Check: reload TestPatient.ccAvatar with no pose and read the
six weights. If they are 0, `save_character` should say expressions are not saved (and the batch should re-apply the
base's expression or warn); if the pose resets them, `apply_pose` should say so or restore them. Either way a
batch-made patient comes out neutral-faced while the report says OK. Also: the batch FBXs carry no overlay (F-75).
Confirmed (P7-16): `apply_character_recipe({base: TestPatient.ccAvatar})`, with no pose and nothing else, read 0 on all
six sliders at time 0, the same time and getter that read 0.6 / 0.4 / 0.3 right after the recipe set them. The other
saved state came back: Body Thin 0.35, pallor 0.036 / -0.15, overlay 0.6. So the expression does not come back through
`save_character` plus `load_asset` (`RSaveFileSetting`, `ESaveFileType_Character`; whether the file lacks it or the
scripted load drops it is not separated); the pose is not needed to lose it. Fix: `save_character`
says that the expression is not saved, and `batch_generate_patients` either re-applies the base's expression to each
variant (read the weights before the batch, or take them as a parameter) or warns. Variants can already carry an
`expression` step in their recipe. A project save (`.ccProject`) may keep it; untested.
P8-10 (extra check): `TestPatient_Seated.ccAvatar` was saved at 13:03:31 while TestPatient sat in the Sitting_Floor
pose (captures `cc5_viewport_1791306181894.png`, `...1791306200775.png`). It was reloaded with `apply_character_recipe`
base only: every avatar deleted, then `load_asset`, which calls `RFileIO.LoadFile(path)` without options
(`cc5_api.py:480`). It stands (`...1791306250903.png`), in the arms-down stance CC5 gives any freshly loaded character,
not the arms-out bind pose of F-83. So the pose does not come back either. Not yet separated: whether the file lacks
the pose or CC5's scripted load drops it. Decisive test (Chad, by hand): open `TestPatient_Seated.ccAvatar` in CC5
directly; if it comes back seated, the fix belongs in `load_asset`. The pose half has no batch consequence
(`batch_generate_patients` re-applies a variant's `pose_file`); for `save_character` it is a documentation gap.

**F-78: Part 7's Unity paths point to a folder that does not exist** (P7-11, P7-15, P7-17) · runbook. The runbook
uses `C:\CC5Test\UnityTest\Assets\Patients` (export, batch) and `C:\CC5Test\UnityTest\Assets\Patients\Batch\patients_manifest.json`
(by hand). `C:\CC5Test\UnityTest` does not exist; the Unity project is `C:\CC5Test\unity\UnityTest_6.2` (Unity
6000.2.10f1; `UnityTest_6.3` sits beside it). Chad corrected the export and the batch to
`C:\CC5Test\unity\UnityTest_6.2\Assets\Patients`; the manifest is at
`C:\CC5Test\unity\UnityTest_6.2\Assets\Patients\Batch\patients_manifest.json`. Fix the runbook paths. Left as they
were, the export and the batch would have written into a folder no Unity project sees (F-76). `C:\CC5Test\saves` did
not exist either; `save_character` created it.

**F-79: a batch variant with an empty recipe is not refused** (P7-18) · gap. Runbook: "testing a refusal: ...
batch_generate_patients ... one variant named Refused and an empty recipe". Into `C:\CC5Test\exports\batch` it was
refused, but only for the folder ("unity_dir must be ... inside a Unity project's Assets folder"), twice, with nothing
written. Into the real project (`C:\CC5Test\unity\UnityTest_6.2\Assets\Patients\Batch`, Chad: "use the correct
folder") it ran: TestPatient reloaded, no steps, exported as `Refused\Refused.fbx` (40 files, 45 MB), with a passing
budget, and the manifest recorded `"steps": []` and `"ok": true`. By the code, neither `BatchSchema` nor
`RecipeSchema` (`src/tools/batch.ts:27`, `src/recipe.ts:28`) refuses an empty recipe. An unchanged copy of the base can
be useful as a control patient, but here it was a mistake, and nothing said the variant did nothing. Fix: refuse
a variant whose recipe has no steps ("variant Refused has an empty recipe: it would export the base unchanged"), or
at least report "no steps: exported the base unchanged".

**F-80: a second batch overwrites the folder's manifest** (P7-18) · bug. `batch_generate_patients` writes
`<unity_dir>/patients_manifest.json` from a new manifest object each run (`fs.writeFileSync`, `src/tools/batch.ts:140`).
The empty-recipe batch above went into the folder that already held Batch_Pale and Batch_Seated from P7-15. Their
export folders stayed, but the manifest now lists only "Refused". So the manifest no longer describes the folder, and
any tool reading it (a Unity import step, a later budget review) loses the earlier patients. The P7-15 manifest is
kept in the session scratchpad (`patients_manifest.batch1_backup.json`). Fix: merge into the existing manifest,
replacing entries by name and keeping the others with their own `created` time, or write one manifest per batch
(`patients_manifest_<time>.json`) plus an index.
After the run, Chad chose to restore the manifest. It was merged by hand to list Batch_Pale, Batch_Seated (created
14:43:06Z) and Refused (14:50:54Z), each with its own `created` time and a top-level `note`. Both earlier versions are
kept in the scratchpad.

**F-81: a recipe's base step empties the scene before it checks the base** (P7-19; by the code, not run) · bug. P7-19
gave `apply_character_recipe` a base that does not exist
(`C:\CC5Test\unity\UnityTest_6.2\saves\TestPatient.ccAvatar`; the save is at `C:\CC5Test\saves\`). Chad chose the real
path, so the failure was not run. In `src/recipe.ts:96-110` the base step first deletes every avatar in the scene, and
only then calls `load_asset`, whose plugin side reports the missing file. `RecipeSchema.base` checks only that the
path is local and absolute. A mistyped or missing base would therefore delete the user's current, possibly unsaved,
character and then fail, leaving an empty scene. `batch_generate_patients` deletes and loads the same way
(`src/tools/batch.ts:75-82`), but its base is meant to exist. Fix: check that the base file exists, with an allowed
extension, before deleting anything; refuse with "base not found: <path>" and leave the scene alone.

### Part 8 (2026-10-06, Pose, save, Quest budget; run by Claude alone)

Chad asked Claude to run Parts 8-10 unattended. Setup deviations from the runbook:
- CC5 was started by Claude with `CC5_RECOVERY_ANSWER=cancel` and `CC5_ALLOW_EXEC=1`, not the normal way (this
  matters for 10.4).
- The Unity projects are `C:\CC5Test\unity\UnityTest_6.2` and `C:\CC5Test\unity\UnityTest_6.3`, not
  `C:\CC5Test\UnityTest` / `UnityTest63` (F-78, Chad's correction in Part 7).

The scene starts with TestPatient: Kevin, ID 6095589271296, reloaded from `C:\CC5Test\saves\TestPatient.ccAvatar`.

Build under test: plugin and MCP server at `db0358d`, in the same CC5 process as Parts 6-7 (started 06:40:24 by
Claude with `CC5_ALLOW_EXEC=1` and `CC5_RECOVERY_ANSWER=cancel`; not restarted the normal way, because a restart needs
Chad). Evidence: `C:\CC5Test\evidence\flight-01\` (captures, Unity and Blender reports and logs, crops). `exec_python`
calls, all read-only except 10.8: file and image checks (QImage sizes and pixels, export folder sizes), material and
expression read-backs, CC5 menu and dialog inspection, the candidate search behind 10.6 (no trigger), the environment
read in 10.4, and 10.8's close of SkinGen's About box.

| Step | Result | What happened |
|---|---|---|
| 8.1 | PASS | "Saved C:\CC5Test\saves\TestPatient.ccAvatar"; 127,739,517 bytes, written 13:01:29 |
| 8.2 | PASS | "Unsupported file type .txt. Allowed: .ccavatar"; no TestPatient.txt in saves |
| 8.3 | PASS | "PASS — Quest budget", Triangles 37,644 / 65,000, Materials 20 / 20, "(no texture images scanned)" |
| 8.4 | PASS | "FAIL — Quest budget" (as an error), OVER Triangles 37,644 / 30,000, OVER Materials 20 / 10 |
| 8.5 | PASS | "NOT CHECKED — Quest budget: the triangles of a sub_d_level 1 export cannot be counted from the scene (everything else is within budget)", "roughly 150,576", then 8.3's lines |
| 8.6 | PASS | "export_folder must be an existing local absolute folder (no network/UNC paths): C:\CC5Test\exports\does-not-exist", no budget lines |
| 8.7 | PASS | 2 hits: "[pose] C:/Users/Public/Documents/Reallusion/Reallusion Templates/Animation/Pose/1.Male Pose/Sitting_Floor.rlPose" and the 2.Female Pose one |
| 8.8 | PASS | "Applied pose Sitting_Floor.rlPose (LoadFile)" (male pose); the capture shows TestPatient sitting on the floor |
| 8.9 | PASS | "Failed: File not found: C:\CC5Test\inputs\nope.rlPose", then "Unsupported file type .png. Allowed: .rlmotion, .imotion, .rlpose, .ipose, .imotionplus, .ccpose, .ccmotion"; still sitting (capture) |
| 8.10 | PASS | "Saved C:\CC5Test\saves\TestPatient_Seated.ccAvatar", 127,721,424 bytes, 13:03:31, beside TestPatient.ccAvatar. Extra check, since the runbook's note says this was never checked: reloading it (`apply_character_recipe` with base `C:\CC5Test\saves\TestPatient_Seated.ccAvatar` only) gives a STANDING Kevin, so the pose does not survive save_character plus load_asset (F-77; save and load not yet separated). The pose was re-applied for Part 9. |
| 8.11 | PASS | Same as 8.3: "PASS — Quest budget", 37,644 / 65,000 triangles, 20 / 20 materials |

Part 8: 11 of 11 PASS. No new findings. One extension to F-77: a posed character saved as `.ccAvatar` reloads standing
(runbook 8.10's note can say so).

### Part 9 (2026-10-06, exports, Unity, Blender, round trips; run by Claude alone)

TestPatient was sitting (Sitting_Floor re-applied after the 8.10 check). This CC5 session had already survived six
FBX exports, so under the runbook's crash rule a crash here would be a FAIL.

| Step | Result | What happened |
|---|---|---|
| 9.1 | PASS | 8 meshes: CC_Base_Tongue, CC_Base_Body, CC_Base_TearLine, CC_Base_EyeOcclusion, CC_Base_Teeth, CC_Base_Eye, Boxers, Male_Brow_2 |
| 9.2 | PASS | "Saved C:\CC5Test\saves\TestPatient_Seated.ccAvatar"; "FBX exported to: C:\CC5Test\exports\fbx\TestPatient.fbx (target=Unity)", "Notes: target_tool=Unity preset applied; SetExportLevel(0) applied". FBX 11.8 MB plus TestPatient.fbm (39 images). Same CC5 process (started 06:40:24); bridge answered 11 s later |
| 9.3 | PASS | "Convert Image Format is not available: CC5 5.13 crashes a moment after any scripted FBX export that converts image formats, so the bridge never asks for it. Export without convert_image_format; the textures keep their source formats." No Convert.fbx; CC5 up. Runbook note: the reply has no "CC5 bridge error:" prefix now (the MCP server refuses before CC5) |
| 9.4 | PASS | "Exported C:\CC5Test\unity\UnityTest_6.2\Assets\Patients\TestPatient\TestPatient.fbx (40 files, 44.8 MB total). Switch to Unity to import it." (path corrected per F-78; arguments TestPatient, sub_d_level 0, texture_size 2048) |
| 9.5 | PASS | "PASS — Quest budget", Triangles 37,644 / 65,000, Materials 20 / 20, GPU 40.1 / 66 MiB, 34.0 MiB on disk, 0 over 2048 px, 0 unreadable |
| 9.6 | PASS | "unity_dir must be inside a Unity project's Assets folder: C:\CC5Test\exports\unity"; no folder created |
| 9.7 | PASS | "Exported ...\TestPatient_Posed\TestPatient_Posed.fbx (40 files, 45.2 MB total). The pose is a one-frame animation clip in the FBX, and Unity shows the imported model in that pose with a Generic or Humanoid rig. For a Humanoid rig, copy the avatar from an unposed export ... Switch to Unity to import it." |
| 9.8 | PASS | "Still running in CC5 (job cmd_3392da7b_502). Call job_status with job_id "cmd_3392da7b_502" to get the result. Do not start the same operation again." Job id: cmd_3392da7b_502 |
| 9.9 | PASS | "Finished (export_for_unity):" with "success": true, fbx ending TestPatient_Job\TestPatient_Job.fbx, 40 files, notes ["target_tool=Unity preset applied"], "texture_size": 4096. Runbook note: this export is the same size as the 2048 one (44.8 MB, skin textures 2048 x 2048), because `texture_size` is a maximum and CC4 Kevin's sources are 2048; the setup section's "the 4096 export in 9.8 is larger" does not hold for Kevin |
| 9.10 | PASS | "Job cmd_00000000_1 not found. CC5 was probably restarted and the job's result is lost. Check the output folder, then run the operation again." |

The by-hand Unity and Blender steps (9.11-9.16, 9.18, 9.19, 9.30-9.36: 15 steps) were checked by script, not by eye:
- The repo's `scripts/e2e/Editor/E2EImportCheck.cs` was copied into the runbook's test projects
  `C:\CC5Test\unity\UnityTest_6.2` and `UnityTest_6.3` (Assets/Editor; still there after the run).
- `Unity.exe` (6000.2.10f1; 6000.3.21f1 for 9.30-9.36) ran with `-batchmode -nographics ... -executeMethod
  E2EImportCheck.Run`, re-importing each FBX. It reported importer errors and warnings, rig type, renderers, triangles,
  materials with main texture, bones, clips, and head/hand/foot bone positions (as imported and after sampling the
  first clip).
- The Blender steps (9.18, the Blender half of 9.19) ran `blender_check.py` headless in Blender 5.2.2.
- Logs and reports: `C:\CC5Test\evidence\flight-01\reports` (e2e-unity-62.log, e2e-unity-62-blender.log,
  e2e-unity-63.log, and the Unity and Blender JSON reports).
- Nothing was rendered (Unity ran with -nographics). The Scene-view checks are answered from these numbers, not seen:
  posed = the head bone more than 5 cm from an unposed export of the same character; textured = every material has a
  main texture, in projects on the Built-In pipeline (Standard shader); nothing pink (Blender) = every image file
  exists on disk (not decoded); Console = no error during the forced re-import and no error line in the batch log
  apart from licensing-client lines and `LogAssemblyErrors` timing labels.

| Step | Result | What happened |
|---|---|---|
| 9.11 | PASS (by script) | Unity 6000.2.10f1 imported Assets/Patients PromptPatient, TestPatient, TestPatient_Posed, TestPatient_Job, Batch (Batch_Pale, Batch_Seated, Refused, patients_manifest.json), plus CC5Patients/Soldier_Pale_01: 8 models, 0 errors. TestPatient and TestPatient_Job each give one WARNING, "contains animation clip 'Default' which has length of 0 frames" (F-82); the runbook says testing saw 0 warnings (warnings are not red errors; the runbook's 0-warning figure comes from a run that exported before applying the pose) |
| 9.12 | PASS (by script) | TestPatient.fbx: animation type Generic, 8 SkinnedMeshRenderers, 85 bones, bind pose (head, hands and feet at the same positions as the standing Batch_Pale export) |
| 9.13 | PASS (by script) | 20 materials, 20 with a main texture; the 4 skin materials (Standard shader) use Std_Skin_Head/Body/Arm/Leg_Diffuse. Note asked by the runbook (answered from the files, not seen in Unity): pallor does not reach Unity. The exported Std_Skin_Head/Body/Arm_Diffuse.jpg files are byte-identical at pale 0.6 (TestPatient, Refused), 0.9 (Batch_Pale) and 0.8 (PromptPatient, Soldier_Pale_01), and the Unity export writes no file that holds the shader offsets. The overlay is missing too (P7-10, F-75). Skin textured in the Scene view: not seen (no render) |
| 9.14 | PASS (by script) | Triangle total 37,644 = 9.5 (Body 28,092, Teeth 4,842, Eye 1,280, Boxers 1,212, Brow 1,066, Tongue 592, EyeOcclusion 288, TearLine 272) |
| 9.15 | PASS (by script) | TestPatient_Posed.fbx: posed as imported, as dragging it into the scene shows it (head 93.5 cm, hands 108-135 cm from TestPatient's; sampling its clip changes nothing), the same bone positions as Batch_Seated (Sitting_Floor); not compared by eye with CC5, one clip "2026_10_6_13_6_43", 37,644 triangles, 20 materials, 0 errors, 0 warnings |
| 9.16 | PASS (by script) | Batch_Pale, Batch_Seated, TestPatient_Job, PromptPatient: all imported, 0 errors, 20/20 materials with main texture; Batch_Seated sits (same bone offsets as TestPatient_Posed, clip "2026_10_6_10_43_25"); Batch_Pale and TestPatient_Job stand (0 cm); PromptPatient stands: its head, hand and foot bones are where Soldier_Pale_01's are (0 cm, same character; against TestPatient the head is 1.4 cm and the hands 7.8 cm away, a different build), 10 renderers, 45,774 triangles, and 20 distinct materials although `check_quest_budget` counted 22 (F-73). Note: by the files, Batch_Pale is not paler than TestPatient in Unity (identical skin diffuse files, same Standard materials; not rendered, material colour not recorded; F-75) |
| 9.17 | PASS | "FBX exported to: C:\CC5Test\exports\blender\TestPatient.fbx (target=Blender)", "Notes: target_tool=Blender preset applied; SetExportLevel(0) applied"; TestPatient.fbx 11.8 MB, TestPatient.json 235 KB, TestPatient.fbm 60 images. Runbook note: export_motion defaults to true, so this Blender-preset FBX carries a motion take (FromBlender's only clip is "Armature\|Armature\|2026_10_6_13_8_36", first frame a T-pose); pass export_motion false for a mesh-only Blender export, or include_current_pose to keep the pose |
| 9.18 | PASS (by script) | Blender 5.2.2: 1 Armature (101 bones), 8 mesh objects, 37,644 triangles (= 9.5), 62 of 62 image references point to files on disk (60 distinct files plus 2 .001 duplicates; not decoded, so 'nothing pink' is inferred), all 20 materials with image textures |
| 9.19 | PASS (by script) | Blender wrote TestPatient_from_Blender.fbx (14.8 MB) and its .fbm (Path Mode Copy, embed off); copied to Assets/Patients/FromBlender/TestPatient_from_Blender/. Unity: 0 errors, 0 warnings, Generic, 101 bones, 37,644 triangles, 20 materials, all with a main texture. Blender exported from an empty factory scene; by hand, delete Blender's default Cube, Camera and Light first or they are exported too (runbook note). FromBlender rests in a T-pose with the arms horizontal (hands about 30 cm higher than in TestPatient.fbx), unlike every CC5 Unity export |
| 9.20 | PASS | "Exported mesh and 61 files to C:\CC5Test\exports\substance\TestPatient"; TestPatient.fbx plus 33 jpg and 27 png in their source formats; no settings warning |
| 9.21 | PASS | "Applied Substance textures from C:\CC5Test\exports\substance\TestPatient"; captures before and after differ by at most 4/255 (0 of 141,900 pixels by more than 6/255); whether CC5 loaded any file was not checked (same textures); CC5 answers |
| 9.22 | SKIP | Optional: needs a mark painted by hand in Substance Painter (installed, but the step is manual and the run was unattended) |
| 9.23 | PASS | "GoZ files written to C:\CC5Test\exports\goz (7 files)", no pose WARNING: CC_Base_Body.GoZ 872,432 bytes (the runbook's 872 KB), Eye, EyeOcclusion, Lower_Teeth, TearLine, Tongue, Upper_Teeth; none 0 KB; no stray gozCC_Base_ files in exports |
| 9.24 | N/A | Not run: loading the GoZ by hand in ZBrush. ZBrush 2025/2026 is installed, so the runbook's "without ZBrush, SKIP" does not apply; a by-hand step in an unattended run. 9.23 checked the GoZ files |
| 9.25 | PASS | "Exported C:\CC5Test\exports\obj\TestPatient.obj", no WARNING; 3.28 MB with group CC_Base_Body; bounding box 159 x 180 x 34 cm: the standing arms-out bind pose although CC5 showed the sitting pose (expected) |
| 9.26 | PASS | "Failed: Unknown mesh 'NoSuchMesh'. Meshes: CC_Base_Tongue, CC_Base_Body, CC_Base_TearLine, CC_Base_EyeOcclusion, CC_Base_Teeth, CC_Base_Eye, Boxers, Male_Brow_2" (= 9.1); nothing changed |
| 9.27 | FAIL | "Replaced CC_Base_Body with TestPatient.obj", but the body did NOT look the same: it stood arms-out in the bind pose while the rest of the character (eyes, teeth, Boxers) stayed seated; the eyes and teeth floated at thigh height and the Boxers lay at the feet; the hip faces CC5 hides under the Boxers showed as a gap in the body (F-83). Not a crash. Recovered in 9.29 |
| 9.28 | SKIP | Optional: needs zbrush_body.obj sculpted by hand in 9.24 |
| 9.29 | PASS | "All 1 steps succeeded." / "OK   base"; TestPatient back as saved in 8.1, standing, original body (capture) |
| 9.30 | PASS (by script) | Copied `UnityTest_6.2\Assets\Patients` (324 files + 342 .meta) into `C:\CC5Test\unity\UnityTest_6.3\Assets`; Unity 6000.3.21f1 (batch mode) imported PromptPatient, TestPatient, TestPatient_Posed, TestPatient_Job, Batch (Batch_Pale, Batch_Seated, Refused, manifest) and FromBlender: 8 models, 0 import errors. The only log lines with "error" are Unity licensing-client messages (handshake, access token) and `LogAssemblyErrors (0ms)` timing labels, in both versions' logs. The project uses the Built-In pipeline (Standard shader) |
| 9.31 | PASS (by script) | As 9.12: TestPatient Generic, 8 SkinnedMeshRenderers, 85 bones, bind pose |
| 9.32 | PASS (by script) | As 9.13: 20 materials, 20 with main texture, the same Standard shader and texture files as in 6.2. Both versions get the same shader and texture assignments, and both projects use the Built-In pipeline; material colours were not recorded and nothing was rendered |
| 9.33 | PASS (by script) | 37,644 triangles = 9.5 = 9.14 |
| 9.34 | PASS (by script) | As 9.15: TestPatient_Posed posed (head 93.5 cm from TestPatient's), one clip "2026_10_6_13_6_43", 37,644 triangles, 20 materials, 0 errors |
| 9.35 | PASS (by script) | As 9.16: Batch_Pale and TestPatient_Job stand, Batch_Seated sits, PromptPatient stands; all 0 errors and textured. Same two "Default" 0-frame warnings as in 6.2 (TestPatient, TestPatient_Job; F-82) |
| 9.36 | PASS (by script) | As 9.19: FromBlender 0 errors, 0 warnings, Generic, 101 bones, 37,644 triangles, 20 materials all with a main texture |

Part 9: 32 PASS (15 of them by script: 9.11-9.16, 9.18, 9.19, 9.30-9.36), 1 FAIL (9.27, F-83), 2 SKIP (9.22, 9.28:
optional manual Substance Painter / ZBrush work), 1 N/A (9.24: by-hand ZBrush step not run). Crash rule: six more FBX
exports ran (9.2, 9.4, 9.7, 9.8, 9.17, 9.20), 12 in this CC5 session, and none crashed. New findings: F-82, F-83, and
the F-75 confirmation (from the files) that pallor is lost too. Runbook notes: 9.3's reply no longer has the "CC5
bridge error:" prefix; the 4096 export in 9.8/9.9 is not larger for CC4 Kevin; 9.11's "testing saw 0 warnings" does
not hold when TestPatient is exported while sitting (F-82); 9.17's Blender export carries a motion take (export_motion
defaults to true); 9.19 needs Blender's default objects deleted first; the Unity paths (F-78). Unity 6.2 and 6.3
import the same files identically.

**F-82: unposed Unity exports made while the character sat carry a zero-length animation take** (P9-11) · minor,
cause not confirmed. In Unity 6000.2.10f1, `TestPatient.fbx` (9.4) and `TestPatient_Job.fbx` (9.8) each gave one
importer warning: "Model 'TestPatient' contains animation clip 'Default' which has length of 0 frames (start=0, end=0).
It will result in empty animation." Same warning in Unity 6000.3.21f1 (9.35). Both were exported without
`include_current_pose` while CC5 showed the Sitting_Floor pose. Every unposed export carries a take named "Default".
In the four of a standing character (Batch_Pale, Refused, PromptPatient, Soldier_Pale_01) it is one 60-fps frame long
(FBX LocalStop 769,769,300 ticks), and Unity accepts it. In TestPatient and TestPatient_Job, LocalStop is 0. The runbook
says testing saw 0 warnings per model; its automated run exported the unposed model before applying the pose. The pose
is the likely cause, but these exports also differ in the base file (the Part 9 character was reloaded from
TestPatient_Seated.ccAvatar in 8.10; the batch reloads TestPatient.ccAvatar) and in sub_d_level (9.8 ran without it).
Ruled out: texture_size, wait_seconds, a stale Unity .meta, a different CC5 process. Untested: every mesh-only Unity
export still sets `EExportFbxOptions_TPoseOnMotionFirstFrame` (`cc5_api.py:652-653`). To confirm: in one CC5 session,
export TestPatient.ccAvatar standing, again after `apply_pose` Sitting_Floor, and again after undo; repeat with that
option bit cleared. Fix candidates, to be checked live: pass `motion_range [0, 0]` for mesh-only exports too
(`cc5_pipeline.py:105` passes None; the posed export with [0, 0] got a valid one-frame take), or clear the T-pose bit
when motion is off; otherwise say in the reply that the pose shown in CC5 is not exported. The model imports fine, but
a pipeline that treats warnings as failures would reject it.

Probe (15:02-15:04, after Part 10): `exec_python` called `cc5_api.export_fbx` with `export_for_unity`'s arguments
(files in `C:\CC5Test\probe\f82`; takes read from the FBX files with a script). One CC5 session, one base
(TestPatient reloaded from `TestPatient.ccAvatar` in 9.29), sub_d_level 0, texture_size 2048:
- E1, standing: one motion clip of 100 time units (CC5 counts 6,000 per second: one frame at 60 fps), project
  length and end time 100. Take: one frame (LocalStop 769,769,300).
- E2, after `apply_pose` Sitting_Floor: the clip, the project length and the end time all read 0. Take: zero-length.
  This is the cause.
- E3, posed, `motion_range [0, 0]`: zero-length. E4, posed, T-pose option bit cleared: zero-length. Both fix
  candidates above are ruled out.
- E5, posed, project length and end time set to one frame for the export (`RGlobal.SetProjectLength` /
  `SetEndTime` with `GetFps().IndexedFrameTime(1)`), both restored after it (read back 0 / 0): take one frame, the
  same stack values as Batch_Pale. Unity 6000.2.10f1 (headless, 15:29) imported E5 with no warning and E2 with the
  0-frame warning (copies in a temporary `Assets/Probe` folder of UnityTest_6.2, removed afterwards).

Fix: in the mesh-only path of `export_for_unity` (and any mesh-only FBX export), when the project end time is under
one frame, set the project length and end time to one frame for the export and restore both in a `finally`. The
pose is not exported either way (a mesh-only export is in the bind pose; include_current_pose exports it). The
two setters clear CC5's undo history, but every FBX export already does (F-86), so the fix costs nothing extra
inside an export. Outside one (for example in `apply_pose`) it would.

**F-83: the OBJ round trip distorts the body** (P9-27) · blocker for the sculpt round trip (`export_obj` → edit →
`replace_mesh_from_obj`). `export_obj` writes the bind pose (`EExport3DFileOption_ResetToBindPose`,
`cc5_pipeline.py:299-302`; the comment at 297-298 assumed ReplaceMesh needs the bind pose). `replace_mesh_from_obj`
calls `RIAvatar.ReplaceMesh(mesh, obj, False, False)`, whose two flags are `bSplitObjects` and `bAutoRig`, with no pose
option (`cc5_pipeline.py:503`; rlpy-api-reference.md:2669). No ReplaceMesh variant takes a pose: `RIMesh.ReplaceMesh`
(3238) takes an `EReplaceMeshOption`, which is only YUp or ZUp (1271-1274), plus bReplaceUv; `RIProp.ReplaceMesh`
(3521) takes no options. CC5 behaves as if it takes the OBJ's vertices as the mesh in the character's current pose
(9.27 showed the OBJ's shape unchanged while the skeleton sat). This is not yet separated from a second reading: the OBJ
taken as the mesh in CC5's arms-down default stance, with 9.27's view not refreshed. A posed replace followed by a pose
change would decide it. Live, with no edit made to the OBJ:
- 9.27, TestPatient sitting: the body jumped to the standing arms-out bind pose while the eyes, teeth and Boxers stayed
  seated.
- Extra check, TestPatient reloaded standing: after the replace, the arms stood out about 30° below horizontal (the
  OBJ's fingertips are at x ±79.5 cm, y 112.5 cm). The Boxers did not move, so the skeleton presumably kept CC5's
  arms-down stance.
- Then Sitting_Floor applied: the body followed the skeleton (still skinned), but the arms twisted over the head,
  because the pose was applied on top of the already-rotated arm shape.

Every time the reply was "Replaced CC_Base_Body with TestPatient.obj". The runbook's note says testing had checked only
that message. Captures (copies in `C:\CC5Test\evidence\flight-01\captures`): `cc5_viewport_1791306838190.png` (9.27),
`...1791306902293.png` and `...1791306914374.png` (standing, before and after), `...1791306933829.png` (posed after),
`...1791306986565.png` (reload). Fix, to be checked live: export and replace in the same pose. Either `export_obj`
writes the current pose (drop `ResetToBindPose`) and the character keeps that pose until the replace, or the character
is put into its bind pose before `ReplaceMesh` (no RLPy call for this is documented, and the unposed character stands
arms-down, not in the bind pose). Check before the replace: compare the OBJ with a fresh export of the mesh in the pose
ReplaceMesh reads, and refuse on a vertex-count or pose mismatch, so nothing changes. Check after it: a fresh export
must match the OBJ; on a mismatch, undo and fail (undo of ReplaceMesh is untested; 9.29 recovered by reloading). 9.28
(skipped) should hit the same mismatch, and the bind-pose option would not cover it: `export_goz` defaults to `tpose`,
and the bind pose has the arms about 30° down, not horizontal. Until that is handled, `export_goz`'s description
(`pipeline.ts:89`) should stop sending ZBrush output through `replace_mesh_from_obj`.

Probe (15:05-15:10, after Part 10; files in `C:\CC5Test\probe\f83`; OBJs compared vertex by vertex with a
script). TestPatient, reloaded from `TestPatient.ccAvatar`, sat in Sitting_Floor:
- `ExportObjFile` cannot write the current pose. Without `ResetToBindPose` it wrote a T-pose (arms horizontal,
  x ±88.6 cm); with it, the bind pose (x ±79.6 cm). Neither file was seated. The two bodies differ by up to
  36.5 cm (mean 9.1 cm; 4,571 of 14,164 vertices more than 1 cm).
- `replace_mesh_from_obj` with the T-pose OBJ while seated: the body showed the OBJ's standing shape (capture
  `after_replace_tposeobj_seated.png`, as in 9.27). A bind-pose export afterwards was wrecked: y -15.7 to 260.5 cm,
  z -99 to 118 cm, every vertex moved (mean 101 cm). So CC5 takes the OBJ as the mesh in the current pose and
  rebuilds the rest shape from it through the seated skeleton. The other readings are ruled out: an OBJ taken as
  the bind-pose mesh or as the T-pose mesh would have left the bind export at most 36.5 cm off (or exact), and one
  taken in the arms-down stance would have left the legs in place.
- One `undo` reversed the replace exactly (bind export equal to the original, max 0.00 cm).
- `RISkeletonComponent.DeleteClip` on the pose clip (the only clip): Kevin then stood in a T-pose (capture
  `no_clip.png`), the shape of the no-flag OBJ.
- `replace_mesh_from_obj` with the T-pose OBJ in that state: exact round trip. The bind export equals the original
  (max 0.00 cm), a T-pose re-export equals the input OBJ (0.00 cm), and the Boxers moved at most 0.22 cm.
- Restored: Kevin reloaded from `TestPatient_part10.ccAvatar` (new ID 6095569715456), body equal to the original.

Fix (replaces the fix above): `export_obj` writes the T-pose (drop `ResetToBindPose`), and `replace_mesh_from_obj`
replaces only while the character has no motion clip. A freshly loaded character has one too (the one-frame
arms-down stance), so this covers standing characters as well. Proposed: delete pose clips (0 or 1 frame) in the
same undo step and say that the pose was removed (the character stands in a T-pose until a pose is applied again);
refuse when a longer clip (an animation) exists, since deleting it loses work (Chad, 2026-10-06: DEC-9). Before the
replace, compare the OBJ with a T-pose export of the current mesh. Refuse on a different vertex count, or when the
shapes differ like a different pose (a bind-pose OBJ is 36.5 cm off at the hands), so nothing changes. After the
replace, a T-pose re-export must equal the OBJ (unedited: 0.00 cm); otherwise undo (one step, checked above) and
fail. The post-check alone cannot catch a wrong-pose OBJ: CC5 re-exports whatever it was given. 9.28: GoZ exports
default to `tpose`; whether ZBrush's OBJ of a GoZ T-pose matches CC5's T-pose is untested.

### Part 10 (2026-10-06, advanced and switched-off tools; run by Claude alone)

TestPatient was reloaded in 9.29. CC5's menus have ActorMIXER PRO ("Create Mixer Assets", `qtCreateMixerSliderAction`),
"SkinGen Premium" (About, Online Manual, Video Tutorial, "Remove SkinGen Data"; no item named Skin Editor), "Export
Head" (`qtExportHeadAction`) and Headshot 3. Deviation: CC5 runs with `CC5_ALLOW_EXEC=1` (read inside CC5:
`CC5_ALLOW_EXEC='1'`, `CC5_DEV_MODE` unset, `CC5_RECOVERY_ANSWER='cancel'`).

| Step | Result | What happened |
|---|---|---|
| 10.1 | PASS | "Found 1 avatar(s): - Kevin (ID: 6095589363968)"; "Saved C:\CC5Test\saves\TestPatient_part10.ccAvatar", 127,720,170 bytes, 13:18:10. Name Kevin, ID 6095589363968 |
| 10.2 | PASS | "headshot_from_photo is switched off because it crashed Character Creator 5. Make the head by hand instead: use the Headshot plugin inside Character Creator 5."; no window, head unchanged |
| 10.3 | PASS | "import_fbx with kind 'character' is switched off because it crashed Character Creator 5. Import the whole character by hand instead: use File > Import in Character Creator 5. Importing a 'prop' or 'clothing' still works."; scene unchanged (same 9 objects), no window |
| 10.4 | FAIL (environment) | "Result: 42": CC5 was started by Claude with `CC5_ALLOW_EXEC=1` (confirmed in CC5's environment), not the normal way the runbook requires. Not a product defect; the refusal path needs a normal start (10.15 would retest it but is skipped) |
| 10.5 | PASS | "character_name contains invalid characters" (no prefix); no CC5 window; `C:\CC5Test\exports\mh_badname` not created |
| 10.6 | FAIL (known issue) | "Skin bake initiated at 2048px", "Triggered: About", "Manual step: Skin Editor / Skin Gen panel was opened...", Notes. SkinGen's About box opened ("CCSkinGen", buttons: none), the runbook's known-issue FAIL; README Known issues lists it too. The reply's "panel was opened" is false (F-84) |
| 10.7 | PASS | With the About box open: "CC5 is waiting for an answer to "S/N : (serial) Product Version : 1.0.0824.1 www.reallusion.com Copyright © 2022-2026 Reallusion, Inc. All rights reserved." (the "CCSkinGen" window) - no MCP command is waiting on it, so it is probably the user's own or CC5's: ask the user to answer or close it in CC5, then try again." (no prefix; wording differs from the runbook's quote; Claude did not close it). The message carries the licence serial (F-85; redacted here) |
| 10.8 | PASS (deviation: closed by Claude with exec_python, possible only because of CC5_ALLOW_EXEC=1) | The About box has no buttons, so `answer_cc5_dialog` cannot close it; Claude closed it with `exec_python` (the active modal widget, checked to be "CCSkinGen", `.close()`), standing in for the by-hand close. Then "Found 1 avatar(s): - Kevin (ID: 6095589363968)" at once, same as 10.1 |
| 10.9 | PASS | "Mesh-to-MetaHuman export initiated for TestPatient (Male)", "Triggered: Export Head" (`qtExportHeadAction`), and the Manual step list ('Mesh to MetaHuman Male', folder, file name TestPatient, OK / Export). CC5's "Export Head" window opened, not filled in (buttons Export, Cancel; it also warns that the High baking preset needs 4K skin textures, and Kevin's are 2K). `C:\CC5Test\exports\TestPatient_metahuman` exists, empty. Not recorded: whether the window's fields match the reply's manual steps ('Mesh to MetaHuman Male', folder, file name); the window shows a Target field and a texture table, and CC5 5.13 has only 'Export Head' (the code prefers a 'Mesh to MetaHuman <gender>' item, `cc5_api.py:3365-3379`) |
| 10.10 | PASS | Optional part, asked while the window was open: "CC5 is waiting for an answer to "Target : Std_Skin_Head: ..." (the "Export Head" window) ...", so the window blocks (text cut with "..."). Claude then clicked Cancel with `answer_cc5_dialog` (expect "4K source texture is required"): "Clicked "Cancel" in CC5's "Export Head"." Then "Found 1 avatar(s): - Kevin (ID: 6095589363968)", same as 10.1. The folder stays empty |
| 10.11 | PASS | "Create Mixer Assets dry-run for 'TestPatientMix': dialog configured and CANCELLED (no files written). Presets would be written under: C:/Users/Public/Documents/Reallusion/Reallusion Custom/Actor/Character. Set confirm_create=true to create." No CC5 window left open; .ccMixerPreset files under C:\Users\Public\Documents\Reallusion: 689 before and after, none new |
| 10.12 | SKIP | Optional, lead only: would write real ActorMIXER assets; not run unattended |
| 10.13 | SKIP | Optional, lead only: needs CC5 closed by hand and restarted in dev mode; Claude does not close or kill CC5 unattended |
| 10.14 | SKIP | Optional, lead only (needs 10.13) |
| 10.15 | SKIP | Optional, lead only (pairs with 10.13). Would also retest 10.4's refusal after a normal start |

End of Part 10: TestPatient is unchanged within 3/255 (a capture compared with 9.29's: 0 of 187,600 pixels differ by
more than 6/255);
`TestPatient_part10.ccAvatar` is its restore point; `exports\TestPatient_metahuman` exists and is empty;
`exports\mh_badname` does not exist; no CC5 window is open. CC5 still runs with `CC5_ALLOW_EXEC=1` (not dev mode).

Part 10: 9 PASS, 2 FAIL (10.4 environment, 10.6 known issue F-84), 4 SKIP (10.12-10.15, optional / lead only). New
findings: F-84, F-85. Never-before-live steps settled: 10.9 opens the Export Head window (Triggered "Export Head"),
which blocks commands until cancelled (10.10).

**F-84: `bake_skin_textures` opens SkinGen's About box and says it opened the Skin Editor** (P10-6) · bug (README
Known issues lists the About box). The tool searches CC5's QActions for "bake skin", "apply skin", "skin editor",
"skin gen", "skingen", skipping "remove skingen", and triggers the best match (`cc5_api.py:3123-3186`). No QAction in
CC5 5.13 matches Bake, Apply or Skin Editor (a Bake button inside SkinGen's editor, if any, was not looked for). The
bare keywords "skin gen" / "skingen" (`cc5_api.py:3137`) match the SkinGen Premium menu items About
(`qtSkinGenAboutAction`), Online Manual and Video Tutorial (dry run of the same search, P10-6), and by the code the
menu's own action. All score 3, and the first in `QApplication.allWidgets()` order wins. So it triggers About, a
buttonless modal: every later command except exec_python, the status reads and the dialog tools fails after 5 s with
its text (10.7). No MCP tool can close it (`answer_cc5_dialog` clicks buttons, and it has none); 10.8 closed it only
because CC5 ran with `CC5_ALLOW_EXEC=1`. The trigger is deferred (`QTimer.singleShot(50)`, `cc5_api.py:3179-3186`), so
the reply says "Triggered" before the action runs and cannot see what opened; the bridge then calls the box "probably
the user's own or CC5's" (10.7), although an MCP command opened it. The reply's "Manual step: Skin Editor / Skin Gen
panel was opened" is false, and so is its header "Skin bake initiated at 2048px" (`metahuman.ts:50`, shown for any
success:true): nothing bakes. The tool description (`metahuman.ts:39`) claims it "opens the Skin Editor panel". Its note
"RExportFbxSetting.SetTextureSize succeeded (affects future FBX exports)" is false in its effect: SetTextureSize runs
on a throwaway local object (`cc5_api.py:3100-3103`) that no export uses, since every `export_fbx` builds its own.
Fix: trigger only an action whose text or objectName names bake, apply skin or skin editor (an allowlist: drop the bare
"skin gen" / "skingen" keywords). With no candidate, return the existing manual-step branch (`cc5_api.py:3156-3170`,
whose `candidates_inspected` is always empty: fill it). Drop the texture-size step (3097-3105), fix `metahuman.ts:39/50`,
verify the manual path on 5.13 before reusing "Modify panel -> Skin Editor", and update README.md:317/324,
`live_smoke_test.py:484-489` and runbook 10.6's quoted reply.

**F-85: dialog messages repeat a window's whole text, licence serial included** (P10-7) · bug (raised from minor: it
leaks a licence key). With SkinGen's About box open, `list_avatars` failed with the queue guard's message
(`_modal_dialog_error`, `server.py:451-473`): "CC5 is waiting for an answer to "S/N : (serial) Product Version : ..."",
and `get_cc5_dialog` printed the same text. The serial is the one SkinGen's About box shows (its Product Version
1.0.0824.1 is SkinGen's, so most likely the SkinGen Premium licence). It lands in the agent conversation, and from there
in transcripts, logs and the MCP server's stderr (`util.ts:57`). The unredacted serial is already in this session's
transcript and the MCP server's stderr log: do not share either. Messages that repeat a window's label text: the
queue-guard error, the waiting error, `job_status`, `get_cc5_dialog` and `check_cc5_connection` (errors up to 300/400
characters, the dialog tools all of it). Fix: redact serial / licence lines in `_describe_modal` (`server.py:395-430`),
the one source for every message, and report a buttonless window that is not a progress window by its title only
("close it in CC5"); `_is_question` (`server.py:438-442`) currently counts it as a question. Update
`test_modal_guard.py:56` to the live shape (S/N text, no buttons). README:324 says blocked commands fail with the
window's title; they fail with its text.

### Probes after Part 10 (2026-10-06 15:00-15:35, run by Claude alone)

While the fix batch was being implemented, Claude ran the live probes that the F-82 and F-83 fixes depend on: same
CC5 process, plugin `db0358d`, files in `C:\CC5Test\probe` (about 620 MB; can be deleted after review). Results
are under F-82 and F-83 above. Afterwards the scene was put back: Kevin reloaded from `TestPatient_part10.ccAvatar`
(now ID 6095569715456), and the Back light set to its original multiplier of 4. One new finding:

**F-86: an FBX export clears CC5's undo history** (probe) · bug. Marker: the Back light's multiplier, changed
with `set_light_multiplier` (one undo step). Control: set to 5, one `undo`, back to 4.5. With a read-only
`exec_python` between the change and the undo: also back to 4.5.
- After a change to 5.5 and a mesh-only `cc5_api.export_fbx` (standing, so no timeline change), three `undo` calls
  left the light at 5.5, each reporting "Undo successful". A later change (to 6) undid normally (back to 5.5).
- The same after `RGlobal.SetProjectLength` / `SetEndTime` (set and restored, as F-82's fix does): six undos left
  the light at 5.0.
- An OBJ export does not do this: in the F-83 probe, one undo reversed `ReplaceMesh` after two OBJ exports.

So after `export_fbx`, `export_for_unity` or a batch, nothing done before the export can be undone, and `undo`
says it succeeded (its description already says CC5 reports success when nothing is left to undo).
`capture_viewport`'s own undo is not affected: it undoes the step it just made. Fix: the FBX export tools say that
CC5 cleared its undo history and that changes made before the export can no longer be undone (save_character
first to keep a way back); the `undo` tool's description says the same. Untested: whether CC5's own File > Export
does this too, and whether the flags overload of ExportFbxFile does.
Refuted live 2026-10-06 21:05 (see F-89): with morph and skin-shader markers, one undo after an FBX export (the job path and the exec_python path) took the change back. The light marker this probe used is the exception.

### Batch D (2026-10-06, fixes for Parts 6-10; live check pending)

Chad's decisions of 2026-10-06:
- D1: a recipe or batch stops at a CC5 question nobody has answered: nothing after it is sent to CC5, and its
  report gives the question and the continue_after call that goes on after the answer. A recipe, a batch and
  check_fit do not start while CC5 shows a dialog.
- D2: presets before skin colour, in the full step order: base, headshot_photo (switched off), body_preset, morphs,
  facial_profile, skin/makeup/eye presets and hairstyles, skin_rgb, skin_condition, textures, overlays, clothing,
  shoes, accessories and other assets, wrinkle_strength, expression, pose_file.
- D3: no standing Replace / Material Only answer: the first one in a build goes to the user, and the answer covers
  the rest of that build only; a Cancel is not carried. Chad's answer to the scope question (what counts as one
  build), 2026-10-06: the recommended option: one character in create_character, one batch call in
  batch_generate_patients (layer_answer carries the button through one recipe call and its continue_after calls,
  or the rest of one batch).
- F-75: the injuries choice (bake, separate or omit) is made per character and per export, with no default, and is
  never dropped silently.

What each item got:
- F-28: no standing answer (D3): a stopped recipe or batch goes on with continue_after, and layer_answer answers
  the identical question for the rest of that run (src/build-session.ts, src/recipe.ts, src/tools/builder.ts,
  src/tools/batch.ts, src/tools/dialog.ts).
- F-34: every character-content load is read just before and after LoadFile in one command and reported as CHECK,
  Applied and NOT CHECKED lines: in load_asset, job_status, recipes (a skin-colour line a later step sets again
  becomes a NOTE) and batches (a variant left with CHECK lines is FAIL "exported, but check with the user")
  (cc5-plugin/cc5_changes.py, cc5_api.py load_asset, src/change-report.ts, src/recipe.ts, src/tools/asset.ts,
  src/tools/jobs.ts, src/tools/batch.ts). The picture check is F-34-phase2.
- F-44: check_fit captures each view (default face, left, right, back, front) at 1280x720 with a reading rubric and
  stops INCOMPLETE at the first view it cannot capture; the scene lock covers it (src/tools/fit.ts,
  src/scene-lock.ts, src/image-info.ts). Fit corrections are F-44-phase2.
- F-61: list_clothes, list_hair and list_accessories say "No avatar in the scene." when there is none
  (src/tools/content.ts).
- F-62: get_avatar_info rounds morph weights to 4 decimals (cc5_api.py).
- F-63: failed requests go to requests.log beside the token file (requests.log.1 past 1 MB), never to stdout
  (server.py).
- F-64: every subprocess the plugin starts uses CREATE_NO_WINDOW; shader-parameter close matches need a ratio of
  0.75 (cc5_api.py).
- F-65: apply_skin_overlay replies with the strength CC5 reads back, or says that CC5 still reads an old strength
  until it renders; the refresh (cc5_pipeline.REFRESH_METHOD) stays off until a live probe (cc5_skin.py,
  cc5_pipeline.py, src/tools/skin.ts).
- F-66: load_texture into diffuse_blend sets the layer's strength (default 100); remove_skin_overlay sets it back
  to 0 (cc5_pipeline.py, cc5_skin.py, src/tools/pipeline.ts).
- F-68: the image types come from IMAGE_EXTENSIONS (IMAGE_TYPES_TEXT) in apply_skin_overlay's description and the
  prompt (src/tools/pipeline.ts, src/tools/skin.ts, src/prompts/create-character.ts).
- F-69: get_shader_parameters lists no-value, padding and unreadable entries apart ("Left out (not settings)");
  set_shader_parameter refuses padding and a parameter with no value in plain words (cc5_api.py,
  src/tools/material.ts, src/types.ts).
- F-70: set_wrinkle_strength and the recipe's wrinkle_strength describe expression wrinkles that do not age a
  resting face (cc5_skin.py, src/tools/skin.ts, src/recipe.ts).
- F-71: create_character takes an optional description; a one-word one is flagged and the model restates the full
  typed text or asks; none asks first (src/prompts/create-character.ts).
- F-72: browse_content reads CC5's Custom tab from disk (Reallusion Custom, plus Shared Custom and Shared Templates)
  before the templates; browse_content and search_content say so (cc5_api.py, src/tools/content.ts,
  src/tools/builder.ts).
- F-73: over the material limit, check_quest_budget names byte-identical material copies with the merged count;
  remove_tearline_occlusion on export_for_unity and check_quest_budget (src/tools/unity.ts, cc5_pipeline.py).
  Whether the Quest limit counts slots or distinct materials is still to be decided.
- F-75: export_for_unity takes injuries bake, separate or omit with no default, exports nothing without a choice
  when it finds overlays or pallor, and always lists what the FBX does not carry; 'separate' writes
  `<name>_injuries.json` (format 1); a batch takes one choice with a per-variant override (cc5_pipeline.py,
  cc5_skin.py, src/tools/unity.ts, src/tools/batch.ts). The bake calibration (BAKE_CALIBRATED_ON) and whether skin
  tints reach Unity (TINT_REACHES_UNITY) wait for the live check.
- F-76: export_for_unity and batch_generate_patients need `ProjectSettings\ProjectVersion.txt` beside the Assets
  folder (cc5_pipeline.py, src/tools/unity.ts, src/tools/batch.ts).
- F-77: save_character lists the expression sliders the .ccAvatar does not keep and says it keeps no pose either
  (the pose is not read back); a batch notes each variant without an expression step and re-applies pose_file
  (cc5_pipeline.py, src/tools/pipeline.ts, src/tools/batch.ts).
- F-79: a batch variant with an empty recipe is refused unless export_base_unchanged is true (a control patient);
  an empty apply_character_recipe is refused (src/tools/batch.ts, src/tools/builder.ts).
- F-80: patients_manifest.json is merged: earlier entries stay, a variant run again replaces its own entry, and
  earlier_export keeps the way to its earlier FBX; an unreadable manifest refuses the batch (src/tools/batch.ts).
- F-81: a base that does not exist is refused before anything changes, in recipes and batches (src/recipe.ts,
  src/tools/builder.ts, src/tools/batch.ts).
- I-02: STORE_RULE and STORE_HINT (src/prompts/content-rules.ts) in browse_content, search_content, the server
  instructions and the prompt.
- I-03: PICK_RULE in the content, load and recipe descriptions and the server instructions; BATCH_RULE for
  batches; "Pick list first" in the prompt.
- I-06: the stage-by-stage create_character prompt and the D2 recipe order; the rules reach the agent as MCP server
  instructions (src/index.ts).

Parts 8-10 (the same change set; live check pending):
- F-82: a mesh-only FBX export of a character whose timeline is 0 frames long runs with a one-frame timeline,
  restored afterwards (cc5_api.py).
- F-83: export_obj writes CC5's T-pose; replace_mesh_from_obj removes the pose (refuses an animation; Chad's
  DEC-9 of 2026-10-06), checks the vertex count and pose before and the result after, and undoes a replace CC5 read
  differently (cc5_pipeline.py, src/tools/pipeline.ts).
- F-84: bake_skin_textures triggers only a bake, apply-skin or skin-editor command; CC5 5.13 has none, so it opens
  nothing and returns the manual steps (cc5_api.py, src/tools/metahuman.ts).
- F-85: dialog texts have licence serials replaced by "(serial)", and a window with no buttons is named by its title
  (server.py: needs the reinstall and a CC5 restart); a recipe or batch step blocked by such a window stops and can
  be continued, as for a question (src/build-session.ts).
- F-86: export_fbx, export_for_unity and export_textures say that CC5 cleared its undo history, a batch says it
  once, and undo's description says so (cc5_api.py, cc5_pipeline.py, src/tools/unity.ts, src/tools/asset.ts,
  src/tools/pipeline.ts, src/tools/batch.ts, src/tools/edit.ts).

Unchanged: F-67 and I-05 (they need a live session with Chad), F-74 (investigated during the live check), F-78
(runbook).
Deferred: F-34-phase2 (pictures judged by code), F-44-phase2 (fit corrections), and the F-75 linear-light bake
(only if calibration shows CC5 blends in linear light).
Suites: 1,186 TypeScript tests (38 files) and 609 Python tests, all passing (after the review fixes below). New suite files:
tests/build-session.test.ts, tests/change-report.test.ts, tests/tools/fit.test.ts,
tests/prompts/content-rules.test.ts, tests/prompts/create-character-sdk.test.ts, tests/index-wiring.test.ts,
tests/py/test_changes.py, tests/py/test_injury_export.py, tests/py/test_obj_roundtrip.py and
tests/py/test_bake_skin.py.

### Batch D review (2026-10-06 17:55-19:45, workflow: five angles, each finding verified adversarially)

38 findings: 20 confirmed, 16 plausible (they depend on CC5 behaviour not yet seen live), 2 refuted. Everything but
the two refuted findings was fixed before commit:
- Injury overlays (F-75): the bridge's record of an overlay image goes stale after an undo or redo, a change made in
  CC5 itself, or a load whose strength CC5 refused. A stale record no longer overrides what CC5 reads, and 'separate'
  and 'bake' refuse its image and say why. A record at 0% no longer hides an overlay CC5 shows. A re-export
  overwrites the overlay files and sidecar it writes again and keeps their .meta files (Unity references). A bake
  refuses a diffuse with an alpha channel (it would fill the transparency). Non-finite reads count as unread.
- OBJ round trip (F-83): groups are read by the standard OBJ rule (the vertices a group's faces use), so Blender's
  name-first files work. A replace CC5 did not apply is caught and undone. A Z-up OBJ (export_obj with y_up false) is
  named as such instead of being blamed on the pose, and export_obj says it cannot come back.
- Undo history (F-86): a failed FBX export says the undo history may be gone when the timeline guard ran or CC5 ran
  the export; export_fbx's failure text carries the sentence. A timeline that could not be set back is reported as
  that, not as an export setting CC5 failed to apply.
- Dialog text (F-85): a serial split across two labels (the label in one, the value in the next) is redacted too.
- Recipes and batches (D1, D3): a wait that ends while CC5 still reports a question, or a failed answer whose dialog
  check also failed, stops the run instead of going on. The answer clicked for the run is kept in stops and reports.
  A batch whose manifest cannot be written keeps its stop, and a manifest saved with a byte-order mark is read. The
  stop advice says what to do after a Cancel. A preset loaded onto another character than the first keeps its skin
  CHECK lines (skin_rgb changes the first). CHECK lines are capped only when shown, after superseding. A failed load
  says what it still changed.
- Replies: search_content reports unknown or unreadable folders as errors (no store hint); browse_content treats "No
  content folder resolved" as empty; the batch head counts every written FBX as exported; a batch injury stop tells
  the agent to rerun the batch; load_texture against a plugin older than the strength fix says to reinstall;
  remove_skin_overlay names the materials whose strength it reset, and its failure details reach the agent;
  apply_character_recipe's description keeps presets, hair and clothing to one load_asset at a time.
- Docs: export_textures' undo line, and the job_status rule for WARNING lines.

Not fixed: the two refuted findings (save_character's reply for a neutral face; F-73's status, relabelled "partly
fixed" all the same). Added to the live checks: the F-83 replace with an edited OBJ (an unedited one cannot show a
replace CC5 ignored), and 'separate' after an undo (it fails closed until the overlay is applied again).

Decisions (Chad, 2026-10-06 19:58): DEC-1..DEC-9 keep the recommended answers the code was built with. One
build is one character, or one batch call; a skin tint needs no injuries choice; a batch takes one injuries choice
that a patient can override; a batch patient with CHECK lines is not OK; 'bake' is offered with its "not yet
checked" line; the 'separate' sidecar ships as format 1; a Cancel is not carried; no extras in this batch;
replace_mesh_from_obj removes a pose and refuses an animation.

### Batch D live check (2026-10-06 20:40-21:40, automated part; run by Claude alone)

Chad chose "automated only today" (the checks that need his answers, hands or eyes wait for the next session).
Setup: plugin `f03cf52` installed by Chad (every .py equal to the repo); CC5 launched by Claude with
scripts/cc5-restart.ps1 (CC5_RECOVERY_ANSWER=cancel) and CC5_ALLOW_EXEC=1; tools whose schema the resumed
session showed stale (F-32) were called through a fresh instance of build/index.js over stdio. Evidence:
`C:\CC5Test\evidence\flight-01\batch-d-live\` (results.md, captures, f64.png); probe files in
`C:\CC5Test\probe\live`; exports in `UnityTest_6.2\Assets\Patients\LiveCheck*`. CC5 crashed twice (F-92) and was
relaunched; after the second relaunch its Welcome page blocked the rest, and Chad chose to stop for today.

| Check | Result | What happened |
|---|---|---|
| WP-1 #1 schema | FAIL (client, F-32) | Resumed Claude Code session served apply_character_recipe's OLD schema (only `recipe`, old description) via ToolSearch; search_content, bake_skin_textures, check_fit came back new. A fresh instance of build/index.js lists 89 tools, instructions 1,979 chars, apply_character_recipe with recipe, continue_after, layer_answer and the new description. Start a NEW (not resumed) session before the D1/D3 checks. |
| WP-6 #1 | PASS (server) | Fresh server: 89 tools incl. check_fit; instructions 1,979 chars; the session's cc5 instructions are complete (no truncation) |
| WP-6 #4 | PASS | browse_content('character'): 124 files, Reallusion Custom/Actor/Character/Avatar.ccAvatar first, then templates; folders seen: root (CC4 Camila/Kevin/Susan, IF-Men40_*, Sanjay_V1/V2), _Mixer Ready, ActorCore Crowd, Base (Neutral_F/M, Toon Neutral_F/M), Business, Casual, ... |
| WP-1 #9 | PASS | search_content('xyzzy'): "No content matched ... you can search the Reallusion store ...", not an error |
| WP-2 #7 F-72 | PASS | GetCustomContentFolder for all 31 EContentRootFolder enums browse_content uses returns a category folder under Reallusion Custom (Cloth/Shirts ... Hair/Group, Actor/Eye), never the root (GetCustomDataPath = ...\Reallusion Custom). search_content('army'): 4 hits under Reallusion Custom/Cloth (2 shirts, pants, boots). browse_content('cloth_other') starts with Reallusion Custom/Cloth/Others/Body Armor.ccCloth; character with Reallusion Custom/Actor/Character/Avatar.ccAvatar; gloves lists its 14 templates; hair search finds Buzz Cut |
| WP-2 #10 F-63 | PASS | exec_python GET /avatars without the token: 401; %LOCALAPPDATA%\CC5_MCP_Bridge\requests.log created with `2026-10-06 20:51:04 "GET /avatars HTTP/1.1" 401 -`; the exec_python output held only the probe's own line |
| F-84 bake | PASS, plus a new gap | bake_skin_textures(2048): error "No skin bake command found ... nothing was opened", the manual step, and "Commands looked at" (15 skin-related actions); no dialog opened. The list shows CC5 5.13 DOES have "Bake All &Skin Textures" (qtBakeAllSkinTextureAction, Character menu; disabled with no character): the matcher looks for "bake skin" / "bake texture" and the '&' mnemonic plus "All" defeat it (new finding) |
| F-85 About box | PASS | About box opened with exec_python (standing in for by hand). list_avatars: 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool can close it), then try again.' get_cc5_dialog and check_cc5_connection: "S/N :" and the serial are separate labels live; the serial reads "(serial)". Closed with exec_python |
| WP-1 #6 F-81 | PASS | Kevin (ID 5888206335744) in the scene; base C:/CC5Test/unity/UnityTest_6.2/saves/TestPatient.ccAvatar: "base not found: ... Nothing was changed in CC5: the characters in the scene were left as they were." Kevin still listed |
| WP-2 #8 F-69 | PASS | get_shader_parameters(CC_Base_Body, Std_Skin_Head): 53 params and "Left out (not settings): SSS Metallic Threshold (CC5 returns no value for it, so it cannot be set); padding1, padding Last4 (shader padding)". set_shader_parameter on each of the three is refused with its reason; read-back 53 params, same values |
| WP-2 #9 F-62 | PASS | apply_body_preset('heavy', 0.5): get_avatar_info shows pack_full_body1 0.35 and embed_full_body6 0.1 (plus Kevin's two identity morphs at 1); one undo removes both |
| WP-2 #11 F-64 | PASS | exec_python cc5_api._capture_window_screenshot: 1.8 s, 2575x1407 PNG of CC5's window (CC5 happened to be in front), no console window in it (f64.png) |
| WP-2 #11 typo | PASS | set_skin_shader and set_shader_parameter with 'Original Roughnes Strength': refused, "Close matches: Original Roughness Strength" (only that one) |
| WP-3 #11 F-77 | PASS | Six sliders set (Brow_Compress_L/R 0.6, Mouth_Frown_L/R 0.4, Eye_Squint_L/R 0.3); save_character C:\CC5Test\saves\LiveCheck_Kevin.ccAvatar: "Not saved: the facial expression (6 sliders: ...)", "A .ccAvatar keeps neither the facial expression nor the pose", and a ready expression step for batch variants |
| WP-3 #2 F-76 | PASS | export_for_unity('C:/CC5Test/UnityTest/Assets/Patients', 'F76'): refused, naming C:\CC5Test\UnityTest\ProjectSettings\ProjectVersion.txt; C:\CC5Test\UnityTest not created. The real project exports (next row) |
| First export / F-75 / F-86 | PASS | Session's first FBX export (after the save) survived: LiveCheck_Kevin, 40 files, 44.9 MB, 9 s. "Skin overlays and skin condition: none on this character." (no false positive, no tint line); the reply ends with the F-86 undo-history line |
| WP-7 F-82 | PASS (Unity check below) | apply_pose Sitting_Floor: project length and end time 0. export_for_unity LiveCheck_F82 without include_current_pose: take one frame (LocalStop 769,769,300); timeline reads 0 / 0 again afterwards |
| WP-7 F-83 export_obj | PASS | On the seated Kevin: "The OBJ is in CC5's T-pose (arms horizontal) ..."; the file's body spans x +-88.7 cm (bind pose +-79.7) |
| WP-7 F-83 replace, expression active | PASS by the code, NEW FINDING | Seated Kevin with the six expression sliders: success, pose removed, "Checked: the mesh matches the OBJ (max 0.36 cm)". A bind export afterwards: every moved vertex is in the head (1,952 over 0.05 cm, max 0.36 cm at the inner brows, y 155-180 cm): the OBJ carried the expression, and it now applies on top of a mesh that already has it. The 0.5 cm tolerance passed it; an exact round trip gives 0.00 |
| WP-7 F-83 undo | PASS | One undo restored the mesh (bind export equal, 0.00 cm in every group) and the seated pose clip (DeleteClip and ReplaceMesh in one undo step) |
| WP-7 F-83 bind-pose OBJ | PASS | C:\CC5Test\exports\obj\TestPatient.obj (9.25, bind pose): refused "does not match the character's T-pose: 29.8% of CC_Base_Body's vertices are more than 10 cm ... Likely causes: another pose ..., another axis, or a changed vertex order"; the pose clip is still there |
| WP-7 F-83 reference order | PASS | export_obj's file and a T-pose export without ExportMaterial: same vertices in the same order (0.00 cm in all 7 groups) |
| Review: edited OBJ | PASS | Expression reset, export_obj, one body vertex moved 2 cm forward: replace succeeds, "max 0.00 cm"; in the bind pose exactly that vertex moved 2.0 cm, no other over 0.01 cm. Undone afterwards |
| WP-3 #4 Qt formats | PASS | QImageReader: jpg, jpeg, png, tga, tif, tiff (and more); QImageWriter: jpg, png, tif, not tga (as expected) |
| WP-3 #5 / F-65 apply | PASS | Fresh Kevin; apply_skin_overlay(overlay.png, arms, 60): "CC5 still reads a different strength on Std_Skin_Arm (0%) until it next renders"; set_skin_condition(pale, 0.6) on the four skin materials |
| WP-3 #5 Inj_Ask | PASS | No injuries choice: "Not exported" with the overlay (Std_Skin_Arm, 60%) and pale (+0.036 / -0.150) lines and the three choices; no Inj_Ask folder |
| WP-3 #5 Inj_Omit | PASS | 'omit': exported (40 files); "Left out of this export, as asked" lists both; note that CC5 read 0 and the bridge's 60% was used; Std_Skin_Arm_Diffuse.jpg averages (149.1, 108.4, 90.2) (unbaked) |
| WP-3 #5 Inj_Sep | PASS | 'separate': Injuries/Std_Skin_Arm_DiffuseBlend.png 1024x1024 at (128, 48, 48); Inj_Sep_injuries.json format 1, blend Multiply, overlay strength 0.6, four pallor entries (0.036 / -0.15), no tints; all 39 .fbm textures byte-identical to Inj_Omit's |
| WP-3 #5 Inj_Bake | PASS (JPEG noise) | Skin back to normal, 'bake': only Std_Skin_Arm_Diffuse.jpg differs from Inj_Omit's; "The bake formula has not been checked against CC5 yet". Against Inj_Omit x (0.701, 0.513, 0.513) on a 64x64 grid: median 1.35/255, 99th percentile 3.6/255, max 8.2/255 (134 of 4,096 samples above the check's 3/255: the bake is saved as JPEG q95 from a JPEG source) |
| WP-3 #5 rebake to omit | PASS | 'omit' under the bake's name: Std_Skin_Arm_Diffuse.jpg byte-identical to Inj_Omit's again |
| Review: separate after undo | PASS | One undo, then 'separate' (Inj_SepStale): "Std_Skin_Arm: the overlay image is not known after an undo or a change made in CC5: re-apply it ..."; no image shipped; reply is an error; note that CC5's read is used for the strength |
| F-86 undo history | FAIL: claim refuted, NEW FINDING | That undo also brought the pale offsets back (it undid set_skin_condition(normal) across two FBX exports). Controlled: heavy 0.5, export_for_unity (job), one undo: the morphs are gone; the same through cc5_api.export_fbx in exec_python: gone. Light marker: Back 4 -> 4.5, export, two undos: still 4.5; without an export in between (light 5, morph, two undos) the light comes back. So an FBX export does NOT clear CC5's undo history; only a light's intensity change before an export was not undone. Batch D's "CC5 cleared its undo history with this export ..." line (every export reply), the export_fbx failure sentence and the undo description are false for morph and shader changes |
| WP-3 #5 GetImage path | PASS | TestPatient.ccAvatar loaded (overlay on all skin at 60 and pale 0.6 saved in it, no bridge record); 'separate' (Inj_SepGetImage): four Injuries/<Material>_DiffuseBlend.png, each 1024x1024 at (128, 48, 48), strength 60% from CC5's own read, sidecar with the pallor values |
| WP-3 #8 F-66 | PASS | load_texture(CC_Base_Body, Std_Skin_Leg, diffuse_blend, overlay.png): "at 100% (CC5 reads the strength back only after it renders)", legs dark red (f66_legs_100.png). remove_skin_overlay(legs), capture: GetTextureWeights[7] 0.0, HasImage false, legs normal. strength 30: "at 30%"; strength with channel normal: refused "strength is only for channel 'diffuse_blend'". One undo after the 30% load removes image and strength together |
| WP-3 #9 F-68 | PASS | overlay.bmp and overlay.tif (written from overlay.png with Qt): each on the arms at 100 turns them dark red (after a removal in between: f68_bmp.png, f68_removed.png, f68_tif.png). The "BMP and TIFF are not yet tested" wording can go |
| WP-3 #10 F-70 | PASS | Brow raise (inner and outer, L/R, 1.0): wrinkle 0 vs 1 face captures differ on the forehead (mean 6.9/255, 18% of pixels over 10/255; creases visible), chin and background identical (f70_wrinkle0/1.png) |
| WP-3 #7 F-65 refresh | PASS (refresh stays off) | With refresh off: "CC5 still reads a different strength on Std_Skin_Head (60%) until it next renders" (an apply at 30% over 60%). Probes: RGlobal.SetTime(GetTime()) -> still 0.6; SetTime one frame forward and back -> still 0.6; one capture (a render) -> 0.3. No cheap refresh works, so REFRESH_METHOD stays None |
| WP-3 #12 F-73 | PASS | Soldier_Pale_01.ccAvatar loaded; check_quest_budget on Assets/CC5Patients/Soldier_Pale_01: FAIL, Materials 22/20 with the remove_tearline_occlusion hint and "M_BipPMilUniform_US is exported 3 times with byte-identical textures (Diffuse, Normal): merge these in Unity: the count would be 20". export_for_unity with remove_tearline_occlusion (Soldier_NoTear, injuries omit): 36 files instead of 40; check_quest_budget with the flag: PASS, Materials 18/20, "4 materials and 560 triangles not counted", Triangles 45,214. Unity renderers checked below |
| WP-2 #1 / WP-1 #8 F-34 | PASS | Fresh Kevin, load_asset US_Army_Uniform_Pants.ccCloth: "Compared before and after: 2 worn items, 14818 shaping morphs, 19 materials (3.3 s)", "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item", "Applied: added Pants (clothing)", NOT CHECKED fit line; no material lines for either item; list_clothes: Pants only |
| WP-2 #3 F-34 | PASS | Buzz Cut on bald Kevin: "Applied: added Buzz_Cut (hair)" and nothing else (3.3 s) |
| WP-2 #5 F-34 | PASS | Dressed Kevin (pants, shirt, boots, Buzz Cut): shirt load 3.2 s (22 materials), boots load 3.3 s (4 worn items, 14878 shaping morphs, 23 materials), nothing skipped |
| WP-5 refusals | PASS | Through a fresh server instance: an empty variant is refused at input ("Variant Refused has an empty recipe ... set export_base_unchanged: true for a control patient"); a missing base: "base_character not found ... Nothing was sent to CC5."; C:/CC5Test/UnityTest/Assets/Patients: "not inside a Unity project ... ProjectVersion.txt does not exist ... Nothing was sent to CC5."; an overlay variant without injuries: "Choose injuries ... for this batch or for variants Hurt ... Nothing was sent to CC5." No folder created |
| WP-4 setup / Unity | PASS | Unity 6000.2.10f1 headless (21:15): LiveCheck_F82 (posed, mesh-only): 0 errors, 0 warnings (F-82 fixed in Unity); Soldier_NoTear: 0/0, 16 distinct materials, 8 renderers, no TearLine or EyeOcclusion (F-73 flag works); LiveCheck_Kevin 0/0 |
| WP-3 #13 F-74 | NOT REPRODUCED | US_Army_Uniform_Shirt/Pants/Boots on fresh Kevin: strong sheen at once (21:13:46: glossiness 25, specular 25 on all three), the same at 21:16:12 (no export), after an export (F74_Uniform, 21:16:47) and after save_character (21:17:09). Part 7 read 0/0/25 and 31/25/25: maybe the other shirt file ("US Army Uniform Shirt.ccCloth", spaces) or the session's FIRST export, which needs a CC5 restart to retest |
| CC5 crash | OBSERVED | 21:18:04: CC5 crashed (dump %LOCALAPPDATA%\CrashDumps\CharacterCreator.exe.16388.dmp) during apply_character_recipe's base step (delete the dressed Kevin, load CC4 Kevin.ccAvatar), right after save_character and an export. Same step ran cleanly 6 times earlier today. Three other CC5 dumps today (15:58, 16:39, 19:06) are from other sessions. Relaunched with the launcher (recovery Cancel, CC5_ALLOW_EXEC=1) |
| Recovery prompt after the crash | PASS | The relaunch met "Unsaved project data found"; the plugin answered Cancel (21:19:25) and get_cc5_dialog reports it. The bridge took over 120 s to come up both times today: the launcher's 120 s wait is too short now (it says to check the window) |
| F-74 second shirt + first export | NOT REPRODUCED | Relaunched CC5 (fresh session): "US Army Uniform Shirt.ccCloth" (spaces) reads glossiness 0 / specular 25 (matte); the underscore file reads 25 / 25 (glossy); pants and boots 25 / 25. The session's FIRST export (F74b_FirstExport) and a save changed nothing (values and capture). Part 7's 0/0/25 and 31/25/25 remain unexplained |
| WP-2 #2 F-34 Red Velvet | PASS for the report, NEW FINDING | Kevin with Buzz Cut and skin colour (0.8, 0.6, 0.5), then Red Velvet.ccSkinGenPreset: no CHECK line, only "NOT CHECKED: what CC5 shows but cannot report (hair or brows hidden, makeup or skin layers): capture the face ... and the whole body". Captures: the viewport now hides the Buzz Cut, the brows and ALL clothing (shirt, pants, boots: Kevin shows bare, rv_home_after.png); list_hair/list_clothes still list every item; skin colour still reads 0.800/0.600/0.502; set_item_visible(Shirt, true) changes nothing. An export of that state still contains Pants, Shirt, Boots, Buzz_Cut and the brows (FBX mesh models). The NOT CHECKED line names only hair or brows: it should name clothing too. qtBakeAllSkinTextureAction stays disabled with the preset on |
| WP-1 #5 D2 / D1 | PASS | Recipe {base CC4 Kevin, skin_rgb (0.8, 0.6, 0.5), assets [Sport Sneakers.ccShoes, Red Velvet.ccSkinGenPreset]}: order base, Red Velvet, skin_rgb, sneakers (D2). The sneakers' load opened CC5's "Failed to load the file." (OK only): the recipe stopped (D1): "Stopped at asset Sport Sneakers.ccShoes: CC5 is waiting for an answer nobody has given yet", continue_after "cmd_2cbba807_43"; a parallel direct call got the 504 "Timed out before CC5 started the command". Claude answered OK (a plain acknowledgement, no choice) with expect; apply_character_recipe continue_after (the session client passed the parameter although its stale schema lacks it): "Continued after the answer ... this report covers the whole recipe", sneakers FAIL "(CC5 reported an error, but it changed 5 things)" with "NOTE Applied: added Sport sneakers (clothing)" (TS-3; the sneakers are on). Skin head colour 0.8015/0.6016/0.5035 (within 0.004) |
| F-34 stale colour | NEW FINDING | That continuation also shows "CHECK skin colour on Std_Skin_Head/Body/Arm/Leg: (1, 1, 1) -> (0.8, 0.6, 0.502)" under the sneakers: skin_rgb's change, made before the sneakers' load. Probe: right after cc5_api.set_skin_color(0.5, 0.5, 0.5), GetDiffuseColor still reads 0.802/0.602/0.504; after one capture (a render) 0.504. CC5 reports a material colour stale until it renders (like F-65's weights), so a load's "before" read can miss a change made just before it, and its report blames the load |
| WP-4 #1 check_fit gate | PASS | Fresh Kevin + Hat_DarkBlue.ccAcc ("Applied: added Hat (accessory)"); set_diffuse_color(Std_Skin_Body, 0.2, 0.4, 0.9); check_fit default: 5 views (face, left, right, back, front), each 1280x720 in one check_ folder, all shown; afterwards Std_Skin_Body reads 0.200/0.400/0.902 (no capture undid the change); one undo -> 1.000/1.000/1.000 (read after a render) and the Hat still listed: exactly one step undone |
| WP-4 #2 | PASS | The crown scalp patch shows as a skin-coloured patch on the hat's front in the face view (and small in the front view); the rubric says such a patch is the body showing through, not a logo |
| WP-4 #3 | PASS | Change, undo, check_fit(['face']), redo: refused "Nothing of yours to redo: a viewport capture taken after the undo replaced CC5's redo history ..." |
| WP-4 #5 | PASS | Hat selected before the check: get_selection afterwards still "Hat" |

Not run today: the checks that need Chad (D1 stops on real choices and D3 Replace / Material Only, dialogs opened
by hand, the full create_character run, the F-75 calibration by eye, F-71's typed prompt, F-61 on an empty project,
CC5_CHANGE_CHECK=0), and, because of the second crash and the Welcome page, the batch manifest merge and rerun
(F-80), a base carrying an overlay in a batch, scripts/live_smoke_test.py and the clothes test for F-92.

**F-87: bake_skin_textures misses CC5's real bake command** (live) · minor. The tool's "Commands looked at" list
shows "Bake All &Skin Textures" (`qtBakeAllSkinTextureAction`, Character menu) besides SkinGen's About, Online
Manual and Video Tutorial: F-84's "CC5 5.13 has no bake command" came from the old keyword search. The allowlist
matches "bake skin" / "bake texture", which neither the text (the '&' mnemonic and "All" in between) nor the
camel-case objectName contains. The action was disabled with no character, with Kevin, and with Kevin wearing a
SkinGen preset, so today the tool would skip it anyway. Fix: strip '&', split camel case, match the words bake and
skin or texture; before the tool triggers it, find out when it enables and what it does (it bakes, rather than
opening a panel, so the reply's "bake it by hand" would change).
Live 2026-10-07 (batch E plugin): 'No skin bake command found: CC5's "Bake All Skin Textures" and "Bake All
Substance Textures" commands are disabled right now, so nothing was run', then the manual step and "Commands looked
at: ...", a list that leaves out Bake All Substance Textures. The word rule (bake with skin, skingen, texture or
textures) also takes the Substance bake, and would take an objectName such as qtBakeLightTextureAction: require the
word skin or skingen. The reply's first words contradict the rest: reword. Chad (asked when the command enables): once
the character has SkinGen layers applied in the Appearance Editor; whether it then bakes at once or opens a dialog is
not known, so nobody has seen the tool trigger it.

**F-88: the OBJ round trip bakes an active facial expression into the mesh** (live) · bug. Seated Kevin with six
expression sliders (brow compress, frown, squint): export_obj, then replace_mesh_from_obj with that unedited OBJ
replied "Checked: the mesh matches the OBJ (max 0.36 cm)". A bind-pose export afterwards differed from the one
before only in the head: 1,952 vertices over 0.05 cm, at most 0.36 cm at the inner brows. The OBJ carried the
expression, the replace made it part of the body, and the expression now applies on top again; resetting the
expression would leave the face in it. With the expression reset first, the round trip is exact (0.00 cm, and a
2 cm edit to one vertex arrives as exactly that). Fix: refuse at export_obj and at the replace while expression
weights are not 0 (say to reset_expression, sculpt, replace, then set the expression again), and tighten
ROUND_TRIP_TOLERANCE_CM (exact round trips read 0.00) so a doubled expression fails the post-check.

**F-89: an FBX export does not clear CC5's undo history** (live; corrects F-86) · bug. Morph marker: heavy 0.5,
export_for_unity (job), one undo: the morphs were gone; the same with cc5_api.export_fbx in exec_python. Skin
shader: set_skin_condition(normal), two exports, one undo: the pale offsets came back. Light marker: Back 4 -> 4.5,
an export, two undos: still 4.5 (the F-86 probe's marker); with an ordinary step instead of the export (light 5,
heavy, two undos) the light came back. So only a light change before an export was not undone. Batch D's
UNDO_HISTORY_CLEARED line (export_fbx, export_for_unity, export_textures, a batch once), export_fbx's failure
sentence (cc5_api.with_undo_history_sentence) and the undo description tell the agent that earlier work cannot be
undone, which is false for morph and shader changes. Fix: remove them, or narrow them to what was seen ("an undo
after an FBX export did not take back a light's intensity change"); the undo_history_cleared flag goes too.

**F-90: the F-34 comparison reads a material colour CC5 reports late** (live) · bug. Recipe {base, skin_rgb (0.8,
0.6, 0.5), assets [Sport Sneakers.ccShoes, Red Velvet]}: the sneakers' report carried "CHECK skin colour on
Std_Skin_Head/Body/Arm/Leg: (1, 1, 1) -> (0.8, 0.6, 0.502)", the change skin_rgb had made just before. Probe:
right after cc5_api.set_skin_color(0.5, 0.5, 0.5), GetDiffuseColor still read 0.802/0.602/0.504, and 0.504 only
after a capture. CC5 reports a material colour as it was until it renders, like F-65's texture weights, so a load's
"before" read misses a colour change made since the last render. Fix options: in a recipe, a later load's skin
colour CHECK whose "after" equals what an earlier skin_rgb or skin_condition set becomes a NOTE ("set by skin_rgb
earlier; CC5 reports colours late"); or the comparison marks colour facts as unverified when no render happened
since the last colour change.
Built (batch E): the bridge records every diffuse colour and opacity it writes (cc5_api._writes_since_render, keyed
by character, mesh and material; colours on CC5's 0-255 steps), load_asset hands the record to cc5_changes, which
compares a recorded field from the value written and takes out of the record what CC5 reads fresh (_settle); a
capture whose RenderImage wrote the file empties the record, and so do undo and redo. Batch F (batch E review #0,
#1, #20): export_for_unity's tint read and get_diffuse_color use the record too; a recorded field whose reads did
not move gets a NOT CHECKED note instead of nothing; after an undo or redo, colour and opacity differences on the
characters present at that moment are NOT CHECKED until a capture renders.

**F-91: a SkinGen makeup preset hides hair, brows and all clothing in the viewport** (live) · minor. After
Red Velvet.ccSkinGenPreset on Kevin (uniform, boots, Buzz Cut), the viewport showed him bare and bald
(rv_home_after.png). list_hair and list_clothes still list every item, the skin colour read is unchanged,
set_item_visible(Shirt, true) reports success and changes nothing, and an export still contains Pants, Shirt,
Boots, Buzz_Cut and the brows. The load's report has no CHECK line, only "NOT CHECKED: ... (hair or brows hidden,
makeup or skin layers): capture ...". Fix: name clothing in that NOT CHECKED line; find with Chad which CC5 setting
hides them and how to show them again (the MCP cannot see or change it).
Cause (2026-10-07): SkinGen editing (Chad, asked which CC5 mode hides clothing: "SkinGen editing mode"). A
.ccSkinGenPreset load starts what CC5 calls a SkinGen session: while it lasts the viewport hides hair, brows and
clothing (still worn and exported); no SkinGen window or dock is open. After Cordial.ccSkinGenPreset Kevin showed
bare (T-shirt and Boxers hidden); clear_selection and select_objects changed nothing. The next content load (a
Box_001.iProp) asked "Applying this content will deactivate the current SkinGen session. Would you like to
continue?" (OK / Cancel, window "Character Creator 5"); after OK the clothing showed again and the makeup stayed;
once CC5 then showed the progress window "Update morph data..." and the load finished about 19 s after the OK.
After a prop was deleted (no question) the clothing also showed again. A load with no session active asked
nothing. To build: a SkinGen preset's load report says that CC5 hides hair, brows and clothing until the next
content load ends its SkinGen session; the deactivate question is a plain confirmation of a load the user asked
for (answer OK and say so). Not tested: whether another SkinGen preset loaded during a session asks.

**F-92: CC5 crashes when a character is deleted while one of its uniform items is selected** (live) · bug (CC5),
cause found 2026-10-07. Overnight, CC5 crashed twice: 21:18:04 in apply_character_recipe's base step (delete Kevin
wearing the uniform shirt, pants, boots and Buzz Cut, load CC4 Kevin.ccAvatar), and 21:34:00 in
batch_generate_patients' scene clear (deleting variant B's Kevin, who wore the uniform pants). Chad (21:38): "You may
want to test other clothes. That uniform is a custom asset." Isolation on 2026-10-07, CC4 Kevin, through the MCP tools,
each delete a call of its own:

| Run | Worn, and how it was loaded | Export before | Result |
|---|---|---|---|
| 1 | uniform pants (the scene Chad left) | no | ok |
| 2 | Basic T-shirts + Slim Jeans (template), load_asset | no | ok |
| 3 | uniform shirt, pants, boots + Buzz Cut, load_asset; save_character | yes | CRASH 07:53:38 |
| 4 | the same outfit from the saved F92_Uniform.ccAvatar (Kevin selected) | no | ok |
| 5 | the same, from the .ccAvatar | yes | ok |
| 6 | Basic T-shirts + Slim Jeans, load_asset | yes | ok |
| 7 | uniform pants only, load_asset | yes | CRASH 07:59:21 |
| 8 | uniform pants, load_asset, CC5 started with CC5_CHANGE_CHECK=0 (no before/after reads) | yes | CRASH 08:01:19 |
| 9 | uniform pants, load_asset | no | CRASH 08:03:31 |
| 10 | uniform pants, load_asset, then clear_selection | no | ok |
| 11 | uniform pants, load_asset, then in ONE exec_python command: BeginAction, RScene.ClearSelectObjects(), RScene.RemoveObject(Kevin), EndAction | no | ok |
| 12 | uniform pants, load_asset, then remove_scene_item("Pants") while the pants were selected | no | ok |

After load_asset, CC5 leaves the loaded item selected (get_selection: "Pants (Cloth)"; run 11 read the selection:
['Pants']). The uniform pieces carry shaping morphs of their own (the shaping-morph count rose 14802 -> 14878 with the
uniform and boots; the template clothes added none), and all six dumps (%LOCALAPPDATA%\CrashDumps\CharacterCreator.exe
.16388 and .61572 overnight, .122272, .77380, .32116 and .100096 today) have the same stack, read with cdb: RLPy RScene.RemoveObject -> ICPluginQt
IC::CEventSender::ObjectDeleted -> CCAvatarShaping.dll -> access violation. So the trigger is deleting a character
while one of its worn items with its own shaping morphs is selected; an export, a save and the F-34 comparison play no
part. Both overnight crashes went through bridge.deleteAvatar -> cc5_api.delete_avatar. Fix (batch E): delete_avatar
clears CC5's selection before it removes characters, as run 11 did. A user deleting such a character in CC5's own UI
while the item is selected is not covered.

**F-93: the launcher never saw the bridge come up** (live) · minor, cause found 2026-10-07. cc5-restart.ps1 printed
"The bridge did not answer within 120 s" on all three launches on 2026-10-06 and all five on 2026-10-07, while the
bridge was up after about 70 s each time. The first reading (starts slower than 120 s) was wrong: in Windows
PowerShell 5.1, Invoke-WebRequest without -UseBasicParsing throws "Object reference not set to an instance of an
object" on every answer, and the loop's empty catch hid it, so the check never succeeded. Fixed (batch E):
-UseBasicParsing, and the wait limit raised to 240 s (it ends as soon as the bridge answers); the next launch printed
"Bridge up after 16s". launch_cc5_for_test.ps1 uses Invoke-RestMethod and was not affected.

**F-94: the recipe's pre-check words CC5's Welcome page as a dialog to ask about** (live) · minor. With the Welcome
/ What's New page open, apply_character_recipe replied 'CC5 dialog "(untitled)": Buttons: none found / No MCP
command is waiting on this dialog: it may be the user's own, so ask the user before answering it.', while
load_asset's guard error said "CC5's Welcome / What's New page (or another untitled CC5 window) is open - close
it in Character Creator 5 ...". Fix: formatDialog uses the guard's wording for an untitled window with no
buttons.
Batch F (batch E review #3, #4, #7, #8, #19): the same rule for every text about a window with no buttons, or with
buttons the bridge cannot read (F-99): the plugin's waiting text (409 and job_status), job_status with an older
plugin, the recipe and batch stop reports, continue_after and check_cc5_connection say to close it (or answer or
close it) in CC5, never to answer it with answer_cc5_dialog. The Welcome page is named only for an untitled window
with no text and no buttons whose text was read; a window whose text could not be read goes to the user as a
question everywhere.

### Batch D live check, part 2, and batch E partial check (2026-10-07 07:43-10:15, with Chad)

Setup: plugin `f03cf52` unchanged; a new Claude Code session (fresh tool schemas: apply_character_recipe offered
continue_after and layer_answer). The CC5 left running overnight had Kevin wearing the uniform pants (Chad's). After
each crash Claude relaunched CC5 with scripts/cc5-restart.ps1 (recovery Cancel, answered by the plugin each time),
CC5_ALLOW_EXEC=1 and CC5_DEV_MODE=1.

| Check | Result | What happened |
|---|---|---|
| F-92 isolation | CAUSE FOUND | 12 runs on CC4 Kevin (table under F-92): deleting a character while one of its worn items with its own shaping morphs (the custom uniform) is selected crashes CC5's CCAvatarShaping; load_asset leaves the loaded item selected. An export, a save and the F-34 comparison play no part; clearing the selection first, in the same command or before it, avoided the crash; remove_scene_item on the selected pants did not crash. Four crashes today, six dumps with one stack |
| CC5_CHANGE_CHECK=0 | PASS | CC5 launched with it: load_asset replied "NOT CHECKED: WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared" |
| F-90 refresh probe | no cheap refresh | Right after cc5_api.set_skin_color(0.5, 0.5, 0.5), GetDiffuseColor read 1.0; RGlobal.ForceViewportUpdate() (0 ms), the next bridge command and RGlobal.ObjectModified(avatar, EObjectModifiedType_Material) still read 1.0; after one capture 0.502 |
| F-61 | PASS | Empty scene: list_clothes, list_hair and list_accessories each say "No avatar in the scene." |
| D1 / D3 recipe | PASS | Recipe {base CC4 Kevin, assets [_Blue1, _Brown1, _Green CH1 Eyes]}: stopped at _Blue1 (Kevin's template already has an eye layer, so even the first .ccEye asks) with the question, the buttons, the job id and the continue_after call. Chad picked Replace; continue_after with layer_answer Replace: _Brown1 and _Green CH1 "CC5 asked 'Replace / Material Only'; answered 'Replace' (the user's answer earlier in this run)"; the face capture shows green eyes. A second recipe [_Hazel1, _Gray CH1] asked again (no standing answer); Chad picked Cancel; continue_after without layer_answer: _Gray CH1 asked again (a Cancel is not carried); Claude answered Replace (Chad's choice for this character, D3); gray eyes |
| D1 / D3 batch | PASS | Batch into Patients/F80: F80_B (rerun, _Blue1 Eyes) stopped on the same question, F80_D not started; Chad picked Replace; continue_after with layer_answer: both exported, F80_D's step "CC5 asked 'Replace / Material Only'; answered 'Replace' (the user's answer earlier in this run)" |
| F-80 | PASS | Base F80_Base.ccAvatar. Batch 1 (F80_A athletic 0.5, F80_B slim 0.5); batch 2 into the same folder (F80_C heavy 0.5, F80_A athletic 0.8): the manifest kept F80_B, added F80_C and replaced F80_A ("The manifest also lists 1 earlier variant(s)"). The stopped rerun above: F80_B ok false with earlier_export {12:59:52, F80_B.fbx} and a "stopped" note; both gone once it exported again |
| Base with an overlay | PASS | Batch from TestPatient.ccAvatar (overlay at 60% on the four skin materials, pale 0.6) without injuries: "Not exported", the four overlays and the pallor listed, a choice asked for. With injuries separate (Chad's pick): Injuries/Std_Skin_*_DiffuseBlend.png read from CC5 (no bridge record), BO_Athletic_injuries.json format 1 (strength 0.6 each, pallor +0.036 / -0.15) |
| Hand-opened dialog | PASS (wording: F-94) | Chad opened File > Export > FBX. get_cc5_dialog and check_cc5_connection: 'CC5 dialog "Export FBX" ... Buttons: none found / No MCP command is waiting on this dialog: it may be the user's own, so ask the user before answering it.'; list_avatars: 'CC5 has a window open with no buttons: "Export FBX" - close it in Character Creator 5 (no MCP tool can close it), then try again.'; apply_character_recipe refused, "Nothing was sent to CC5". Nothing was clicked |
| F-93 launcher | CAUSE FOUND, fixed | All five launches today reported "The bridge did not answer within 120 s" (and 240 s after the first F-93 change) while the bridge was up after about 70 s: in Windows PowerShell 5.1, Invoke-WebRequest without -UseBasicParsing throws "Object reference not set to an instance of an object" on every answer, and the script's empty catch hid it. With -UseBasicParsing the same line returns 200 against the live bridge; the next launch printed "Bridge up after 16s" (the count adds only the sleeps) |
| F-71 | PASS | Chad typed /mcp__cc5__create_character female mid-twenties. Asian. Cropped black hair. 5'-2" tall. Average build.: the prompt received "female", said only one word arrived and told the model to use the full typed text, which Claude Code showed beside it |
| create_character full run | PASS, with notes | Stage 1: HD Human Anatomy Set/Female Asian.ccAvatar (loads as CC3_Base_Plus, bra and underwear), average 0.5 (the three build sliders at 15%); 158.4 cm tall by the bounds, so no height morph (CC5 has Character Height, pack_full_body6). Stage 2: Lite Hair Female Vol. 1/Pixie (3,390 triangles) replaced on Chad's word (I-07) by Prime Hairstyles/06_Ear length Bob (15,808 triangles); set_hair_color plus near-black RootColor/TipColor made it black, a grey-white highlight streak stays (accepted); no CHECK lines; check_fit clean. Stage 3: Basic T-shirts, Slim Jeans, Canvas shoes, nothing removed, check_fit clean in all five views. Stage 4: none. save_character, then export_for_unity Assets/Characters/AsianFemale_25 (57 files, 67.0 MB; the session's first export did not crash). check_quest_budget: FAIL, 79,462 / 65,000 triangles, 29 / 20 materials, 87.7 / 66 MiB textures; Chad kept the full-quality export (I-08). The old build's prompt still says an FBX export clears the undo history (F-89) |
| Batch E partial live check | PASS (F-92, F-88, F-89 plugin side, F-93); F-87 with notes | Chad installed the plugin at 10:00, while the batch E workflow was still writing F-95/F-91, F-90 and the docs: the installed files equalled the repo (F-89 plugin side, F-92, F-88, F-87, main.py's future import), all parse as Python 3.8 and the Python suite passed (642). F-92: uniform pants loaded (Pants selected) then delete_avatar: no crash, "CC5's selection (Pants) was cleared before the delete"; uniform shirt, pants and boots (Boots selected) then a recipe base step: no crash; a batch whose variant 1 wore the uniform pants: variant 2's scene clear did not crash. F-88: with four expression sliders set, export_obj warned (the old TS build words it "not as asked" as an error; the new code does not) and replace_mesh_from_obj refused, naming the sliders, changing nothing; after reset_expression, export, replace: max 0.00 cm. F-89: the batch reply no longer carries the undo-history line. F-87: bake_skin_textures names "Bake All Skin Textures" and "Bake All Substance Textures" as disabled: the word matcher also takes the Substance bake (not a skin bake), and the reply's first words "No skin bake command found:" contradict it |
| scripts/live_smoke_test.py | 97 PASS / 2 FAIL / 3 SKIP | FAIL "exec_python blocked without dev mode": CC5 ran with CC5_DEV_MODE=1 (expected). FAIL "replace_mesh_from_obj (round trip checked)": F-101. The prop import stopped on CC5's "Import Settings" (Convert All / Cancel), as the script expects; Claude answered Convert All and CC5 did not crash (F-51 not reproduced). The script left "Key Light - Up" red at multiplier 1 (it never restores the colour), so Chad closed CC5 for a clean relaunch |

New findings: F-95 (load_asset reply lines run together), F-96 (CC5's Python is 3.8.8), F-97 (an eye preset's cornea
opacity as a CHECK line), F-98 (a cancelled step reads OK), F-99 (QML dialogs have no buttons the bridge can see),
F-100 (batch reply hides carried answers and injury files), F-101 (replace refused after the smoke test's steps),
F-102 (set_shader_parameter echoes raw float32), F-103 (search_morphs on an empty scene says no morph matched).

**F-95: load_asset's reply lines run together in Claude Code** (live) · minor. The reply showed "Asset loaded:
C:/.../US_Army_Uniform_Pants.ccCloth (applied to Kevin)Compared before and after: 2 worn items, ...":
formatLoadResult returns the first line and the report as two text blocks, and Claude Code shows them without a
separator (in parallel calls it showed them as separate blocks).

**F-96: CC5 5.13 runs Python 3.8.8** (live) · doc. sys.version in exec_python: "3.8.8 (tags/v3.8.8:024d805, Feb 19 2021,
13:18:16) [MSC v.1928 64 bit (AMD64)]"; the crash dumps load python38.dll. CLAUDE.md and .claude/rules/cc5-dev.md say
3.10, and the Python tests run under 3.14, so a 3.9+ feature in the plugin would pass every test and fail only inside
CC5. A scan found none today. Fix (batch E): the docs, and a test that parses every plugin module as Python 3.8.

**F-97: an eye preset's own cornea opacity is reported as a side effect** (live) · minor. _Blue1 Eyes.ccEye on CC4 Kevin
reported "CHECK opacity on CC_Base_Eye/Std_Cornea_R: 1 -> 0.8" (and _L): the eye preset's own setting, what the load is
for. Fix: material changes on the eye meshes of an eye preset load are Applied lines.

**F-98: a step the user cancelled is reported OK** (live) · minor. After Chad's Cancel on _Hazel1 Eyes' Replace /
Material Only question, the continued recipe reported "OK   asset _Hazel1 Eyes.ccEye (after the answer)" and "All 2
steps succeeded", though CC5 applied nothing. Fix: a step whose question was answered Cancel says so and is not counted
as succeeded.

**F-99: QML dialogs have no buttons the bridge can see** (live) · minor. CC5's Export FBX dialog (IC::CFbxExportDialog)
is one QQuickWidget: its buttons are QML items; its only QAbstractButton is the title bar's unlabelled close button
(qtCloseWindowToolButton). The dialog tools say "Buttons: none found" and the guard "a window open with no buttons".
Fix: name such a window as one whose buttons the bridge cannot read, to answer or close in CC5.

**F-100: the batch reply hides what the batch answered and wrote** (live) · minor. The reply said only "OK F80_D" and
"OK BO_Athletic": the Replace answered with the run's carried answer and the injury images and sidecar written beside
the FBX are only in patients_manifest.json, so the agent cannot tell the user. Fix: the reply names each carried answer
and summarises each variant's injuries line.

**F-101: replace_mesh_from_obj refused after the smoke test's steps** (live) · minor, cause to isolate. In
scripts/live_smoke_test.py the replace of the OBJ exported earlier in the script (job cmd_f8938d31_197) failed: "CC5
did not read live.obj as expected (the mesh differs by up to 95.44 cm from the OBJ); the replace was undone." Between
the export and the replace the script ran export_goz (tpose), import_fbx (prop, Convert All), save_character,
apply_skin_overlay / remove_skin_overlay, set_skin_condition, export_textures, load_substance_textures and load_texture
plus undo. Run again on the same mannequin afterwards: max 0.00 cm; export_obj, export_goz (tpose), replace: 0.00 cm.
The post-check worked (the replace was undone and the reply said so); a 95 cm difference looks like the arms of another
pose. Next: rerun the script's steps between export_obj and the replace one at a time.
Cause found (2026-10-07, after the restart; scratchpad f101_probe.py: fresh neutral avatar, export_obj, the steps,
replace). The smoke test's chain reproduced it (95.44 cm, replace undone); load_texture with its undo alone: 95.44
cm; load_texture alone: 95.44 cm; load_texture, a 3 s wait, replace: 0.00 cm. So the replace fails when it starts
while CC5 still loads the images of a texture load (OnImageAsyncLoadStart ... OnImageAsyncLoadAllDone; the window
of F-104): 95 cm is the arms, as if the OBJ were read in the character's A-pose (the replace removes the pose
first). With F-104's queue gate patched in live, load_texture then the replace at once: 0.00 cm twice.
Second cause (2026-10-07, batch F live check): with F-104's gate installed, the smoke test's replace still failed
(95.44 cm). load_texture with the script's immediate undo, then the replace: 95.44 cm 2 of 2; with a wait of 0.6,
1, 1, 1.5, 2 and 3 s: passed, failed, passed, passed, passed, passed. An undone colour change, or a capture (whose
own undo is an undo too), before the replace did not break the real replace; the replace's own steps run by hand
right after any undo did (95.44 cm, with the pose clip deleted). Re-evaluating the scene first (RGlobal.SetTime,
ObjectModified(Motion), ForceViewportUpdate) did not help, and no image load was pending. So the replace_mesh_from_obj
tool now runs a replace CC5 read differently (and the plugin undid) once more after 3 s, and says so; live, MCP
export_obj, load_texture, undo, replace: the first try came back 95.44 cm off and was undone, the second, 3 s
later, matched (0.00 cm). The smoke test, which calls the plugin directly, waits 3 s after that undo.

**F-102: set_shader_parameter echoes raw float32 values** (live) · minor. Setting the hair's RootColor to [0.02,
0.018, 0.016] replied "set to [0.019999999552965164, 0.017999999225139618, 0.01600000075995922]", as F-13 and F-62 did
for morph weights.

**F-103: search_morphs on an empty scene says no morph matched** (live) · minor. With no character in the scene,
search_morphs("height") replied "No morphs found matching 'height'" (also 'scale', 'tall', 'short'); with the
character loaded the same search lists 200 morphs, among them Character Height. CC5 lists morphs only for a loaded
character, so the reply should say that.

### Batch E partial check, part 2, and the capture and replace probes (2026-10-07)

10:59-11:15 with Chad: the new MCP build through scratchpad mcp_call.mjs (the session's own MCP server was the old
build), the plugin snapshot of 10:00. 11:29-12:10 by Claude alone, after Chad's machine restarted: CC5 relaunched
with scripts/cc5-restart.ps1 ("Bridge up after 34s"), CC5_ALLOW_EXEC=1 and CC5_DEV_MODE=1, empty scene; probes in
exec_python, with the bridge's queue patched in memory for the gate checks and restored afterwards.

| Check | Result | What happened |
|---|---|---|
| F-95 load reply | PASS | New build, load_asset Basic T-shirts on Kevin: one text block, "Asset loaded: ... (applied to Kevin)" / "Compared before and after: 2 worn items, 14802 shaping morphs, 20 materials (3.4 s)." / "Applied: added Basic T-shirts (clothing)" / "NOT CHECKED: how it sits on the character ...: run check_fit", each on its own line. The old build still returned two blocks. check_fit's reply was not checked |
| F-91 wording | PASS | New build, Red Velvet on Kevin: no CHECK or Applied line, "NOT CHECKED: what CC5 shows but cannot report (hair, brows or clothing hidden in the viewport, makeup or skin layers): capture the face ... and the whole body ..."; nothing about the SkinGen session (cause under F-91) |
| F-87 | NOTES | Reply and Chad's answer under F-87; the command was not triggered |
| F-101 exclusions | PASS | 10:12-10:14 on Kevin: export_obj, export_textures, replace: 0.00 cm; export_obj, import_fbx (prop F92_V2.fbx, Convert All, the prop selected), replace: 0.00 cm (09:11: export_goz tpose between: 0.00 cm). Cause found later (F-101) |
| F-51 | not reproduced | Prop imports with Convert All at 09:09 (smoke test) and 10:13: no crash |
| F-104 first seen | box gone | Kevin in a SkinGen session (Cordial): load_asset Box_001.iProp asked the SkinGen question (job); Claude answered OK and, while job_status said "running", sent capture_viewport: the capture (it waited behind the job) shows the box, then no read listed it (delete_object "Object not found: Box_001", get_scene_objects, every EObjectType) and the next capture had no box. With the job waited for first (twice) the box stayed |
| Slowdown | CC5 (F-105) | 11:09 delete_object Box_001 timed out after 30 s ("still working"; it completed), the next Cordial load finished about 3.5 minutes later, an exec_python was cancelled after 30 s; CharacterCreator.exe used 5.9 GB (3.2 GB at 10:05) and Claude Code's own hooks timed out too. Then Chad's machine had to restart |
| F-104 reproduced | CAUSE FOUND | Empty scene: cc5_api.load_asset(Box_001) and cc5_api.capture_viewport() in one exec_python: box gone; in two calls: kept. Through the bridge as first seen (a 2 s exec_python, then a load_asset job and a /viewport/capture queued behind it): gone in 6 of 7 runs, with the queue as installed, one command per tick or an idle wait (the run that kept the box had event logging on). Captures 0, 0 and 16 ms after the load: gone; 16, 50, 50 and 150 ms: kept (an earlier series, 16 to 1500 ms: kept); right after CC5's ImageAsyncLoadAllDone event: kept 6 of 6. No help: one command per timer tick, waiting until Qt's event loop went idle, BeginAction(name, bBlockRecordUndo=True) around RenderImage (it still recorded a step) and BeginAction/EndAction around it. A bare render records a step also with nothing selected (Key light 3 -> 1.7, render, undo: still 1.7) |
| F-104 gate | PASS (live-patched queue) | The queue holds capture_viewport and replace_mesh_from_obj until 0.3 s after the previous command and until CC5's image load is done (REventCallback OnImageAsyncLoadStart / OnImageAsyncLoadAllDone, at most 20 s): the bridge sequence above kept the box 5 of 5 |
| F-101 cause | FOUND, gate PASS | Under F-101: the replace failed (95.44 cm) whenever it started right after load_texture, and passed after a 3 s wait or with the gate (twice) |
| Memory | observation (F-105) | CharacterCreator.exe used 9.3 GB after these probes (about 40 box loads and captures, six avatar create/delete cycles); one create_avatar took over 30 s ("still working") |

New findings: F-104 (a capture takes back a load CC5 has not finished), F-105 (CC5's memory in a long session).

**F-104: a capture takes back a load that CC5 has not finished** (live) · blocker (data loss). capture_viewport
undoes one step after its render, because CC5 records each render as a step (F-53). CC5 does not finish a file load
when LoadFile returns: it goes on loading the images (REventCallback OnImageAsyncLoadStart ...
OnImageAsyncLoadAllDone). A render made in that window does not get a step of its own, and the capture's undo takes
the load back with it. Hit by any capture that runs right after a load: one sent while a load job runs (a parallel
call, or one sent after answering the load's question) waits behind it and runs in the same drain of the queue.
The same window broke replace_mesh_from_obj after load_texture (F-101). A wait for CC5's image load (and 0.3 s
after the previous command) prevented both in every run. Fix: the bridge's queue holds those two actions until
CC5 has finished, and the capture checks after its undo that no object or worn item went missing (if one did, it
redoes and says so). What does not help is under the probes above.

**F-105: CC5 slows down and grows to many gigabytes in a long session** (live) · minor (CC5), observation. At
10:05 CharacterCreator.exe used 3.2 GB; by 11:14 5.9 GB, when delete_object timed out after 30 s, a SkinGen preset
load took about 3.5 minutes and Claude Code's own hooks timed out (the whole machine was slow; it then needed a
restart). After the restart, about 40 box loads and captures and six avatar create/delete cycles took a fresh CC5
to 9.3 GB. The MCP cannot free CC5's memory; saving and restarting CC5 can. Idea: check_cc5_connection reports
CC5's memory and suggests a save and restart above a limit.
Chad (2026-10-07): "CC5 can have memory leaks. Something to be aware of. If this happens restarting CC5 usually
fixes it." So when commands slow down or time out, check CC5's memory first and ask the user to save and restart
CC5 before testing or diagnosing further.

### Batch E review (2026-10-07 11:25-12:07, workflow: five angles, each finding verified by two skeptics)

The rerun of the review the machine restart cut off, on batch E's diff against f03cf52. 26 findings: 19 confirmed
by both skeptics, 4 plausible (one of two), 3 refuted. The code cites them as "review #N". All 23 kept findings
were fixed in batch F, the four plausible ones too.
- #0 (bug): export_for_unity's skin-tint read (cc5_skin._read_tint) ignored the bridge's colour record (F-90), so
  a tint just set was missing from the reply and the injuries sidecar, or a cleared one was still listed;
  get_diffuse_color read stale the same way.
- #1 (minor, plausible): the F-34 comparison dropped a recorded colour silently when the read after the load
  equalled the stale read before it.
- #2 (minor, plausible): delete_avatar went on deleting when clearing CC5's selection raised (the F-92 crash case).
- #3, #4, #7, #19 (minor): a command waiting in a window with no buttons was still told to answer it (load_asset,
  job_status, the recipe stop, continue_after, check_cc5_connection's preamble), while get_cc5_dialog said to close
  it in CC5.
- #5 (bug), #6 (minor): the F-88 texts named at most three expression weights, and did not say that an OBJ exported
  with an expression must not come back even after reset_expression.
- #8 (minor): formatDialog lacked the guard's wording for a window whose text could not be read.
- #9, #18 (minor): cc5-restart.ps1's timeout message still said that some starts take over two minutes (F-93).
- #10 (test, plausible): nothing compared formatDialog's wording with server.py's.
- #11 (doc): stale test counts. #12 (doc): the README said the recipe base step and the batch scene clear name the
  cleared selection, but they dropped delete_avatar's notes. #13 (doc): CLAUDE.md still called the F-82, F-85 and
  F-64 live checks pending. #14 (doc): log rows not updated for batch E (F-84, F-90, F-91, F-94, F-95, F-96).
- #15, #22 (test): test_py38_compat missed X | None, typing names, a union in isinstance() and stdlib generics.
- #16 (doc): the README's Test section and cc5-dev.md never ran npm run test:py (the Python 3.8 check). #17 (doc):
  the README's dialog paragraph gave two different naming rules.
- #20 (test, plausible): after an undo or redo, CC5's stale reads could blame the next load for a colour.
- #21 (test): F-93's -UseBasicParsing had no regression test.
Refuted: create_character still sends every character to Unity and the Quest budget (true, but I-08 and not a
batch E regression; built in batch F); the README's F-92 known issue names the custom uniform; the F-92 tests pin
both delete paths.

### Batch F (2026-10-07 12:51-16:35, fixes for the batch E review and today's findings; live check pending)

Built by workflows: eight file-disjoint implementers and a docs agent; four follow-up agents for the gaps between
their files; then a review (below) and six fixers and a docs agent for it. Subagents ran no shell commands (Chad's
rule); Claude ran the build and the suites after each round: build clean, vitest 1,396 and Python 779 tests pass.
server.py and main.py changed, so CC5 needs install-plugin.ps1 and a restart.
- F-104: the queue holds capture_viewport and replace_mesh_from_obj (server.SETTLE_ACTIONS) until 0.3 s after the
  previous command ended and until CC5's async image load is done (an REventCallback on OnImageAsyncLoadStart /
  OnImageAsyncLoadAllDone, registered by main.initialize_plugin; at most 20 s). The capture reads a scene
  fingerprint (objects and worn items) before its render and after its own undo; if the undo took something back it
  redoes once and says so (WARNING), and while CC5 still loads images it leaves its own step and says so. A failed
  capture carries its notes in the error. The modal guard's 5 s wait restarts for a held command.
- F-101: fixed by the same gate.
- F-99: a dialog whose buttons are QML items (CC5's Export FBX) is named as one whose buttons the bridge cannot
  read: answer or close it in CC5; answer_cc5_dialog refuses it.
- Windows with no buttons (batch E review #3, #4, #7, #19, #8): every text says to close them (or answer or close
  them) in CC5; a window whose text could not be read goes to the user as a question; the Welcome page is named
  only for an untitled window with no text and no buttons.
- F-98: buttons clicked through answer_cc5_dialog (and a run's carried answers) are recorded on the job waiting in
  the dialog; a recipe or batch step answered Cancel is CANCELLED and not counted as succeeded; job_status and
  load_asset say a load or export was answered Cancel. A batch whose base load was answered Cancel fails that
  variant and goes on.
- F-100: the batch reply names each question the batch answered by itself and each variant's injuries line.
- F-91: a SkinGen preset's report adds a NOTE about the session it starts; CC5's "deactivate the current SkinGen
  session" question carries SKINGEN_QUESTION_RULE (a plain confirmation of a load the user asked for: OK) where an
  MCP command waits on it; a dialog no command waits on still goes to the user.
- F-87: the bake rule needs the word skin or skingen; every named command is listed; a disabled bake says CC5
  enables it once the character has SkinGen layers applied in the Appearance Editor.
- F-92: delete_avatar deletes nothing unless CC5's selection reads empty after the clear (else it refuses and says
  to run clear_selection or deselect everything in CC5); the recipe base step and the batch scene clear show its
  notes and stop on its refusal; a .ccProject load clears the selection first (a precaution).
- F-90 follow-ups: export_for_unity's tint read and get_diffuse_color use the bridge's colour record; a recorded
  colour whose reads did not move gets a NOT CHECKED note and leaves the record; after an undo, a redo or such a
  load, the characters present then report colour differences as NOT CHECKED until a capture renders.
- F-88: export_obj's warning and the replace's refusal carry every expression weight, reset_expression returns the
  weights it reset, and the replies show a ready set_expression line; an OBJ exported with an expression must not
  come back, even after reset_expression.
- F-97 (an eye preset's own eye-material changes are Applied), F-102 (rounded shader values), F-103 (search_morphs
  on an empty scene), I-07 (Lite Hair), I-08 (create_character for any character and target).
- Launcher: the real elapsed time, a timeout message without the refuted claim, a test for -UseBasicParsing.
  test_py38_compat refuses X | None, typing names, a union in isinstance() and stdlib generics. Smoke test: restores
  the light, judges exec_python by CC5's answer.
- Docs: CLAUDE.md, README.md, .claude/rules/cc5-dev.md.

### Batch F review (2026-10-07 14:35-15:25, workflow: six angles, each finding verified by two skeptics)

35 findings: 29 confirmed, 4 plausible, 2 refuted. The code cites them as "batch F review #N". All 33 kept were
fixed before the live check, among them: a held capture kept the modal guard's old wait stamp (#0); the relaxed
delete rule never checked that the selection was empty after the clear (#1, the F-92 crash case); a capture could
still take back a preset or texture load while CC5 loaded images past the 20 s cap (#2); the colour reads after an
undo, and a record the comparison could not settle (#3, #14); redo notes (#4); a failed capture's notes were lost
in the 400 (#5, #9); a continued batch whose base load was answered Cancel was refused as a changed scene (#7);
job_status and load_asset reported "Asset loaded" after a Cancel (#8, #28); stop wording for windows to close and
for cancelled steps (#10, #11); the SkinGen rule on a dialog no command waits on (#12); SkinGen texts that claimed
more than was seen (#13); test fixtures no plugin sends (#29, #30, #31); and 15 doc findings about texts the
follow-up round had changed (#6, #15-#27, #32). Refuted: check_cc5_connection's wording for an unread dialog, and
the batch's "CC5 refused to delete" head.

### Batch F live check (2026-10-07 16:44-17:25; Chad reinstalled the plugin, Claude ran the checks)

Setup: install-plugin.ps1 (the eight installed .py files equal the repo); CC5 launched with scripts/cc5-restart.ps1
and CC5_ALLOW_EXEC=1, CC5_DEV_MODE=1 ("Bridge up after 34s", now the measured time). The session's own MCP server
was still the 11:22 build (no /mcp reconnect), so the tool replies were checked with the new build through
scratchpad mcp_call.mjs (one call) and mcp_seq.mjs (several calls on one server, for continue_after).

| Check | Result | What happened |
|---|---|---|
| Image watch | PASS | server._image_watch_id set (class _ImageLoadWatch) at plugin start; SETTLE_ACTIONS capture_viewport and replace_mesh_from_obj, 0.3 s, 20 s |
| F-104 gate | PASS | The bridge sequence that lost the box 6 of 7 times before (a 2 s exec_python, then a load_asset job and a /viewport/capture queued behind it): box kept 3 of 3 |
| F-104 capture check | PASS | cc5_api.load_asset and capture_viewport in one exec_python (no queue between them): the watch saw the image load start during LoadFile, the capture left its own step with "WARNING: CC5 was still loading images when this capture rendered, so the capture did not undo its own render step (F-104) ..." and the box stayed |
| F-104 as first seen | PASS | Red Velvet on the neutral character, then Box_003.iProp: CC5's SkinGen question; OK through answer_cc5_dialog, and at once a capture while job_status said running: the capture waited behind the job, and Box_003 stayed |
| F-101 | PASS, second cause found | load_texture then the replace at once: 0.00 cm 2 of 2 (the gate). With the smoke test's immediate undo after load_texture it still failed: see F-101's second cause; with the tool's retry, live: first try 95.44 cm and undone, second 3 s later 0.00 cm |
| F-90 | PASS (plugin) | set_skin_color(0.8, 0.6, 0.5), then get_diffuse_color: (0.8, 0.6, 0.502) with "This is the colour the bridge set. CC5 reports a material's colour only after it next renders ..."; then Sport sneakers.ccShoes: no colour fact in the comparison (1 fact, the shoes) |
| F-102 | PASS | set_shader_parameter Original Roughness Strength [0.37]: "set to [0.37]" |
| F-87 | PASS | bake_skin_textures: 'CC5's "Bake All Skin Textures" command is disabled right now, so nothing was run. CC5 enables it once the character has SkinGen layers applied in the Appearance Editor.'; the Substance bake no longer named; every named command in "Commands looked at" |
| I-07 | PASS | search_content "bob" (hair): the two Prime Hairstyles first, then twelve Lite Hair styles each labelled "Lite Hair: low-poly mobile version, only as a fallback"; browse_content hair shows 50 entries and no Lite Hair among them (listed last, past the 50) |
| F-98, single load | PASS | _Blue1 Eyes on the neutral character asked Replace / Material Only; Chad chose Cancel, answered through answer_cc5_dialog: job_status "Cancelled in CC5 (load_asset): Asset load cancelled: ... (answered Cancel in CC5, so CC5 applied nothing)" |
| F-97 | PASS | The same preset again, Replace: the preset's changes on CC_Base_Eye/Std_Cornea_R (12 shown, "... and 16 more") reported as Applied lines, no CHECK line |
| F-91 | PASS | Red Velvet: the NOTE about the SkinGen session; Box_003 during the session: the waiting reply carries SKINGEN_QUESTION_RULE after the question |
| F-92 notes | PASS | delete_avatar with Box_003 selected: "Deleted avatar(s): CC3_Base_Plus" and "CC5's selection (Box_003) was cleared before the delete ..." |
| F-103 | PASS | search_morphs "height" on an empty scene: "No character in the scene: CC5 lists morphs only for a loaded character. Load or create one first." |
| F-98, recipe | PASS | apply_character_recipe {base default, _Blue1 Eyes}: stopped at the question (the base step showing delete_avatar's note, the WAIT line ending "then continue_after reads its result"); Cancel (Chad's go-ahead for the test); continue_after: "1 of 2 steps was cancelled in CC5; 1 succeeded." and "CANCELLED asset _Blue1 Eyes.ccEye (after the answer) (answered Cancel in CC5, so CC5 applied nothing)" |
| F-100 | PASS | Batch into %TEMP%\cc5_live\Assets\Test\F100 (injuries separate): stopped at F100_A's question; Replace (Chad's go-ahead); continue_after with layer_answer Replace: "2/2 variants exported", F100_B: "asset _Blue1 Eyes.ccEye: CC5 asked 'Replace / Material Only'; answered 'Replace' (the user's answer earlier in this run)" and "injuries 'separate': F100_B_injuries.json written beside the FBX"; each variant's scene clear names the selection it cleared. Both exports ran without a crash |
| F-99 | PASS | Chad opened File > Export > FBX. get_cc5_dialog: 'CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or close it in Character Creator 5 (no MCP tool can click its buttons).'; check_cc5_connection the same; list_avatars failed after 5 s with it and ", then try again."; answer_cc5_dialog refused it; the plugin's view: buttons_unreadable true. Nothing was clicked |
| Smoke test | 99 PASS / 1 FAIL / 3 SKIP | The light now goes back ("Key Light - Up: was (1.0, 1.0, 1.0, 5.0), now (1.0, 1.0, 1.0, 5.0)"); "exec_python (CC5 allows it)"; FAIL replace_mesh_from_obj: F-101's second cause (the script now waits 3 s after its undo; not run again). Import Settings answered Convert All: no crash (F-51) |
| Memory | observation | CharacterCreator.exe 3.9 GB after these checks (F-105) |

Not live-checked: I-08 (the create_character prompt's text; covered by tests), F-87's bake with SkinGen layers
applied, the capture's redo path (F-104; the gate now prevents the case it guards), and the session's own MCP server
with the new build (/mcp reconnect).

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
Built (Batch D): STORE_RULE and STORE_HINT (src/prompts/content-rules.ts) in the browse_content and search_content
descriptions and their replies when nothing matches, in the MCP server instructions, and in the create_character
prompt's store rule.

**I-03: show the pick list before applying a general ask** (Chad, 2026-10-05) · protocol
When the user's ask is general or leaves the choice open ("dress him top to bottom", "give him a hat", "make him
look older"), Claude first presents the list of items it will apply (name, file, what it changes) as a check and
waits for the user's go-ahead before loading anything. Seen at P5-23 to P5-26: Claude picked Slim Jeans, Basic
T-shirt, Ankle socks A and Hat_DarkBlue and loaded them without showing the list. A specific ask ("load the Canvas
Shoes") needs no check. Pairs with F-34 (capture before/after) and I-02 (offer store items when nothing local
fits). To build into the MCP: a "propose, confirm, apply" step in the create-character prompt and in the
`load_asset` / `apply_character_recipe` descriptions.
Built (Batch D): PICK_RULE in the browse_content, search_content, load_asset and apply_character_recipe descriptions
and in the MCP server instructions, BATCH_RULE in batch_generate_patients, and "Pick list first" in the
create_character prompt.

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

**I-05: drive the controls that content packs add** (Chad, 2026-10-06, P6-11) · capability
Chad: CC5's real power is its content packs. "All the controls live as additional layers in the Modify panel": for
example, Face Wrinkle M.ccSkinGenPreset adds extra skin controls to CC4 Kevin. The built-in tools are the bare
minimum. Today the MCP can load such presets (`load_asset`, `browse_content('skingen')`), but it cannot see or set
the layer controls they add. CC5 5.13's RLPy has no SkinGen or appearance-layer API; checked live, there are no skin,
layer or makeup calls on RLPy, the avatar (`RIAvatar`) or the material component. The only route seen so far is
driving the Modify panel's widgets through Qt, as `create_actor_mixer` drives its dialog, which is fragile across CC5
versions. First step: load Face Wrinkle M on Kevin and record what changes, for example whether Std_Skin_Head gains
shader parameters or textures (it has `BaseColor Blend2 Strength` and `NormalMap Blend Strength` at 0 today) and
which widgets the Modify panel shows. The same route may cover F-67's clinical looks and F-70's aging.
Data point (end of Part 6): Kevin was changed by hand in CC5 after P6-11, most likely by applying Face Wrinkle M.
Afterwards the Boxers no longer rendered, though `list_clothes` still listed them (as in F-34). The skin looked more
even and tanned, and the face more weathered. RLPy's `HasImage` then reported no texture in any channel of the four
skin materials, which had five each before (Metallic, Diffuse, Bump, AO, Roughness). The shader parameter counts were
unchanged (Std_Skin_Head 56, the others 39), and `BaseColor Blend2 Strength` and `NormalMap Blend Strength` stayed 0.
So once such a preset takes over the skin, the material API seems to stop seeing its textures. Kevin was then
reloaded for Part 7.

**I-06: build characters the CC5 way, stage by stage** (Chad, 2026-10-06, Part 7) · protocol
Chad: "I think the CC5 workflow needs to be further explicitly defined and baked into the MCP process. In general in
CC5 you create a characters body and face first. Use content packs to define details and hair. Then you apply
clothing, shoes, and accessories. This is a step by step process. If there is a fully defined and dressed character
this should be listed as an option but it's not the typical workflow." Today the `create_character` prompt
(`src/prompts/create-character.ts`) starts from a character template and applies everything in one
`apply_character_recipe` call, which is the opposite. To build into the MCP:
1. Body and face: an undressed base (a template's body such as CC4 Kevin, or Neutral_M / Neutral_F), with morphs
   or a body preset and a facial profile. Headshot stays a manual CC5 step. Capture, then confirm with the user.
2. Details and hair: content packs (SkinGen presets such as Face Wrinkle M, skin, makeup, eyes; I-05) and hair.
   Check before/after (F-34).
3. Clothing, shoes and accessories. Check before/after, including items removed or replaced (F-34, P7-3), and do a
   multi-view collision check (F-44).

Each stage is shown as a pick list (I-03) and confirmed before the next. A fully dressed template is offered only as
an alternative. Applies to the `create_character` prompt, `apply_character_recipe` (stage-ordered, with a report per
stage, or one call per stage) and `batch_generate_patients`.
Built (Batch D): the stage-by-stage create_character prompt (src/prompts/create-character.ts: body and face, then
details, hair and skin, then clothing, shoes and accessories, then expression and pose, each with a pick list and a
confirmation) and the D2 recipe order (presets and hair before the skin colour, clothing after the overlays).

**I-07: Lite Hair is a low-poly fallback** (Chad, 2026-10-07, during the create_character run) · content rule
Chad: "Some of those hairstyles are super low poly versions made for mobile games. These need to be classified as
such and used only as a failsafe." The Lite Hair sets (Hair/Group/Lite Hair Female Vol. 1-3, Lite Hair Male Vol. 1-3,
Lite Hair Afro Vol. 1-2) are mobile versions: Lite Hair Female Vol. 1/Pixie.rlHair is 3,390 triangles and renders with
a sculpted, clay-like look; Prime Hairstyles/06_Ear length Bob.rlHair is 15,808. To build: browse_content and
search_content label Lite Hair entries ("low-poly, mobile") and list them after full-quality styles; the pick-list
rule offers them only when nothing else fits or when a budget the user named fails because of the hair.
Built (batch F): browse_content and search_content label a Lite Hair entry "Lite Hair: low-poly mobile version, only
as a fallback" and list it after the other hair; the create_character prompt offers Lite Hair only when nothing else
fits or the user's budget needs it. Live check pending.

**I-08: a general-use MCP** (Chad, 2026-10-07) · product rule
Chad: "Quest 3 export is just 1 option. This is not a MilExTS specific tool. This will be published as a General Use
MCP eventually. So it needs to be robust for a multitude of situations." Today the create_character prompt goes
straight to export_for_unity (sub_d_level 0, texture_size 2048) and check_quest_budget, and batch_generate_patients
and the injuries wording come from the medical-training use case. To build: the prompt asks for the export target
(Unity, Unreal, Blender, plain FBX) and any budget; the Quest budget is one optional check; prompts and tool texts
work for any character, not only patients; the Exonicus tools stay extensions.
Built (batch F): the create_character prompt builds any character (age, sex, build, skin, clothing, and any injuries
or special looks), asks where it goes (Unity with export_for_unity, Unreal with export_fbx and the UE5 settings,
Blender or another tool with export_fbx, or no export) and for any budget, and runs check_quest_budget for Quest 3 or
with the user's own limits. batch_generate_patients and the injury texts keep their medical-training wording. Live
check pending.

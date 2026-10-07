/**
 * MCP prompt that guides the model through building a character the way CC5 builds characters (I-06, Chad
 * 2026-10-06): stage by stage, body and face first, then details and hair, then clothing, shoes and accessories. Each
 * stage opens with a pick list (I-03) and closes with a capture and the user's confirmation; then the export and, if
 * the user named a budget, the budget check.
 *
 * I-08 (Chad, 2026-10-07: "Quest 3 export is just 1 option. This is not a MilExTS specific tool."): any kind of
 * character, not only patients. The export step asks where the character goes: Unity (export_for_unity, with the
 * user's injuries choice, F-75), Unreal (export_fbx with the recommended Unreal call in CLAUDE.md), Blender or another
 * tool (export_fbx with that tool's preset), or no export. check_quest_budget keeps its Quest 3 defaults only for a
 * Quest budget: no MCP tool reads the mesh counts on their own, so another budget is checked with check_quest_budget
 * and the user's own limits. I-07: Lite Hair only as a fallback. F-91: the SkinGen session a SkinGen or makeup preset
 * starts hides hair, brows and clothing, and the question that ends it is a plain confirmation.
 *
 * F-71: Claude Code passes only the first whitespace-separated word typed after the command to a prompt argument (live:
 * '"Adult' arrived for a whole description). So the description is optional, a one-word description is flagged and
 * the model is told to use and restate the full typed text or ask for it, and no description asks first.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LAYER_EXPECT } from "../build-session.js";
import { IMAGE_TYPES_TEXT } from "../tools/pipeline.js";
import { SKINGEN_QUESTION } from "./content-rules.js";

/** What a character description gives (I-08: any character, not only a patient). */
const DESCRIPTION_PARTS = "age, sex, build, skin, clothing, and any injuries or special looks";

/** The intro after the first line: ask for the description, or restate what arrived (F-71). */
function introLines(typed: string): string[] {
  if (!typed) {
    return [`First ask me for the character description (${DESCRIPTION_PARTS}) and wait for it.`];
  }
  return [
    `Character description, as this prompt received it: "${typed}"`,
    /\s/.test(typed)
      ? "If I typed more after the command than this, use my full text. Repeat the description you will build at the start of your first reply."
      : "Only one word arrived, so the description was probably cut off: Claude Code can pass only the first word typed after the command to a prompt. Use the full text I typed after the command and repeat it at the start of your first reply; if you cannot see it, ask me for the full description before you start.",
  ];
}

export function buildCreateCharacterPrompt(description?: string): string {
  const typed = (description ?? "").trim();
  return [
    "Build this character in Character Creator 5 the way CC5 builds characters, stage by stage: body and face first, then details and hair, then clothing, shoes and accessories.",
    ...introLines(typed),
    "",
    "Rules for every stage:",
    "- Pick list first: before you load or change anything in a stage, show me what you plan to apply (each item's name, its file path and what it changes; mark the items I named myself) and wait for my go-ahead. I may change the list.",
    "- Real files only: find content with search_content or browse_content and use the paths they return; never invent a path. The results include my own content from CC5's Custom tab (paths under 'Reallusion Custom'); include it in the pick list when it fits.",
    "- Nothing installed fits: search the Reallusion store (Content Store and Marketplace) on the web if you can, and show me what you found: name, link, price, and whether it works in CC5 (CC4/CC5 compatible, the right content type). Only suggest: I decide, buy or download it in my own account and tell you where it was installed; then load it from there.",
    "- Before and after: load_asset and apply_character_recipe compare the character before and after every content load and print CHECK and NOT CHECKED lines. When a load prints CHECK lines (an item removed or swapped, the skin tone reset, an overlay gone), show them to me with captures and offer undo before you load or change anything else. A skin tone that a preset changed in stage 2 is set again by the skin colour step later in that stage: say so when you show that line. Compare list_clothes, list_hair and list_accessories before and after as well. NOT CHECKED is what CC5 cannot report: capture the face (frame_camera 'face') and the whole body ('home') before and after skin, makeup, eye and hair presets. " +
      "A SkinGen or makeup preset starts a SkinGen session: until a later content load or a delete ends it, the viewport hides hair, brows and clothing, which stay on the character and in an export (set_item_visible does not bring them back); say so when you show me the captures.",
    "- CC5 questions: when a command, a load or a recipe reports that CC5 is waiting for an answer, stop and run nothing else until it is answered. A call that comes back 'Timed out before CC5 started the command' did not run: CC5 is probably still waiting on an earlier question, so run get_cc5_dialog and deal with that first. 'CC5 is busy' means a progress window: wait and try again, and never cancel it unless I ask. Answer a plain confirmation of exactly what I asked for yourself and tell me; for a real choice show me the question and its buttons with your recommendation and let me pick. " +
      `A content load after a SkinGen or makeup preset can ask "${SKINGEN_QUESTION}": for a load I asked for it is a plain confirmation, so answer OK and tell me (OK ends the SkinGen session, the makeup stays and the load goes on). ` +
      `'Replace / Material Only': the first time CC5 asks it while you build this character, I pick; after that, for the rest of this character's build, answer it yourself with my choice of Replace or Material Only (answer_cc5_dialog with expect '${LAYER_EXPECT}') and tell me each time; never carry it to another character. ` +
      "A Cancel is not carried: if I picked Cancel, the next time CC5 asks it, show me the question and let me pick again. " +
      "When a recipe stopped, go on with the call its report gives (for Replace / Material Only pass my button as layer_answer; if I picked Cancel, go on with continue_after and no layer_answer: a Cancel is not carried, and the next identical question goes to me again).",
    "- End of each stage: capture the result, show it to me, and wait for my confirmation before the next stage.",
    "",
    "Steps:",
    "1. check_cc5_connection. Unless I ask to keep the character already in the scene, choose an undressed base body: a textured character template from browse_content('character') (or search_content with folder_types ['character'] and words from the description), such as CC4 Kevin, CC4 Camila, or Neutral_M / Neutral_F. A template that comes fully dressed (clothing, shoes and hair already on) is not the usual start: offer one only as an alternative, when one fits the description. Do not use base 'default': it is CC5's neutral mannequin, with no skin or eye textures, eyebrows, eyelashes or hair.",
    "2. Stage 1, body and face: one apply_character_recipe call with only base, body_preset or morphs (search_morphs for specific features) and, if wanted, facial_profile (an expression set: it changes how expressions look, not the shape of the face). A face made from a photo is a manual step I do in CC5; do not attempt it with these tools. Capture the whole body ('home') and the face ('face').",
    "3. Stage 2, details, hair and skin: content presets first, one load_asset at a time with the before and after check: skin and SkinGen presets (browse_content('skingen'); e.g. Face Wrinkle M for an older face), makeup (makeup_full, makeup_foundation, makeup_eye, makeup_lip), eye presets ('eye'), then a hairstyle ('hair', .rlHair). Lite Hair sets are low-poly mobile versions: offer them only when nothing else fits or when my budget needs them. " +
      "Then the skin colour and any skin condition the description calls for, after the presets because a preset can reset the skin tone: set_skin_color, then set_skin_condition with that colour as base_rgb (e.g. pale for blood loss or shock; cyanotic for hypoxia, which CC5 still shows only as slightly darker, duller skin: show me a capture and say so). " +
      `Then injuries, if the description has any: apply_skin_overlay with overlay images I provide (${IMAGE_TYPES_TEXT}; ask me for them; CC5 content has none).`,
    "4. Stage 3, clothing, shoes and accessories: one load_asset at a time with the before and after check; tell me about every item a load removed or replaced (the template's own clothes can be swapped out). Then check_fit, which captures the 'face' view and the 'front', 'left', 'right' and 'back' views: look for skin or scalp showing through clothing, hats or hair and tell me what you see, view by view. Propose a fix (another item, removing one, or fixing it by hand in CC5) before you apply it.",
    "5. Stage 4, expression and pose: set_wrinkle_strength only if wanted (it scales expression wrinkles, which show while an expression is active; it does not age a resting face: for age use morphs or a SkinGen preset), then set_expression, then apply_pose with a file from browse_content('pose') if a pose is needed. Run check_fit again after a pose, and capture.",
    "6. Export: first ask me where the character goes, unless I already said: Unity, Unreal, Blender, another tool, or no export (then skip the rest of this step). Ask me too whether it must meet a budget (triangles, materials, texture size), unless I already named one. " +
      "For Unity, ask me for the Unity Assets folder (inside an existing Unity project, whose ProjectSettings\\ProjectVersion.txt must exist) and a character name. If this character has injury overlays (apply_skin_overlay, or a diffuse_blend image on any material) or a skin condition, ask me how they should reach Unity for this character, because an FBX cannot carry them: 'bake' (burned into this export's diffuse textures), 'separate' (the overlay images plus a JSON sidecar beside the FBX, for a Unity material to blend) or 'omit' (leave them out). Ask every time; there is no default. " +
      "For any other target, ask me for the .fbx path; if this character has injury overlays or a skin condition, tell me that the FBX will carry neither, because export_fbx has no option for them (with target_tool 'Blender', the JSON material file CC5 writes beside the FBX was seen to hold a skin condition's shader values). " +
      "Then, whatever the target, call save_character (a .ccAvatar path outside the export folder and any Unity Assets folder; a .ccAvatar keeps neither the facial expression nor the pose) before the first FBX export of this CC5 session, because CC5 5.13 often crashes on that export and the character would be lost. " +
      "Then export. Unity: export_for_unity with sub_d_level 0, wait_seconds 120, injuries as I chose, include_current_pose: true if a pose was applied in stage 4, and texture_size only when my budget limits the texture size (the largest of 512, 1024, 2048 and 4096 within it; 2048 for Quest 3). If it replies 'Not exported' with a list of overlays or skin conditions, show me the list and ask me before you call it again. If it returns a job id, call job_status until the job finishes. Tell me what the reply says the FBX does not carry. " +
      "Unreal: export_fbx with target_tool 'UE5', export_motion true, sub_d_level 0, embed_textures true and fps 30. Blender: export_fbx with target_tool 'Blender' and sub_d_level 0 (CC5 also writes a JSON material file beside the FBX for Reallusion's Blender add-on). Another tool: export_fbx with target_tool 'Maya' for Maya, else 'Default', and sub_d_level 0. With export_fbx, add texture_size as for Unity, and if a pose was applied in stage 4, include_current_pose true, export_motion true and motion_range [0, 0] (a mesh-only FBX is always in the bind pose). " +
      "Tell me every WARNING or failed line of the reply. If CC5 crashes during the export, tell me; once CC5 runs again, reload the saved .ccAvatar (apply_character_recipe with base), set the expression and the pose again, and export again.",
    "7. Budget, only if I named one: check_quest_budget, with export_folder set to the folder of this export's texture files (export_for_unity's folder; for export_fbx, the .fbm folder CC5 writes beside the FBX, if there is one) and remove_tearline_occlusion if the export used it. " +
      "Quest 3 (or a Quest budget): use its defaults, which are the Quest budget. If it fails, tell me what is over budget and suggest fixes (fewer clothing layers, texture_size 1024, merging byte-identical materials in Unity, exporting again with remove_tearline_occlusion, or a Lite Hair style if the hair's triangles are the problem). " +
      "Another budget: pass my limits instead of its Quest defaults (max_faces for triangles, max_materials, max_texture_px) and compare only the lines for the limits I named: its verdict line still says 'Quest budget', and its texture memory line is a Quest (ASTC 6x6) estimate. If something is over, tell me what and suggest fixes (fewer clothing layers, smaller textures, or a Lite Hair style if the hair's triangles are the problem).",
    "8. Summarise: what was built at each stage, every CHECK line and fit problem, anything that changed that was not asked for, any failed step, where the character was exported (for Unity with the injury choice; for another target what the FBX does not carry), and the budget result if a budget was checked.",
  ].join("\n");
}

export function registerCreateCharacterPrompt(server: McpServer) {
  server.prompt(
    "create_character",
    "Build a character in Character Creator 5 stage by stage (body and face, then details and hair, then clothing), with a pick list and a check at each stage, then export it for Unity, Unreal, Blender or another tool, or not at all. Type the character description after the command, or leave it out and you are asked for it.",
    {
      description: z.string().optional()
        .describe(`The character: ${DESCRIPTION_PARTS}. Optional: left out, you are asked for it`),
    },
    ({ description }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: buildCreateCharacterPrompt(description) } }],
    }),
  );
}

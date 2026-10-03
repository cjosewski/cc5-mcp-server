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
    "1. check_cc5_connection. Unless I ask to keep the character already in the scene, start from a textured character template: browse_content('character') (or search_content with folder_types ['character'] and words from the description), and use the template's path as the recipe base. Do not use base 'default': it is CC5's neutral mannequin, with no skin or eye textures, eyebrows, eyelashes or hair.",
    "2. Find content with search_content (clothing, shoes, makeup). Pick real file paths from the results; never invent paths. Hair is not searchable: keep the template's hair, or use a .ccHair file path I give you.",
    "3. Call apply_character_recipe once with: base, body_preset or morphs (search_morphs for specific features), skin_rgb, skin_condition (pale for blood loss/shock, cyanotic for hypoxia), assets, and expression. Use headshot_photo only if I gave a photo.",
    "4. Read the step report. Fix any failed step with the individual tool, then capture_viewport.",
    "5. Injuries: apply_skin_overlay with PNG/JPG/TGA overlay images I provide (ask me for them; CC5 content has none); set_wrinkle_strength for age.",
    "6. pose_file via apply_pose if a pose is needed (browse_content('pose')). capture_viewport.",
    "7. Ask me for the Unity Assets folder and a character name, then export_for_unity with sub_d_level 0 and texture_size 2048 (and include_current_pose: true if a pose was applied in step 6).",
    "8. check_quest_budget with the export folder. If it fails, tell me what is over budget and suggest fixes (fewer clothing layers, texture_size 1024).",
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

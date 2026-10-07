/**
 * Skin and injury-state tools: overlays (bruises, dirt, blood), clinical skin
 * condition tints, and wrinkle strength.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult, warningNotes } from "../util.js";
import { checkFile, IMAGE_EXTENSIONS, IMAGE_TYPES_TEXT } from "./pipeline.js";

export const SKIN_REGIONS = ["all", "head", "body", "arms", "legs"] as const;
export const SKIN_CONDITIONS = ["normal", "pale", "cyanotic", "flushed", "jaundiced"] as const;

/** A 0-1 strength as a percentage: 0.6 -> "60", 0.333 -> "33.3". */
const percent = (weight: number) => String(Math.round(weight * 1000) / 10);

/**
 * apply_skin_overlay's reply. CC5 reads a new strength back only after it renders (F-65), so a read that differs from
 * the strength set is reported as such, never as the strength.
 */
function overlayApplied(file: string, strength: number,
  r: { applied_to?: string[]; strengths?: Record<string, number>; stale?: string[] }): string {
  const applied = `Applied ${file} at ${strength}% to: ${(r.applied_to ?? []).join(", ")}`;
  const reads = Object.entries(r.strengths ?? {});
  if (!reads.length) return applied;  // an older plugin, or CC5 could not read any material back
  const stale = r.stale ?? [];
  if (!stale.length) return `${applied} (CC5 reads back ${percent(reads[0][1])}%)`;
  const differing = stale.map((mat) => `${mat} (${percent(r.strengths?.[mat] ?? 0)}%)`).join(", ");
  return `${applied}. CC5 still reads a different strength on ${differing} until it next renders: capture_viewport shows the overlay.`;
}

type RemoveOverlayResult = {
  success: boolean; error?: string; removed_from?: string[]; no_overlay?: string[]; reset?: string[]; notes?: string[];
};

/**
 * remove_skin_overlay's reply. The plugin also sets the Diffuse Blend strength to 0 on materials without an image
 * (F-66) and lists them in `reset` (X-5): that is a change, one CC5 undo step, so a call that removed no image but
 * reset a strength says so instead of "No skin overlay to remove". A failure from the real bridge never gets here: it
 * comes back as HTTP 400, and the tool shows CC5's error text, into which the plugin writes what was removed and the
 * WARNING lines (TS-2).
 */
function overlayRemoved(region: string, r: RemoveOverlayResult): string {
  const removed = r.removed_from ?? [];
  const reset = r.reset ?? [];
  const head = !r.success ? `Failed: ${r.error}`
    : removed.length ? `Removed overlays from: ${removed.join(", ")}`
    : reset.length ? `No overlay image in region '${region}'; the Diffuse Blend strength was set to 0 on: ` +
      `${reset.join(", ")} (one CC5 undo step).`
    : `No skin overlay to remove in region '${region}'`;
  return [head, ...warningNotes(r)].join("\n");
}

export function registerSkinTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "apply_skin_overlay",
    "Blend an image over the character's skin (bruising, abrasions, dirt, dried blood). The overlay is an image file the user provides (" + IMAGE_TYPES_TEXT + "; BMP and TIFF are not yet tested in CC5 5.13), laid out on the CC skin UVs (author it in Substance Painter or Photoshop). Strength 0-100.",
    {
      image_path: z.string().describe("Absolute path to the overlay image (" + IMAGE_TYPES_TEXT + ")"),
      region: z.enum(SKIN_REGIONS).default("all"),
      strength: z.number().min(0).max(100).default(100),
    },
    async ({ image_path, region, strength }) => {
      const err = checkFile(image_path, IMAGE_EXTENSIONS);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.applySkinOverlay(image_path, region, strength),
        (r) => r.success ? overlayApplied(path.basename(image_path), strength, r) : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "remove_skin_overlay",
    "Remove skin overlays previously added with apply_skin_overlay.",
    { region: z.enum(SKIN_REGIONS).default("all") },
    async ({ region }) => bridgeCall(() => bridge.removeSkinOverlay(region),
      (r: RemoveOverlayResult) => overlayRemoved(region, r))
  );

  server.tool(
    "set_skin_condition",
    "Move the skin toward a clinical appearance: pale (shock/blood loss: lighter and less saturated, through CC5's Digital Human skin shader), cyanotic (hypoxia), flushed or jaundiced (colour tints), or back to normal. amount 0-1. This replaces the colour set by set_skin_color; pass that colour as base_rgb to tint it instead (normal + base_rgb restores it). Every condition sets the Digital Human skin shader's base-colour Brightness and Saturation (pale raises Brightness and lowers Saturation; the other conditions set both back to 0), so a Brightness or Saturation change made by hand in CC5 is replaced.",
    {
      condition: z.enum(SKIN_CONDITIONS),
      amount: z.number().min(0).max(1).default(1),
      region: z.enum(SKIN_REGIONS).default("all"),
      base_rgb: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional()
        .describe("Skin tone to tint (the RGB given to set_skin_color); defaults to white"),
    },
    async ({ condition, amount, region, base_rgb }) => bridgeCall(() => bridge.setSkinCondition(condition, amount, region, base_rgb),
      (r) => r.success
        ? [`Skin set to ${condition} (${Math.round(amount * 100)}%) on: ${(r.applied_to ?? []).join(", ")}`, ...warningNotes(r)].join("\n")
        : `Failed: ${r.error}`)
  );

  // F-70: live, a neutral face did not change: the strength scales the creases of an active expression only.
  server.tool(
    "set_wrinkle_strength",
    "Set the strength of CC5's expression wrinkles (0 = none, 1 = full): the creases that show while an expression is active (brow raise, squint, smile...). It does not age a resting face: at a neutral expression nothing changes. CC5 cannot read the value back, so check it with set_expression and capture_viewport. To make a face look older, use morphs (search_morphs) or a SkinGen preset (browse_content('skingen'), load_asset).",
    { strength: z.number().min(0).max(1) },
    async ({ strength }) => bridgeCall(() => bridge.setWrinkleStrength(strength),
      (r) => r.success
        ? `Expression wrinkle strength set to ${strength} (it shows only while an expression is active; CC5 cannot read it back)`
        : `Failed: ${r.error}`)
  );

  server.tool(
    "set_skin_shader",
    "Set one Digital Human skin shader parameter on all four skin materials at once (CC_Base_Body / Std_Skin_Head, _Body, _Arm, _Leg); setting it on one material leaves a visible seam. Skin shine is PBR roughness: 'Original Roughness Strength' (lower = shinier, Kevin starts at 0.85), not set_material_glossiness/specular. Other examples: '_BaseColorMap Brightness', 'Micro Roughness Scale'. get_shader_parameters on CC_Base_Body / Std_Skin_Head lists the names and how many values each takes. One undo step; check with capture_viewport.",
    {
      parameter_name: z.string().min(1).max(200).describe("Shader parameter name, e.g. 'Original Roughness Strength'"),
      values: z.array(z.number()).min(1).max(16).describe("New value(s), as many as the parameter has, e.g. [0.4]"),
    },
    async ({ parameter_name, values }) => bridgeCall(() => bridge.setSkinShader(parameter_name, values),
      (r) => r.success
        ? [`${parameter_name} set to [${(r.values ?? values).join(", ")}] on: ${(r.materials ?? []).join(", ")}`,
           ...((r.skipped ?? []).length
             ? [`WARNING: not set on every skin material, so a seam may show. Skipped: ${(r.skipped ?? []).join("; ")}`]
             : [])].join("\n")
        : `Failed: ${r.error}`)
  );
}

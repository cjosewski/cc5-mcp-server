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

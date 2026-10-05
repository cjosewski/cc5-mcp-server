/**
 * Content management tools for CC5 (clothing, hair, accessories).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isBrowseTruncation, type CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall } from "../util.js";

export function registerContentTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "list_clothes",
    "List the clothing (including shoes and socks) the avatar wears, by name and ID, or say that no clothes are applied.",
    {},
    async () => bridgeCall(
      () => bridge.listClothes(),
      (clothes) => {
        if (clothes.length === 0) {
          return "No clothes are applied.";
        }
        // CC5's numeric type is not a garment kind (live: Boxers and Slim Jeans 1, T-shirt and socks 4): left out.
        const lines = clothes.map(c => `- ${c.name} (ID: ${c.id})`);
        return `Clothes applied (${clothes.length}):\n${lines.join("\n")}`;
      },
    )
  );

  server.tool(
    "list_hair",
    "List the hair the avatar wears, by name and ID, or say that no hair is applied.",
    {},
    async () => bridgeCall(
      () => bridge.listHair(),
      (hairs) => {
        if (hairs.length === 0) {
          return "No hair is applied.";
        }
        const lines = hairs.map(h => `- ${h.name} (ID: ${h.id})`);
        return `Hair applied (${hairs.length}):\n${lines.join("\n")}`;
      },
    )
  );

  server.tool(
    "list_accessories",
    "List the accessories the avatar wears, by name and ID, or say that no accessories are applied.",
    {},
    async () => bridgeCall(
      () => bridge.listAccessories(),
      (accessories) => {
        if (accessories.length === 0) {
          return "No accessories are applied.";
        }
        const lines = accessories.map(a => `- ${a.name} (ID: ${a.id})`);
        return `Accessories applied (${accessories.length}):\n${lines.join("\n")}`;
      },
    )
  );

  server.tool(
    "remove_scene_item",
    "Remove a clothing, hair, or accessory item from the avatar by name. Use list_clothes, list_hair, or list_accessories first to find item names.",
    {
      item_name: z.string().max(256).describe("Name of the item to remove"),
    },
    async ({ item_name }) => bridgeCall(
      () => bridge.removeSceneItem(item_name),
      (result) => result.success
        ? `Removed item: ${result.removed}`
        : `Failed: ${result.error}`,
    )
  );

  server.tool(
    "browse_content",
    "Browse available CC5 content files by category. Returns file paths that can be loaded with load_asset. Wearables: cloth_upper (shirts, coats), cloth_lower (pants, skirts), cloth (full-body outfits), underwear, gloves, cloth_other (socks, outfit sets), shoes, accessory_head (hats, glasses), accessory_body (torso, arm and leg accessories), accessory_other (handheld and outfit pieces), hair (.rlHair hairstyles), eye (.ccEye eye presets). Scene/animation: pose, motion, expression, props, light, camera, character (pose/motion may be empty on a base install without content packs).",
    {
      folder_type: z.enum([
        "cloth_upper", "cloth_lower", "cloth", "underwear", "gloves", "cloth_other", "shoes",
        "accessory_head", "accessory_body", "accessory_other",
        "pose", "motion", "expression", "props", "light", "camera", "character",
        "makeup_full", "makeup_foundation", "makeup_eye", "makeup_lip",
        "image_layer", "skingen", "wrinkle_mask", "texture", "hair", "eye",
      ]).default("cloth_upper")
        .describe("Content category. Wearables: cloth_upper/cloth_lower/cloth/underwear/gloves/cloth_other/shoes/accessory_head/accessory_body/accessory_other/hair/eye. Scene & animation: pose/motion/expression/props/light/camera/character. Skin & makeup: makeup_full/makeup_foundation/makeup_eye/makeup_lip/skingen. Image libraries texture/wrinkle_mask also list image files (for apply_skin_overlay and load_texture); image_layer holds CC5 .iImgLayer stage items, not overlay images. Load a returned content path with load_asset."),
    },
    async ({ folder_type }) => bridgeCall(
      () => bridge.browseContent(folder_type),
      (listing) => {
        const truncated = listing.length > 0 && isBrowseTruncation(listing[listing.length - 1]);
        const files = truncated ? listing.slice(0, -1) : listing;
        if (files.length === 0) {
          return `No content files found for category '${folder_type}'.`;
        }
        // Check if the first entry is an error message
        if (files.length === 1 && (files[0].startsWith("Unknown folder") || files[0].startsWith("Error") || files[0].startsWith("Content browsing"))) {
          return files[0];
        }
        const display = files.slice(0, 50);
        let text = `Found ${files.length}${truncated ? "+" : ""} content file(s) for '${folder_type}':\n`;
        text += display.map(f => `- ${f}`).join("\n");
        if (files.length > 50) {
          text += `\n... and ${files.length - 50} more`;
        }
        if (truncated) {
          text += `\nCC5 lists at most ${files.length} files per category, so some are not shown: use search_content with keywords to find a specific item.`;
        }
        return text;
      },
    )
  );
}

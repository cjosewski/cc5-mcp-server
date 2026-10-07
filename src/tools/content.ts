/**
 * Content management tools for CC5 (clothing, hair, accessories).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isBrowseTruncation, type CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, bridgeErrorResult, type ToolResult } from "../util.js";
import { PICK_RULE, STORE_HINT, STORE_RULE } from "../prompts/content-rules.js";
import { isBrowseError } from "./builder.js";

export const NO_AVATAR = "No avatar in the scene.";

// I-07 (Chad, 2026-10-07): "Some of those hairstyles are super low poly versions made for mobile games. These need to
// be classified as such and used only as a failsafe." CC5's Lite Hair sets (Hair/Group/Lite Hair Female Vol. 1-3,
// Lite Hair Male Vol. 1-3, Lite Hair Afro Vol. 1-2) are mobile versions: live, Lite Hair Female Vol. 1/Pixie.rlHair
// has 3,390 triangles and renders clay-like; Prime Hairstyles/06_Ear length Bob.rlHair has 15,808.
export const LITE_HAIR_LABEL = " - Lite Hair: low-poly mobile version, only as a fallback";

/** I-07: whether a content path lies in a folder whose name starts with "Lite Hair" (the file's own name is not looked at). */
export function isLiteHair(filePath: string): boolean {
  return filePath.split(/[\\/]/).slice(0, -1).some((folder) => /^lite hair/i.test(folder.trim()));
}

/** I-07: what follows a hair entry's path in a reply: LITE_HAIR_LABEL for a Lite Hair hairstyle, else nothing. */
export function liteHairLabel(filePath: string): string {
  return isLiteHair(filePath) ? LITE_HAIR_LABEL : "";
}

/**
 * I-07: `entries` with the Lite Hair hairstyles moved after the other hairstyles, each group in its own order.
 * `hairPath` gives a hair entry's path and undefined for any other entry, which keeps its place (search_content's hits
 * of other categories). For browse_content's hair list and search_content's hits. This module imports builder.ts, so
 * builder.ts may use these helpers inside its handlers only, never while the modules load.
 */
export function liteHairLast<T>(entries: T[], hairPath: (entry: T) => string | undefined): T[] {
  const places: number[] = [];
  const full: T[] = [];
  const lite: T[] = [];
  entries.forEach((entry, i) => {
    const p = hairPath(entry);
    if (p === undefined) return;
    places.push(i);
    (isLiteHair(p) ? lite : full).push(entry);
  });
  const ordered = [...entries];
  [...full, ...lite].forEach((entry, k) => {
    ordered[places[k]] = entry;
  });
  return ordered;
}

const BROWSE_DESCRIPTION =
  "Browse available CC5 content files by category. Returns file paths that can be loaded with load_asset. Wearables: " +
  "cloth_upper (shirts, coats), cloth_lower (pants, skirts), cloth (full-body outfits), underwear, gloves, cloth_other " +
  "(socks, outfit sets), shoes, accessory_head (hats, glasses), accessory_body (torso, arm and leg accessories), " +
  "accessory_other (handheld and outfit pieces), hair (.rlHair hairstyles), eye (.ccEye eye presets). Scene/animation: " +
  "pose, motion, expression, props, light, camera, character (pose/motion may be empty on a base install without " +
  "content packs). Lists CC5's template content and the user's own content from CC5's Custom tab (paths under " +
  "'Reallusion Custom', plus 'Shared Custom' and 'Shared Templates' when they hold content), the user's own first. " +
  PICK_RULE + " If nothing listed fits, try search_content. " + STORE_RULE;

/**
 * A worn-item list (F-61): the plugin answers an empty list both when nothing is worn and when the scene has no
 * character, so an empty list is told apart by reading the avatars (only then).
 */
async function wornList<T extends { name: string; id: number }>(
  bridge: Pick<CC5Bridge, "getAvatars">,
  list: () => Promise<T[]>,
  none: string,
  heading: string,
): Promise<ToolResult> {
  try {
    const items = await list();
    let text: string;
    if (items.length === 0) {
      const avatars = await bridge.getAvatars();
      text = avatars?.length ? none : NO_AVATAR;
    } else {
      // CC5's numeric type is not a garment kind (live: Boxers and Slim Jeans 1, T-shirt and socks 4): left out.
      text = `${heading} (${items.length}):\n${items.map((i) => `- ${i.name} (ID: ${i.id})`).join("\n")}`;
    }
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    return bridgeErrorResult(err);
  }
}

export function registerContentTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "list_clothes",
    "List the clothing (including shoes and socks) the avatar wears, by name and ID, or say that none are applied, or that the scene has no character.",
    {},
    async () => wornList(bridge, () => bridge.listClothes(), "No clothes are applied.", "Clothes applied")
  );

  server.tool(
    "list_hair",
    "List the hair the avatar wears, by name and ID, or say that none are applied, or that the scene has no character.",
    {},
    async () => wornList(bridge, () => bridge.listHair(), "No hair is applied.", "Hair applied")
  );

  server.tool(
    "list_accessories",
    "List the accessories the avatar wears, by name and ID, or say that none are applied, or that the scene has no character.",
    {},
    async () => wornList(bridge, () => bridge.listAccessories(), "No accessories are applied.", "Accessories applied")
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
    BROWSE_DESCRIPTION,
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
        // TS-10: "No content folder resolved for '<category>'" (CC5 has no folder for it, or only the Custom root the
        // plugin leaves out) is an empty category, not a file.
        if (files.length === 0 || (files.length === 1 && files[0].startsWith("No content folder"))) {
          return `No content files found for category '${folder_type}'. Try search_content. ${STORE_HINT}`;
        }
        // CC5's other answers for a category it could not list (the prefixes search_content checks too): as they are.
        if (files.length === 1 && isBrowseError(files[0])) {
          return files[0];
        }
        // I-07: Lite Hair hairstyles are labelled and come after the others, so the 50 shown are full quality first.
        const hair = folder_type === "hair";
        const display = (hair ? liteHairLast(files, (f) => f) : files).slice(0, 50);
        let text = `Found ${files.length}${truncated ? "+" : ""} content file(s) for '${folder_type}':\n`;
        text += display.map(f => `- ${f}${hair ? liteHairLabel(f) : ""}`).join("\n");
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

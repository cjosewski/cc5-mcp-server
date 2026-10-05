/**
 * Scene selection tools for CC5: select items by name, read the selection, clear it.
 * CC5 applies much of its content to the selected character, as a click in the viewport would.
 * Also delete scene objects and move or scale them.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { ObjectTransformValues, SceneObject } from "../types.js";
import { bridgeCall } from "../util.js";

export function formatSelection(selected: SceneObject[] | undefined): string {
  if (!selected || selected.length === 0) return "Nothing is selected.";
  const lines = selected.map((o) => `- ${o.name} (${o.type}, ID: ${o.id})`);
  return `Selected (${selected.length}):\n${lines.join("\n")}`;
}

export function registerSelectionTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "select_objects",
    "Select scene items by name in CC5, as a click in the viewport or Scene Manager would: characters, the clothing, hair and accessories they wear, props, lights and cameras. Names come from list_avatars, get_scene_objects, list_clothes, list_hair or list_accessories. Replaces the selection unless add is true. If any name is unknown or matches more than one item, nothing changes. Selection is not added to CC5's undo history.",
    {
      names: z.array(z.string().min(1).max(256)).min(1).max(100).describe("Item names to select, e.g. ['Kevin']"),
      add: z.boolean().default(false).describe("true = add to the current selection; false = replace it"),
    },
    async ({ names, add }) => bridgeCall(
      () => bridge.selectObjects(names, add),
      (r) => r.success ? formatSelection(r.selected) : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "get_selection",
    "List what is currently selected in CC5 (name, type, ID).",
    {},
    async () => bridgeCall(
      () => bridge.getSelection(),
      (r) => r.success ? formatSelection(r.selected) : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "clear_selection",
    "Deselect everything in CC5.",
    {},
    async () => bridgeCall(
      () => bridge.clearSelection(),
      (r) => r.success ? "Selection cleared." : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "delete_object",
    "Delete scene objects by name: props (e.g. an imported FBX), lights, and the clothing, hair and accessories a character wears. Names come from get_scene_objects or the list_* tools. Characters are refused (use delete_avatar) and so is the camera (CC5 cannot make another). If any name is unknown or matches more than one item, nothing is deleted. All the names are one CC5 undo step, so a single undo brings them back.",
    {
      names: z.array(z.string().min(1).max(256)).min(1).max(100).describe("Item names to delete, e.g. ['box_01']"),
    },
    async ({ names }) => bridgeCall(
      () => bridge.deleteObject(names),
      (r) => r.success
        ? `Deleted (${r.deleted?.length ?? 0}):\n${(r.deleted ?? []).map((o) => `- ${o.name} (${o.type}, ID: ${o.id})`).join("\n")}`
        : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "get_object_transform",
    "Read where a prop, light or character is: position in centimetres (x, y, z, as in CC5's Transform panel) and scale.",
    {
      name: z.string().min(1).max(256).describe("Object name from get_scene_objects"),
    },
    async ({ name }) => bridgeCall(
      () => bridge.getObjectTransform(name),
      (r) => r.success ? `${r.name}: ${formatTransform(r)}` : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "set_object_transform",
    "Move and/or scale a prop, light or character, e.g. put an imported prop beside the character instead of on top of it. Position is in centimetres (x, y, z, as in CC5's Transform panel; a newly loaded character stands at the origin), scale is one number or [x, y, z]. Rotation is kept. Worn items move with their character and cannot be placed. One CC5 undo step. The result shows the transform before and after, read back from CC5.",
    {
      name: z.string().min(1).max(256).describe("Object name from get_scene_objects"),
      position: z.tuple([z.number(), z.number(), z.number()]).optional().describe("[x, y, z] in cm"),
      scale: z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])])
        .optional().describe("Uniform scale, or [x, y, z]"),
    },
    async ({ name, position, scale }) => bridgeCall(
      () => bridge.setObjectTransform(name, position, scale),
      (r) => !r.success ? `Failed: ${r.error}`
        : r.before && r.after
          ? `${r.name} placed.\nBefore: ${formatTransform(r.before)}\nAfter:  ${formatTransform(r.after)}`
          : `${r.name ?? name} placed (CC5 did not report the transform; check it with get_object_transform).`,
    )
  );
}

export function formatTransform(t: Partial<ObjectTransformValues>): string {
  const vec = (v?: number[]) => (v ? `(${v.join(", ")})` : "(unknown)");
  return `position ${vec(t.position)} cm, scale ${vec(t.scale)}`;
}

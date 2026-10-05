/**
 * Scene selection tools for CC5: select items by name, read the selection, clear it.
 * CC5 applies much of its content to the selected character, as a click in the viewport would.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { SceneObject } from "../types.js";
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
}

/**
 * Undo/Redo tools for CC5.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall } from "../util.js";

export function registerEditTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "undo",
    "Undo the last action in CC5. Use this to revert the most recent change. CC5 does not say when nothing is left to undo (this still reports success), so undo only as many steps as there were changes: after a viewport capture, an extra undo lets a later redo replay the capture instead of the change. An FBX export (export_fbx, export_for_unity, export_textures, batch_generate_patients) clears CC5's undo history: nothing done before it can be undone, and undo still reports success.",
    {},
    async () => bridgeCall(
      () => bridge.undo(),
      (result) => result.success ? "Undo successful" : `Undo failed: ${result.error}`,
    )
  );

  server.tool(
    "redo",
    "Redo the last undone action in CC5. Use this to reapply a previously undone change. A viewport capture taken after the undo replaces CC5's redo history (CC5 records each capture), so redo is then refused: re-apply the change instead. Any other change made after the undo replaces it too; CC5 does not report that, so redo then says it succeeded and changes nothing: check the result.",
    {},
    async () => bridgeCall(
      () => bridge.redo(),
      (result) => result.success ? "Redo successful" : `Redo failed: ${result.error}`,
    )
  );
}

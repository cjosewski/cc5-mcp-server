/**
 * Expression control tools for CC5.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall } from "../util.js";

/**
 * Review #5 (F-88): the OBJ round trip needs a neutral face, and the expression is set again after the replace, but
 * the replies named at most three sliders with their weights. A plugin result's `field` ({name: weight}:
 * reset_expression's reset_weights, export_obj's and replace_mesh_from_obj's expression_weights) becomes one ready
 * line with every slider: "To set the expression again: set_expression with Brow_Compress_L 0.6, Mouth_Frown_L 0.4".
 * Weights at most 4 decimals, as set_expression replies (F-13). Undefined when the field holds no weight (an older
 * plugin, a neutral face); JSON from another process, so an entry that is not a finite number is left out.
 */
export function setExpressionAgainLine(result: unknown, field: "reset_weights" | "expression_weights"): string | undefined {
  const weights = typeof result === "object" && result !== null ? (result as Record<string, unknown>)[field] : undefined;
  if (typeof weights !== "object" || weights === null || Array.isArray(weights)) return undefined;
  const sliders = Object.entries(weights)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  if (!sliders.length) return undefined;
  const list = sliders.map(([name, weight]) => `${name} ${Number(weight.toFixed(4))}`).join(", ");
  return `To set the expression again: set_expression with ${list}`;
}

export function registerExpressionTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "get_expression_info",
    "Get available facial expression groups and slider names for the current avatar. Use this to discover expression controls before adjusting facial animations.",
    {},
    async () => bridgeCall(
      () => bridge.getExpressionInfo(),
      (info) => {
        const groups = Object.keys(info);
        if (groups.length === 0) return "No expression data available.";
        let text = `Expression groups (${groups.length}):\n`;
        for (const group of groups) {
          const names = info[group];
          text += `\n${group} (${names.length}):\n`;
          text += names.map(n => `  - ${n}`).join("\n") + "\n";
        }
        return text;
      },
    )
  );

  server.tool(
    "set_expression",
    "Set one or more facial expression sliders by name (weights 0.0-1.0; e.g. a smile or raised brow). Use get_expression_info first to discover valid slider names. Unknown names are skipped and reported.",
    {
      expressions: z.array(z.object({
        name: z.string().max(128).describe("Expression slider name, e.g. 'Brow_Raise_Inner_L'"),
        weight: z.number().min(0).max(1).describe("Strength 0.0-1.0"),
      })).min(1).max(400).describe("List of expression sliders to set"),
    },
    async ({ expressions }) => bridgeCall(
      () => bridge.setExpression(expressions),
      (result) => {
        if (!result.success) {
          const skipped = result.skipped?.length ? ` (skipped: ${result.skipped.join(", ")})` : "";
          return `Failed: ${result.error}${skipped}`;
        }
        const applied = result.applied ?? [];
        const lines = applied.map(a => `  - ${a.name} = ${a.weight}`);
        const skipped = result.skipped?.length ? `\nSkipped (unknown): ${result.skipped.join(", ")}` : "";
        return `Set ${applied.length} expression slider(s):\n${lines.join("\n")}${skipped}`;
      },
    )
  );

  server.tool(
    "reset_expression",
    "Reset all facial expression sliders to 0 (neutral face). Use after set_expression to clear an expression.",
    {},
    async () => bridgeCall(
      () => bridge.resetExpression(),
      (result) => {
        if (!result.success) return `Failed: ${result.error}`;
        if (result.reset?.length === 0) return "The face was already neutral: no expression slider was set.";
        const reset = result.reset === undefined
          ? `Reset ${result.reset_count ?? 0} expression slider(s) to neutral.`
          : `Reset ${result.reset_count} expression slider(s) to neutral: ${result.reset.join(", ")}` +
            `${(result.reset_count ?? 0) > result.reset.length ? ", ..." : ""}.`;
        // Review #5: every weight it reset, so the expression can be set again (after an OBJ round trip, F-88).
        const again = setExpressionAgainLine(result, "reset_weights");
        return again === undefined ? reset : `${reset}\n${again}`;
      },
    )
  );
}

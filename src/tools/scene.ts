/**
 * Scene and avatar management tools for CC5.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeHttpError, type CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, bridgeErrorResult, errorResult } from "../util.js";
import { formatDialog, formatRecoveryAnswers } from "./dialog.js";

const DIALOG_CHECK_TIMEOUT_MS = 3000;

function validateCapturePath(filePath: string): string | null {
  if (filePath.includes("..")) {
    return "Path traversal ('..') is not allowed";
  }
  const normalized = path.resolve(filePath);
  if (!normalized.toLowerCase().endsWith(".png")) {
    return "Output path must end with .png";
  }
  return null;
}

export function registerSceneTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "list_avatars",
    "List all avatars (characters) currently in the CC5 scene.",
    {},
    async () => bridgeCall(
      () => bridge.getAvatars(),
      (avatars) => avatars.length > 0
        ? `Found ${avatars.length} avatar(s):\n${avatars.map(a => `- ${a.name} (ID: ${a.id})`).join("\n")}`
        : "No avatars in the current scene.",
    )
  );

  server.tool(
    "get_avatar_info",
    "Get detailed information about the current avatar, including all non-zero morph values. Useful for understanding the character's current state.",
    {},
    async () => bridgeCall(
      () => bridge.getAvatarInfo(),
      (info) => {
        if (!info) return "No avatar in the scene.";
        const morphCount = Object.keys(info.active_morphs).length;
        let text = `Avatar: ${info.name}\nActive morphs (${morphCount}):\n`;
        for (const [id, value] of Object.entries(info.active_morphs)) {
          text += `  ${id}: ${value}\n`;
        }
        return text;
      },
    )
  );

  server.tool(
    "check_cc5_connection",
    "Check if CC5 is running and the bridge plugin is active, whether a CC5 dialog is open (while one is, other commands do not run: behind a dialog an MCP command is waiting on, a direct command is cancelled after about 30 s and a job stays queued until the answer; behind any other dialog they fail after about 5 s; the dialog tools still work) or CC5 is busy with a progress window, and whether the plugin answered a crash-recovery prompt at startup.",
    {},
    async () => {
      const down = "CC5 bridge is NOT responding. Make sure Character Creator 5 is running with the MCP Bridge plugin loaded.";
      try {
        const connected = await bridge.healthCheck();
        if (!connected) return errorResult(down);
      } catch {
        return errorResult(down);
      }
      // /health bypasses the command queue, so it says "connected" while a dialog blocks every command (F-23).
      const extra: string[] = [];
      let ready = true;
      try {
        // Short timeout: the dialog lane runs on CC5's main thread, which a long command (an export) can hold.
        const d = await bridge.getDialog(DIALOG_CHECK_TIMEOUT_MS);
        if (d.success && d.dialog) {
          ready = false;
          if (d.dialog.progress) {
            extra.push(formatDialog(d.dialog));
          } else if (d.waiting_job) {
            // The command waits inside its dialog, so nothing else starts: a direct command sits in the queue until
            // the bridge's 30 s limit and is cancelled (F-59); a job stays queued and runs after the answer.
            extra.push("But CC5 has a dialog open that an MCP command is waiting on. Nothing else starts until it is " +
              "answered: a direct command sent now is cancelled after about 30 s; a job (export, import, recipe step) " +
              "stays queued and runs after the answer. get_cc5_dialog and answer_cc5_dialog still work:\n" +
              formatDialog(d.dialog, d.waiting_job));
          } else {
            extra.push("But CC5 has a dialog open. Other commands do not run until it is closed (they fail after about " +
              `5 s):\n${formatDialog(d.dialog)}`);
          }
        }
        const recovery = formatRecoveryAnswers(d);
        if (recovery) extra.push(recovery);
      } catch (err) {
        ready = false;
        // CC5 answered with an error (a rejected token, a plugin without /dialog): say so, it is not "busy".
        extra.push(err instanceof BridgeHttpError
          ? `(Could not check for an open CC5 dialog: ${err.message})`
          : "(Could not check for an open CC5 dialog within 3 s: CC5 is probably busy with a long command. " +
            "Try again when it finishes.)");
      }
      return { content: [{ type: "text" as const,
        text: [`CC5 bridge is connected${ready ? " and ready." : "."}`, ...extra].join("\n") }] };
    }
  );

  server.tool(
    "create_avatar",
    "Create a new NEUTRAL base avatar in the CC5 scene (additive). WARNING: this base has no skin/eye textures, eyebrows, eyelashes or hair — it renders like a pale, blank-eyed mannequin. For a real, textured human face, prefer browse_content('character') + load_asset to load a textured template (e.g. CC4 Camila / CC4 Susan). Use delete_avatar first to replace the current avatar.",
    {},
    async () => bridgeCall(
      () => bridge.createDefaultAvatar(),
      (result) => result.success
        ? `Created neutral avatar '${result.name ?? "Unknown"}' (untextured — see description for a textured base)`
        : `Failed: ${result.error}`,
    )
  );

  server.tool(
    "delete_avatar",
    "Delete an avatar from the scene by name, or ALL avatars if name is omitted. Useful to clear a neutral mannequin before loading a textured character template, or to start the scene over.",
    {
      name: z.string().max(256).optional().describe("Avatar name to delete (from list_avatars). Omit to delete all avatars."),
    },
    async ({ name }) => bridgeCall(
      () => bridge.deleteAvatar(name ?? ""),
      (result) => !result.success ? `Failed: ${result.error}`
        : (result.removed ?? []).length
          ? `Deleted avatar(s): ${(result.removed ?? []).join(", ")}`
          : "The scene has no characters: nothing to delete.",
    )
  );

  server.tool(
    "capture_viewport",
    "Capture a screenshot of the CC5 3D viewport. Returns the image file path. Use this to see the current character appearance.",
    {
      output_path: z.string().optional().describe("Output PNG file path. Omitted: a new file in the temp folder's cc5_captures; only the newest 50 are kept, so older capture paths stop existing."),
      width: z.number().int().min(16).max(7680).optional().describe("Image width in px (default 1280)."),
      height: z.number().int().min(16).max(4320).optional().describe("Image height in px (default 720)."),
    },
    async ({ output_path, width, height }) => {
      if (output_path) {
        const pathError = validateCapturePath(output_path);
        if (pathError) {
          return errorResult(pathError);
        }
      }
      try {
        const result = await bridge.captureViewport(output_path, width, height);
        if (!result.success) {
          return errorResult(`Failed: ${result.error}`);
        }
        // The plugin wrote the render but did not send it (over its 10 MB limit): give the path and its warning.
        // No desktop screenshot here: one used to replace the render (live, F-58). When RenderImage writes nothing,
        // the plugin already falls back to a screenshot of CC5's window.
        if (!result.base64) {
          if (!result.path) return errorResult("CC5 reported a capture but sent neither the image nor its file path.");
          return { content: [{ type: "text" as const,
            text: `Viewport captured: ${result.path}\n${result.warning ?? "The image was not sent back: open the file."}` }] };
        }
        return {
          content: [
            { type: "image" as const, data: result.base64, mimeType: "image/png" },
            { type: "text" as const, text: `Viewport captured: ${result.path ?? "temp file"}` },
          ],
        };
      } catch (err: unknown) {
        return bridgeErrorResult(err);
      }
    }
  );

  server.tool(
    "set_subdivision_level",
    "Set the HD subdivision level for the current avatar. Level 0 = base mesh, 1 = medium detail, 2 = highest detail (HD morphs). Levels 1-2 need the character's HD data, which only CC5 itself makes: the user runs Modify > Subdivide on the character once (scripts cannot). Without it, levels above 0 are refused.",
    {
      level: z.number().int().min(0).max(2).describe("Subdivision level: 0 (base), 1 (medium), 2 (HD)"),
    },
    async ({ level }) => bridgeCall(
      () => bridge.setSubdivisionLevel(level),
      (result) => result.success ? `Subdivision level set to ${level}` : `Failed: ${result.error}`,
    )
  );
}

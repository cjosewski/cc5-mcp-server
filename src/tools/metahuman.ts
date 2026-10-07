/**
 * Mesh-to-MetaHuman pipeline helpers for CC5.
 *
 * Automates the Solomon Jagwe workflow chapters 3-1/3-2/4:
 *  - bake_skin_textures: triggers CC5's own skin bake command if it is enabled, else the manual steps
 *  - export_head_metahuman: File -> Export -> Export Head -> Mesh to MetaHuman
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { BakeSkinResult } from "../types.js";
import { bridgeCall, bridgeErrorResult, errorResult } from "../util.js";
import { pendingResult, runJob } from "../jobs.js";

const ALLOWED_RESOLUTIONS = [256, 512, 1024, 2048, 4096] as const;

// F-84, F-87 (live CC5 5.13): CC5's bake command is "Bake All Skin Textures" (Character menu). It was disabled
// in every state tried (no character, CC4 Kevin, Kevin wearing a SkinGen preset), so nobody has seen it run; Chad: CC5
// enables it once the character has SkinGen layers applied in the Appearance Editor. SkinGen's own menu (About,
// Online Manual, Video Tutorial, Remove SkinGen Data) is never run.
export const BAKE_SKIN_DESCRIPTION =
  "Trigger CC5's own skin bake command if one is enabled (Bake, else Apply Skin, else Skin Editor; CC5 5.13 has " +
  "\"Bake All Skin Textures\" in the Character menu). CC5 has no bake API: the resolution cannot be passed to the " +
  "command and its result is not checked, so check it with captures and get_cc5_dialog. A disabled command is not " +
  "run: the tool names it and returns the manual steps, as it does when CC5 has none.";

type BakeCommand = { text: string; objectName: string };

/** Each command as "text (objectName)", or its text alone when it has no objectName. */
function commandList(commands: BakeCommand[]): string {
  return commands.map((c) => (c.objectName ? `${c.text} (${c.objectName})` : c.text)).join(", ");
}

/**
 * The commands looked at (F-87): the plugin's list, then each command the reply names that the list left out: the
 * disabled ones, and the one CC5 was asked to run, which the plugin names by its text, else its objectName. The
 * plugin now lists every command it can name; an older one listed only skin-related actions, at most 20 (live, it
 * named the disabled Substance bake but did not list it).
 */
function commandsLookedAt(res: BakeSkinResult): BakeCommand[] {
  const looked = [...(res.candidates_inspected ?? [])];
  for (const c of res.disabled_candidates ?? []) {
    if (!looked.some((l) => l.text === c.text && l.objectName === c.objectName)) looked.push(c);
  }
  const ran = res.success ? res.triggered_action : undefined;
  if (ran && !looked.some((l) => l.text === ran || l.objectName === ran)) looked.push({ text: ran, objectName: "" });
  return looked;
}

// F-87: the plugin's own answers when it ran nothing say so: no command qualifies ("..., so nothing was opened"), or
// only disabled ones, which they name ("..., so nothing was run"). Live, the old reply put "No skin bake command
// found:" before the disabled commands' names.
const NOTHING_RAN = /\bso nothing was (run|opened)\b/;

/**
 * bake_skin_textures' reply (F-84, F-87): the command CC5 was asked to run or the panel it opened, or why nothing ran;
 * the check or the manual step; the commands looked at. A bake command (command_kind "bake") bakes rather than opening
 * a panel and has not yet been seen running, so its reply claims no result. The plugin's answer that it ran nothing
 * (no command, or only disabled ones) stands alone; any other failure of the bake (no Qt, a command whose trigger
 * raised) follows "No skin bake command was run:", so no reply says that none was found when one was. A failure that
 * is not the plugin's bake answer (no manual step and no commands looked at, e.g. the open-window guard failed the job
 * before it ran) is shown as CC5 wrote it.
 */
export function bakeSkinReply(res: BakeSkinResult): string {
  const bakeAnswer = res.manual_step_required === true || res.candidates_inspected !== undefined;
  if (!res.success && !bakeAnswer) return res.error ?? "unknown error";
  const error = res.error ?? "unknown error";
  const disabled = res.disabled_candidates ?? [];
  const bake = res.success && res.command_kind === "bake";
  const parts = [res.success
    ? `${bake ? "Asked CC5 to run" : "Opened in CC5"}: ${res.triggered_action ?? "(a command without a name)"}`
    : NOTHING_RAN.test(error) ? error : `No skin bake command was run: ${error}`];
  if (res.instructions) parts.push(bake ? res.instructions : `Manual step: ${res.instructions}`);
  if (res.success && disabled.length) parts.push(`Disabled in CC5 right now, so not run: ${commandList(disabled)}`);
  const looked = commandsLookedAt(res);
  if (looked.length) parts.push(`Commands looked at: ${commandList(looked)}`);
  if (res.notes && res.notes.length) parts.push(`Notes: ${res.notes.join("; ")}`);
  return parts.join("\n");
}

const NULL_BYTE = String.fromCharCode(0);

function validateOutputDir(dir: string): string | null {
  if (dir.includes(NULL_BYTE)) return "Path contains null byte";
  if (dir.includes("..")) return "Path traversal ('..') is not allowed";
  if (!path.isAbsolute(dir)) return "output_dir must be an absolute path";
  return null;
}

function validateCharacterName(name: string): string | null {
  if (!name || !name.trim()) return "character_name must not be empty";
  if (name.length > 128) return "character_name too long (max 128)";
  // Disallow path separators and dangerous chars
  if (/[\\\/:*?"<>|]/.test(name)) {
    return "character_name contains invalid characters";
  }
  return null;
}

export function registerMetaHumanTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "bake_skin_textures",
    BAKE_SKIN_DESCRIPTION,
    {
      resolution: z.union([
        z.literal(256), z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096),
      ]).default(4096).describe("Texture resolution to bake at. 4096 (4K) is recommended for MetaHuman."),
    },
    async ({ resolution }) => {
      // A job, not a direct call: a direct call that fails reaches this server as its error text alone, which would
      // drop the manual steps and the commands looked at (F-84). A window the command opens comes back as its question.
      try {
        const out = await runJob(bridge, "bake_skin_textures", { resolution });
        if (!out.done) return pendingResult(out);
        const res = (typeof out.result === "object" && out.result !== null ? out.result : {}) as BakeSkinResult;
        const failed = out.failed || res.success !== true;
        const text = bakeSkinReply({ ...res, success: !failed });
        return failed ? errorResult(text) : { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return bridgeErrorResult(e);
      }
    },
  );

  server.tool(
    "export_head_metahuman",
    "Trigger CC5's 'File -> Export -> Export Head -> Mesh to MetaHuman' pipeline (Chapter 4). Opens the relevant menu/dialog; user must confirm output path and gender in the resulting CC5 dialog.",
    {
      output_dir: z.string().describe("Absolute directory where the Mesh-to-MetaHuman files will be written (e.g., 'D:/epic/BYONDEgirls57Stage/Content/Characters/CC5/BEYONZ/')"),
      character_name: z.string().describe("Character name (e.g., 'BEYONZ'). Used as the base file name."),
      gender: z.enum(["Male", "Female"]).default("Female").describe("Character gender - selects 'Mesh to MetaHuman Male' or 'Mesh to MetaHuman Female'."),
    },
    async ({ output_dir, character_name, gender }) => {
      const dirError = validateOutputDir(output_dir);
      if (dirError) return errorResult(dirError);
      const nameError = validateCharacterName(character_name);
      if (nameError) return errorResult(nameError);

      return bridgeCall(
        () => bridge.exportHeadMetaHuman(output_dir, character_name, gender),
        (res) => {
          const parts: string[] = [];
          if (res.success) {
            parts.push(`Mesh-to-MetaHuman export initiated for ${character_name} (${gender})`);
            if (res.triggered_action) parts.push(`Triggered: ${res.triggered_action}`);
          } else {
            parts.push(`Export automation failed: ${res.error}`);
          }
          if (res.manual_step_required && res.instructions) {
            parts.push(`Manual step:\n${res.instructions}`);
          }
          if (res.notes && res.notes.length) parts.push(`Notes: ${res.notes.join("; ")}`);
          return parts.join("\n");
        },
      );
    },
  );
}

// Re-export for tests
export const _internal = { ALLOWED_RESOLUTIONS, validateOutputDir, validateCharacterName };

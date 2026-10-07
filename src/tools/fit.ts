/**
 * check_fit, F-44 phase 1: frames and captures only, and detects nothing; fit corrections are deferred to
 * F-44-phase2. Kevin's scalp poked through Hat_DarkBlue and a single capture was read as a logo (F-44), so the
 * character is framed from several views and each view is captured into one folder, with calls verified live:
 * frame_camera(view, character), then capture_viewport. Every image comes back labelled with its view and file path,
 * with a rubric for reading them. At the first view it cannot capture properly the check stops with INCOMPLETE and
 * sends CC5 nothing more (Chad's D1 rule). TypeScript never takes a screenshot itself (F-58).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeHttpError, type CC5Bridge } from "../cc5-bridge.js";
import type { CC5Avatar, CC5Dialog } from "../types.js";
import { bridgeErrorResult, errorResult, progressReporter, warningNotes } from "../util.js";
import { claimScene } from "../scene-lock.js";
import { pngSize } from "../image-info.js";
import { formatDialog } from "./dialog.js";

/** The views check_fit offers: 'face' is a close-up of the head, the others show the whole body. */
export const FIT_VIEWS = ["face", "front", "left", "right", "back"] as const;
export type FitView = typeof FIT_VIEWS[number];

/** The default order. It ends on the whole-body front view, a sensible place to leave the camera. */
export const FIT_DEFAULT_VIEWS: readonly FitView[] = ["face", "left", "right", "back", "front"];

/**
 * The view frame_camera is sent where it differs from check_fit's. 'home' turns to Front first and then fits the whole
 * character: the whole-body front view verified live after the F-45 fix; 'front' alone was not re-checked after that
 * fix. top, bottom, all and focus are not offered: none was verified live after the fix, and 'all' frames the scene,
 * not a character.
 */
export const SENT_VIEW: Partial<Record<FitView, string>> = { front: "home" };

/** capture_viewport's default size. A capture of any other size is the plugin's screenshot fallback, not a render. */
export const RENDER_WIDTH = 1280;
export const RENDER_HEIGHT = 720;

/** Each check captures into <temp>/cc5_fit/check_<13-digit ms timestamp>/; only the newest KEEP_CHECKS are kept. */
export const FIT_FOLDER = "cc5_fit";
export const CHECK_FOLDER = /^check_\d{13}$/;
export const KEEP_CHECKS = 20;

export const RUBRIC = "How to read these images: look for skin or scalp showing through clothing, a hat or hair (a skin-coloured patch on a garment or hat is the body showing through, not a logo or a print), clothing floating off the body, and hair cut off by a hat. Only the face view is a close-up; the other views show the whole body, so a small gap at the side or back of a hat or hair can be too small to see in them: say so when you report on a hat or hair. This check does not detect anything by itself: show the user every view (the image, or its file path where images cannot be shown) and say what you see, view by view.";

export const FIXES = "Fixes available now: remove the item (remove_scene_item), or undo and pick another item, or fix it by hand in CC5. Propose a fix to the user before applying it.";

export const SIDE_EFFECTS = "Side effects: the camera stays on the last view. Every capture undoes its own step in CC5's history, so undo still reaches the last change; a change undone before this check can no longer be redone (re-apply it instead).";

export const FIT_DESCRIPTION = "Check how clothing, shoes, hats and hair sit on a character: frames the character from several views (default face, left, right, back, front) and captures each at 1280x720, returning every image with its file path and a reading rubric. Run it after loading clothing, shoes, accessories or hair and after a pose, and show the user every view: a single capture missed a scalp poking through a hat. It detects nothing by itself and never reports a fit as clean. Only the face view is a close-up; the other views show the whole body. Each capture undoes its own step in CC5's history, so undo still reaches the last change, but a change undone before the check can no longer be redone; the camera stays on the last view. Refused while a recipe or batch runs or while CC5 shows a dialog.";

/** Short: the dialog lane runs on CC5's main thread, which a long command can hold. */
const DIALOG_CHECK_TIMEOUT_MS = 3000;
const NOT_READ = "(not read)";

// util.ts's ToolResult is text-only; check_fit also returns images.
type FitContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type FitResult = { content: FitContent[]; isError?: true };

/**
 * Text blocks that follow each other joined into one, a newline between them: Claude Code shows adjacent text blocks
 * with no separator (F-95). The header goes in with the first view's label, which stays just before its image.
 */
function joinTexts(content: FitContent[]): FitContent[] {
  const joined: FitContent[] = [];
  for (const block of content) {
    const last = joined[joined.length - 1];
    if (block.type === "text" && last?.type === "text") {
      joined[joined.length - 1] = { type: "text", text: `${last.text}\n${block.text}` };
    } else {
      joined.push(block);
    }
  }
  return joined;
}

/**
 * The dialog CC5 has open, read on the dialog lane (which never touches RLPy). A failed read counts as no dialog:
 * the calls that follow it are read-only or fail closed with CC5's own text.
 */
async function openDialog(bridge: CC5Bridge): Promise<{ dialog: CC5Dialog; waitingJob: string | null } | null> {
  try {
    const d = await bridge.getDialog(DIALOG_CHECK_TIMEOUT_MS);
    return d?.success && d.dialog ? { dialog: d.dialog, waitingJob: d.waiting_job ?? null } : null;
  } catch {
    return null;
  }
}

/** The item names a list tool returns, joined; `none` when it returns none; "(not read)" when the read fails. */
async function itemNames(read: () => Promise<Array<{ name: string }>>, none: string): Promise<string> {
  try {
    const items = await read();
    if (!Array.isArray(items)) return NOT_READ;
    return items.length ? items.map((item) => item.name).join(", ") : none;
  } catch {
    return NOT_READ;
  }
}

/**
 * Removes all but the newest KEEP_CHECKS - 1 check folders, before a check adds its own. Only names matching
 * CHECK_FOLDER are touched; their 13-digit timestamps sort by name. Every error is ignored.
 */
function pruneChecks(base: string): void {
  let checks: string[];
  try {
    checks = fs.readdirSync(base).filter((name) => CHECK_FOLDER.test(name)).sort();
  } catch {
    return;
  }
  for (const old of checks.slice(0, Math.max(0, checks.length - (KEEP_CHECKS - 1)))) {
    try {
      fs.rmSync(path.join(base, old), { recursive: true, force: true });
    } catch {
      // Left for a later check (e.g. an image still open in a viewer).
    }
  }
}

export function registerFitTools(server: McpServer, bridge: CC5Bridge): void {
  server.tool(
    "check_fit",
    FIT_DESCRIPTION,
    {
      views: z.array(z.enum(FIT_VIEWS)).min(1).max(5).optional()
        .describe("Views to capture, in this order (default face, left, right, back, front). 'face' is a close-up of the head from the front; 'front' (CC5's Home view, turned to the front), 'left', 'right' and 'back' show the whole body."),
      target: z.string().min(1).max(256).optional()
        .describe("Character to check (a list_avatars name). Needed when the scene has more than one character."),
    },
    async (args, extra): Promise<FitResult> => {
      // A view asked for twice is captured once, where it first appears.
      const views = [...new Set(args.views ?? FIT_DEFAULT_VIEWS)];
      const n = views.length;
      const report = progressReporter(extra);
      const signal = extra?.signal;

      const release = claimScene("check_fit", "a fit check");
      if (typeof release === "string") return errorResult(release);
      try {
        // D1: nothing is sent behind a question nobody has answered. check_fit never answers a dialog itself.
        const open = await openDialog(bridge);
        if (open) {
          const again = open.dialog.progress
            ? "run it again when CC5 has finished (the progress window closes by itself)."
            : "run it again once this dialog is answered or closed.";
          return errorResult(`${formatDialog(open.dialog, open.waitingJob)}\ncheck_fit captured nothing: ${again}`);
        }

        let avatars: unknown;
        try {
          avatars = await bridge.getAvatars();
        } catch (err) {
          return bridgeErrorResult(err);
        }
        const list: CC5Avatar[] = Array.isArray(avatars) ? avatars : [];
        const names = list.map((a) => a.name).join(", ");
        if (!list.length) return errorResult("No avatar in the scene: nothing to check.");
        // CC5 frames a character by its exact name and refuses a name two characters share (_pick_target_avatar),
        // so the character is resolved here, and CC5 always gets the character's own name.
        let chosen: CC5Avatar;
        const target = args.target;
        if (target !== undefined) {
          const exact = list.filter((a) => a.name === target);
          if (exact.length > 1) {
            return errorResult(`More than one character is named ${target}: CC5 frames a character by name, so it ` +
              "cannot tell them apart. Rename or remove one in CC5 first. Nothing was captured.");
          }
          if (exact.length === 1) {
            chosen = exact[0];
          } else {
            const ci = list.filter((a) => a.name.toLowerCase() === target.toLowerCase());
            if (ci.length > 1) {
              return errorResult(`Several characters match ${target} (${ci.map((a) => a.name).join(", ")}): ` +
                "pass the exact name.");
            }
            if (!ci.length) return errorResult(`Avatar not found: ${target}. Characters: ${names}`);
            chosen = ci[0];
          }
        } else if (list.length > 1) {
          return errorResult(`Several characters are in the scene (${names}): pass target.`);
        } else {
          chosen = list[0];
        }
        const name = chosen.name;

        const headerLines = [`Fit check of ${name}: ${n} view${n === 1 ? "" : "s"} (${views.join(", ")}).`];
        // list_clothes, list_hair and list_accessories read only the first character in the scene.
        if (chosen === list[0]) {
          const clothes = await itemNames(() => bridge.listClothes(), "nothing");
          const hair = await itemNames(() => bridge.listHair(), "none");
          const accessories = await itemNames(() => bridge.listAccessories(), "none");
          headerLines.push(`Wearing: ${clothes}; hair: ${hair}; accessories: ${accessories}.`);
        }
        const header = headerLines.join("\n");

        const base = path.join(os.tmpdir(), FIT_FOLDER);
        pruneChecks(base);
        const folder = path.join(base, `check_${Date.now()}`);
        try {
          fs.mkdirSync(folder, { recursive: true });
        } catch {
          // The plugin creates it too; made here as this user, it stays prunable by a later check.
        }

        const footer = [RUBRIC, FIXES, SIDE_EFFECTS].join("\n");
        const entries: FitContent[] = [];
        let taken = 0;
        let previous: string | undefined;
        const incomplete = (i: number, view: FitView, reason: string): FitResult => ({
          isError: true,
          content: joinTexts([
            { type: "text", text: `INCOMPLETE: the fit check of ${name} stopped at view '${view}' (${i}/${n}); ` +
              `${taken > 0 ? "the images taken before it are below" : "no image was taken"}. ` +
              `Do not treat this as a pass.\nWhy: ${reason}` },
            { type: "text", text: header },
            ...entries,
            { type: "text", text: footer },
          ]),
        });

        // At the first view that fails, is blocked or is cancelled, stop: nothing more is sent to CC5 (D1).
        for (const [index, view] of views.entries()) {
          const i = index + 1;
          if (signal?.aborted) return incomplete(i, view, "the check was cancelled");
          report(`view ${i}/${n}: ${view}`);
          const file = path.join(folder, `${i}_${view}.png`);
          try {
            const f = await bridge.frameCamera(SENT_VIEW[view] ?? view, name);
            if (!f?.success) return incomplete(i, view, `frame_camera failed: ${f?.error ?? "no reason given"}`);
            if (f.framed !== name) {
              return incomplete(i, view, `CC5 framed ${f.framed ? `'${f.framed}'` : "no character"} instead of ${name}`);
            }
            const c = await bridge.captureViewport(file, RENDER_WIDTH, RENDER_HEIGHT);
            // F-104: the plugin's WARNING notes on this capture (its undo took back more than the render) go with this
            // view: under its label, or under the reason it stopped at.
            const warnings = warningNotes(c);
            const stopHere = (reason: string) => incomplete(i, view, [reason, ...warnings].join("\n"));
            if (!c?.success) return stopHere(`capture_viewport failed: ${c?.error ?? "no reason given"}`);
            if (!c.base64) {
              return stopHere(
                `CC5 sent no image for this view${c.path ? ` (${c.path}${c.warning ? `: ${c.warning}` : ""})` : ""}`);
            }
            // When RenderImage fails, the plugin copies CC5's window area of the screen (or the whole screen), which
            // can show other windows. Only its size tells it from a render, and it is never returned as an image.
            const size = pngSize(Buffer.from(c.base64, "base64"));
            if (!size) return stopHere(`the '${view}' image is not a PNG render (${c.path ?? file})`);
            if (size.width !== RENDER_WIDTH || size.height !== RENDER_HEIGHT) {
              return stopHere(`the '${view}' image is a screenshot of CC5's window ` +
                `(${size.width}x${size.height}), not a render: RenderImage is not working (it stops after a .ccProject ` +
                "is loaded); restart CC5 or check the fit by hand");
            }
            const same = c.base64 === previous ? " WARNING: identical to the previous view: the camera did not move." : "";
            entries.push(
              { type: "text", text: [`View ${i}/${n}: ${view} (${c.path ?? file})${same}`, ...warnings].join("\n") },
              { type: "image", data: c.base64, mimeType: "image/png" },
            );
            taken += 1;
            previous = c.base64;
          } catch (err) {
            // CC5's own 400/409/504 text (a 409 keeps its job_status id), or "Is CC5 running" when it is unreachable.
            let reason = bridgeErrorResult(err).content[0].text;
            if (err instanceof BridgeHttpError && err.status === 504) {
              // A direct call cancelled behind a command that waits in a dialog does not name that dialog.
              const blocking = await openDialog(bridge);
              if (blocking) reason += `\n${formatDialog(blocking.dialog, blocking.waitingJob)}`;
            }
            return incomplete(i, view, reason);
          }
        }
        return { content: joinTexts([{ type: "text", text: header }, ...entries, { type: "text", text: footer }]) };
      } finally {
        release();
      }
    }
  );
}

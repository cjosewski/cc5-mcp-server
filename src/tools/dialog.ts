/**
 * CC5 dialog tools. CC5 often asks before doing what a command asked: a plain confirmation, or a real choice
 * ("The target object layer already exists ... Replace / Material Only / Cancel"). A direct command that opens
 * one fails within about a second with the dialog's text, buttons and a job id; a job (recipe step, export)
 * reports the same through job_status. These tools read and answer the dialog.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { CC5Dialog, DialogResult } from "../types.js";
import { bridgeCall } from "../util.js";

/** One line per crash-recovery prompt the plugin answered by itself (CC5_RECOVERY_ANSWER), so it is never silent. */
export function formatRecoveryAnswers(r: Pick<DialogResult, "recovery_answered">): string {
  const answers = r.recovery_answered ?? [];
  return answers.map((a) => `When CC5 started, its "Unsaved project data found" prompt was answered ${a.button} ` +
    `automatically (${a.time}, local time): ` +
    (a.button.toLowerCase() === "cancel" ? "the auto-saved changes were discarded." : "the auto-saved changes were restored.")).join("\n");
}

export function formatDialog(dialog: CC5Dialog | null | undefined, waitingJob?: string | null): string {
  if (!dialog) return "No CC5 dialog is open.";
  if (dialog.progress) {
    // A command's own progress window (an export's): cancelling it aborts that command (F-56).
    return `CC5 is busy: progress window "${dialog.title || "(untitled)"}"${dialog.text ? ` (${dialog.text})` : ""}. ` +
      "It closes when the command finishes. Do not cancel it unless the user asks; they cancel it in CC5.";
  }
  const lines = [`CC5 dialog "${dialog.title || "(untitled)"}":`];
  if (dialog.text) lines.push(dialog.text);
  lines.push(`Buttons: ${dialog.buttons.length ? dialog.buttons.join(", ") : "none found"}`);
  lines.push(waitingJob
    ? `Job ${waitingJob} is waiting on this answer; read its result with job_status after answering.`
    // The answering rule covers dialogs an MCP command opened; this one may be the user's own (C2 review).
    : "No MCP command is waiting on this dialog: it may be the user's own, so ask the user before answering it.");
  return lines.join("\n");
}

export function registerDialogTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "get_cc5_dialog",
    "Show the dialog CC5 has open (title, question, buttons), and the job waiting on it if a command opened it, or that CC5 is busy with a command's progress window. Use it when a command reports that CC5 is waiting for an answer, or when commands stall. Also reports a crash-recovery prompt the plugin answered by itself at startup.",
    {},
    async () => bridgeCall(
      () => bridge.getDialog(),
      (r) => r.success
        ? [formatDialog(r.dialog, r.waiting_job), formatRecoveryAnswers(r)].filter(Boolean).join("\n")
        : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "answer_cc5_dialog",
    "Click a button in the dialog CC5 has open, by its label (case ignored). Rules: answer a plain confirmation of exactly what the user asked for yourself (e.g. 'Delete Kevin?' after the user said delete Kevin) and tell them. For a real choice (e.g. Replace vs Material Only, overwrite vs keep) first show the user the question and buttons with your recommendation and let them pick. A dialog no MCP command is waiting on (get_cc5_dialog says so) may be the user's own: ask the user before answering it. A command's progress window (only button Cancel) is refused: cancelling it aborts the command, so only the user does that, in CC5. CC5's \"Unsaved project data found\" crash-recovery prompt: a CC5 started by Claude's launcher (CC5_RECOVERY_ANSWER=cancel) answers it by itself and get_cc5_dialog reports it; only that configured button is accepted here. A CC5 the user started by hand: it is refused, and the user answers it in CC5. After answering, read the waiting command's result with job_status.",
    {
      button: z.string().min(1).max(100).describe("The button's label exactly as get_cc5_dialog lists it, e.g. 'Material Only'"),
      expect: z.string().min(1).max(500).optional()
        .describe("Words from the question you are answering, e.g. 'target object layer already exists'. Refused if the open dialog does not contain them, so the answer cannot land on a different dialog. Recommended."),
    },
    async ({ button, expect }) => bridgeCall(
      () => (expect === undefined ? bridge.answerDialog(button) : bridge.answerDialog(button, expect)),
      (r) => r.success
        ? `Clicked "${r.clicked ?? button}" in CC5's "${r.dialog?.title || "dialog"}".`
        : `Failed: ${r.error}`,
    )
  );
}

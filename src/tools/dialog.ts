/**
 * CC5 dialog tools. CC5 often asks before doing what a command asked: a plain confirmation, or a real choice
 * ("The target object layer already exists ... Replace / Material Only / Cancel"). A direct command that opens
 * one fails within about a second with the dialog's text, buttons and a job id; a job (recipe step, export)
 * reports the same through job_status. These tools read and answer the dialog.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { CC5Dialog } from "../types.js";
import { bridgeCall } from "../util.js";

export function formatDialog(dialog: CC5Dialog | null | undefined, waitingJob?: string | null): string {
  if (!dialog) return "No CC5 dialog is open.";
  const lines = [`CC5 dialog "${dialog.title || "(untitled)"}":`];
  if (dialog.text) lines.push(dialog.text);
  lines.push(`Buttons: ${dialog.buttons.length ? dialog.buttons.join(", ") : "none found"}`);
  if (waitingJob) lines.push(`Job ${waitingJob} is waiting on this answer; read its result with job_status after answering.`);
  return lines.join("\n");
}

export function registerDialogTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "get_cc5_dialog",
    "Show the dialog CC5 has open (title, question, buttons), and the job waiting on it if a command opened it. Use it when a command reports that CC5 is waiting for an answer, or when commands stall.",
    {},
    async () => bridgeCall(
      () => bridge.getDialog(),
      (r) => r.success ? formatDialog(r.dialog, r.waiting_job) : `Failed: ${r.error}`,
    )
  );

  server.tool(
    "answer_cc5_dialog",
    "Click a button in the dialog CC5 has open, by its label (case ignored). Rules: answer a plain confirmation of exactly what the user asked for yourself (e.g. 'Delete Kevin?' after the user said delete Kevin) and tell them. For a real choice (e.g. Replace vs Material Only, overwrite vs keep) first show the user the question and buttons with your recommendation and let them pick. Never answer CC5's \"Unsaved project data found\" prompt: it is refused; the user answers it in CC5. After answering, read the waiting command's result with job_status.",
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

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
import { SKINGEN_QUESTION_RULE } from "../prompts/content-rules.js";

/** One line per crash-recovery prompt the plugin answered by itself (CC5_RECOVERY_ANSWER), so it is never silent. */
export function formatRecoveryAnswers(r: Pick<DialogResult, "recovery_answered">): string {
  const answers = r.recovery_answered ?? [];
  return answers.map((a) => `When CC5 started, its "Unsaved project data found" prompt was answered ${a.button} ` +
    `automatically (${a.time}, local time): ` +
    (a.button.toLowerCase() === "cancel" ? "the auto-saved changes were discarded." : "the auto-saved changes were restored.")).join("\n");
}

/** CC5's crash-recovery question, wherever its words sit (server.py _is_recovery_prompt). */
function isRecoveryPrompt(dialog: CC5Dialog): boolean {
  return `${dialog.title || ""}\n${dialog.text || ""}`.toLowerCase().includes("unsaved project data found");
}

/**
 * F-91: the question CC5 can ask at a content load during the SkinGen session a SkinGen or makeup preset started
 * (SKINGEN_QUESTION; batch F review #13: seen for a prop load).
 */
function isSkinGenQuestion(dialog: CC5Dialog): boolean {
  return (dialog.text || "").replace(/\s+/g, " ").toLowerCase().includes("deactivate the current skingen session");
}

/**
 * A window's name as the queue guard gives it (server.py _modal_dialog_error): its title, else the first line of its
 * text, cut at 120 characters; never its whole text (F-85: SkinGen's About box holds the licence serial).
 */
function windowName(dialog: CC5Dialog): string {
  const firstLine = (dialog.text || "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const name = dialog.title || firstLine;
  return name.length > 120 ? `${name.slice(0, 117)}...` : name;
}

/**
 * What an open window is, checked in this order: a command's progress window; the crash-recovery prompt (always a
 * question); a window whose text could not be read (review #8: it may be that prompt, so it is never one to close,
 * not even untitled); a window with buttons the bridge can read (a question); an untitled window without text (live:
 * CC5's Welcome / What's New page); a window whose buttons the bridge cannot read (F-99: a QML dialog such as CC5's
 * Export FBX); a window with no buttons (F-94: SkinGen's About box).
 */
type WindowKind = "busy" | "question" | "unread" | "welcome" | "unreadable_buttons" | "no_buttons";

function windowKind(dialog: CC5Dialog): WindowKind {
  if (dialog.progress) return "busy";
  if (isRecoveryPrompt(dialog)) return "question";
  if (dialog.text_read === false) return "unread";
  // A job's record is read here too (jobDialogMessage): a malformed one must not stop the wait with an exception.
  if (Array.isArray(dialog.buttons) && dialog.buttons.length && !dialog.buttons_unreadable) return "question";
  if (!windowName(dialog)) return "welcome";
  return dialog.buttons_unreadable ? "unreadable_buttons" : "no_buttons";
}

/**
 * F-94: a window with no buttons that is not a progress window is no question: answer_cc5_dialog has nothing to
 * click, and the user closes it in CC5. As in the queue guard, the crash-recovery prompt stays a question when its
 * buttons could not be read: closing it decides about the user's unsaved work. A window whose text could not be read
 * is never one to close either (review #8: it may be that prompt), and one whose buttons the bridge cannot read is
 * answered or closed in CC5, not only closed (F-99).
 */
export function isWindowToClose(dialog: CC5Dialog): boolean {
  const kind = windowKind(dialog);
  return kind === "welcome" || kind === "no_buttons";
}

/**
 * A window answer_cc5_dialog cannot answer, which the user answers or closes in CC5: one to close (isWindowToClose),
 * one whose buttons the bridge cannot read (F-99) or one whose text could not be read (review #8). Not a progress
 * window (CC5 is busy) nor the crash-recovery prompt (answer_cc5_dialog has its own rules for it).
 */
export function isAnsweredOnlyInCC5(dialog: CC5Dialog): boolean {
  return !["busy", "question"].includes(windowKind(dialog));
}

const WELCOME_PAGE = "CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it in " +
  "Character Creator 5 (tick \"Don't show this again\" so it stays closed).";

export function formatDialog(dialog: CC5Dialog | null | undefined, waitingJob?: string | null): string {
  if (!dialog) return "No CC5 dialog is open.";
  const kind = windowKind(dialog);
  if (kind === "busy") {
    // A command's own progress window (an export's): cancelling it aborts that command (F-56).
    return `CC5 is busy: progress window "${dialog.title || "(untitled)"}"${dialog.text ? ` (${dialog.text})` : ""}. ` +
      "It closes when the command finishes. Do not cancel it unless the user asks; they cancel it in CC5.";
  }
  // The windows below are worded as the queue guard words them (server.py _modal_dialog_error), less its "then try
  // again": the callers add their own next step.
  if (kind === "unread") {
    // Review #8: its words could not be read, so it may be the crash-recovery prompt: answer_cc5_dialog refuses it.
    let question = (dialog.text || dialog.title || "a dialog").split(/\s+/).filter(Boolean).join(" ");
    if (question.length > 300) question = `${question.slice(0, 297)}...`;
    const where = dialog.title && dialog.text ? ` (the "${dialog.title}" window)` : "";
    const lines = [`CC5 is waiting for an answer to "${question}"${where} - its text could not be read, so ask the ` +
      "user to answer it in CC5."];
    if (waitingJob) {
      lines.push(`Job ${waitingJob} is waiting on this answer; read its result with job_status once the user has ` +
        "answered it.");
    }
    return lines.join("\n");
  }
  if (kind !== "question") {
    // Live (F-94), CC5's Welcome / What's New page, untitled and without text, was shown here as a dialog to ask the
    // user about. A QML dialog's buttons are QML items, invisible to the bridge (F-99): the user answers it in CC5.
    const name = windowName(dialog);
    const lines = [kind === "welcome" ? WELCOME_PAGE
      : kind === "unreadable_buttons"
        ? `CC5 has a window open whose buttons this bridge cannot read: "${name}" - answer or close it in Character ` +
          "Creator 5 (no MCP tool can click its buttons)."
        : `CC5 has a window open with no buttons: "${name}" - close it in Character Creator 5 (no MCP tool can close it).`];
    if (waitingJob) {
      lines.push(`Job ${waitingJob} is waiting on this window; read its result with job_status once it is closed.`);
    }
    return lines.join("\n");
  }
  const lines = [`CC5 dialog "${dialog.title || "(untitled)"}":`];
  if (dialog.text) lines.push(dialog.text);
  // F-91: the SkinGen rule says to answer OK for a load the user asked for, so it goes only with a question an MCP
  // command waits in, as withSkinGenRule (src/jobs.ts) adds it to a waiting load's reply. A question no MCP command
  // waits in may come from the user's own load in CC5: that reply says to ask the user (batch F review #12).
  if (waitingJob && isSkinGenQuestion(dialog)) lines.push(SKINGEN_QUESTION_RULE);
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
    "Click a button in the dialog CC5 has open, by its label (case ignored). Rules: answer a plain confirmation of exactly what the user asked for yourself (e.g. 'Delete Kevin?' after the user said delete Kevin) and tell them. For a real choice (e.g. Replace vs Material Only, overwrite vs keep) first show the user the question and buttons with your recommendation and let them pick. " +
    // F-91: the question a content load can ask during a SkinGen session (batch F review #13).
    `${SKINGEN_QUESTION_RULE} ` +
    "A dialog no MCP command is waiting on (get_cc5_dialog says so) may be the user's own: ask the user before answering it. A command's progress window (only button Cancel) is refused: cancelling it aborts the command, so only the user does that, in CC5. CC5's \"Unsaved project data found\" crash-recovery prompt: a CC5 started by Claude's launcher (CC5_RECOVERY_ANSWER=cancel) answers it by itself and get_cc5_dialog reports it; only that configured button is accepted here. A CC5 the user started by hand: it is refused, and the user answers it in CC5. After answering, read the waiting command's result with job_status. When a recipe or batch stopped on the question, go on with the call its report gives; for Replace / Material Only pass the user's button as layer_answer (it then answers that question for the rest of that run only). If the user picked Cancel, go on with continue_after and no layer_answer: a Cancel is not carried, and the next identical question goes to the user again.",
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

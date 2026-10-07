import { describe, it, expect, vi } from "vitest";
import {
  awaitJob, jobDialogMessage, pendingResult, runJob, runJobStep, runJobTool, startJob, withSkinGenRule, JOB_ID_PATTERN,
  STILL_ASKING_NOTE,
} from "../src/jobs.js";
import { BridgeHttpError, BridgeUnreachableError } from "../src/cc5-bridge.js";
import { formatDialog } from "../src/tools/dialog.js";
import { SKINGEN_QUESTION, SKINGEN_QUESTION_RULE } from "../src/prompts/content-rules.js";

function bridgeWith(statuses: Array<Record<string, unknown>>) {
  return {
    startJob: vi.fn().mockResolvedValue({ job_id: "cmd_1" }),
    getJob: vi.fn().mockImplementation(() => Promise.resolve(statuses.shift())),
  };
}

describe("runJob", () => {
  it("returns the result once the job is done", async () => {
    const b = bridgeWith([{ status: "running" }, { status: "done", result: { success: true } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toEqual({ done: true, failed: false, result: { success: true } });
  });

  it("reports failure", async () => {
    const b = bridgeWith([{ status: "failed", result: { success: false, error: "x" } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toMatchObject({ done: true, failed: true });
  });

  it("hands back the job id when it outlasts the wait", async () => {
    const b = { startJob: vi.fn().mockResolvedValue({ job_id: "cmd_7" }), getJob: vi.fn().mockResolvedValue({ status: "running" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 5, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_7" });
  });

  it("stops waiting and passes on the question when the job waits on a CC5 dialog", async () => {
    const message = 'CC5 is waiting for an answer to "Replace?". Buttons: Replace, Cancel. The command is still running as job cmd_1';
    const replace = { title: "", text: "Replace?", buttons: ["Replace", "Cancel"] };
    const b = bridgeWith([{ status: "running" }, { status: "running", dialog: replace, dialog_message: message }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "load_asset", {}, { waitMs: 60_000, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_1", dialog: message, question: replace });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(bridgeWith([{ status: "running", dialog_message: message }]) as any, "load_asset", {}, { waitMs: 1000 }))
      .toEqual({ success: false, error: message, stopped: { job_id: "cmd_1" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = await runJobTool(bridgeWith([{ status: "running", dialog_message: message }]) as any, "save_character", {}, () => "ok");
    expect(tool.isError).toBe(true);
    expect(tool.content[0].text).toBe(message);
  });

  it("keeps polling after a failed status poll instead of losing the job", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_4" }),
      getJob: vi.fn()
        .mockRejectedValueOnce(new BridgeUnreachableError("No reply from CC5 within 35s."))
        .mockResolvedValueOnce({ status: "done", result: { success: true, fbx: "a.fbx" } }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toEqual({ done: true, failed: false, result: { success: true, fbx: "a.fbx" } });
    expect(b.getJob).toHaveBeenCalledTimes(2);
  });

  it("returns the job id when every poll fails until the wait runs out", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_5" }),
      getJob: vi.fn().mockRejectedValue(new BridgeUnreachableError("fetch failed (read ECONNRESET)")),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 20, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_ab12cd34_5" });
  });

  it("says the job was lost when CC5 no longer knows it (404)", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_6" }),
      getJob: vi.fn().mockRejectedValue(new BridgeHttpError("Unknown job: cmd_ab12cd34_6", 404)),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 }))
      .rejects.toThrow("Job cmd_ab12cd34_6 not found. CC5 was probably restarted");
    expect(b.getJob).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when already cancelled, and stops waiting (keeping the id) when cancelled later", async () => {
    const idle = { startJob: vi.fn(), getJob: vi.fn() };
    const cancelled = new AbortController();
    cancelled.abort();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runJob(idle as any, "a", {}, { signal: cancelled.signal })).rejects.toBeDefined();
    expect(idle.startJob).not.toHaveBeenCalled();

    const ac = new AbortController();
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_8" }),
      getJob: vi.fn().mockImplementation(async () => { ac.abort(); return { status: "running" }; }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 60_000, pollMs: 60_000, signal: ac.signal });
    expect(out).toEqual({ done: false, job_id: "cmd_ab12cd34_8" });
    expect(b.getJob).toHaveBeenCalledTimes(1);
  });
});

const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["Replace", "Material Only", "Cancel"],
};
const ASKING = 'CC5 is waiting for an answer to "The target object layer already exists. ..." Buttons: Replace, Material Only, Cancel.';
const APPLY = { title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] };

describe("awaitJob", () => {
  it("waits for a job already started, and passes on the job a queued job waits behind", async () => {
    const blocked = 'Job cmd_9 has not started: it is queued behind job cmd_8. CC5 is waiting for an answer to "Replace?".';
    const b = {
      startJob: vi.fn(),
      getJob: vi.fn().mockResolvedValue({ job_id: "cmd_9", status: "queued", blocked_by: "cmd_8", dialog: LAYER, dialog_message: blocked }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await awaitJob(b as any, "cmd_9", { waitMs: 1000, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_9", dialog: blocked, question: LAYER, blocked_by: "cmd_8" });
    expect(b.startJob).not.toHaveBeenCalled();
    expect(b.getJob).toHaveBeenCalledWith("cmd_9");
  });

  it("goes on after onDialog answered the question, and says which button finished the job", async () => {
    const b = bridgeWith([
      { status: "running", dialog: LAYER, dialog_message: ASKING },
      { status: "done", result: { success: true, path: "C:/e/Eyes.ccEye" } },
    ]);
    const onDialog = vi.fn().mockResolvedValue({ kind: "answered", button: "Material Only" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await awaitJob(b as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog });
    expect(out).toEqual({ done: true, failed: false, result: { success: true, path: "C:/e/Eyes.ccEye" }, answered: "Material Only" });
    expect(onDialog).toHaveBeenCalledTimes(1);
    expect(onDialog.mock.calls[0][0]).toMatchObject({ dialog: LAYER, dialog_message: ASKING });
  });

  it("keeps polling when onDialog waits, and appends a stop's note to the question", async () => {
    const b = bridgeWith([
      { status: "running", dialog: LAYER, dialog_message: ASKING },
      { status: "running", dialog: LAYER, dialog_message: ASKING },
    ]);
    const onDialog = vi.fn()
      .mockResolvedValueOnce({ kind: "wait" })
      .mockResolvedValueOnce({ kind: "stop", note: "this run's answer could not be clicked" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await awaitJob(b as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog });
    expect(out).toEqual({ done: false, job_id: "cmd_1", dialog: `${ASKING} (this run's answer could not be clicked)`, question: LAYER });
    expect(b.getJob).toHaveBeenCalledTimes(2);
  });

  it("stops at the question when onDialog throws", async () => {
    const b = bridgeWith([{ status: "running", dialog: LAYER, dialog_message: ASKING }]);
    const onDialog = vi.fn().mockRejectedValue(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await awaitJob(b as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog });
    expect(out).toEqual({ done: false, job_id: "cmd_1", dialog: ASKING, question: LAYER });
  });

  // F-98: CC5 reports a command done after its question was answered Cancel; the job status lists the clicks.
  it("passes on the buttons answer_cc5_dialog clicked while the job waited, and nothing when it lists none", async () => {
    const answers = [{ button: "Cancel", title: "Character Creator 5" }];
    const b = bridgeWith([
      { status: "running", dialog: LAYER, dialog_message: ASKING },
      { status: "done", result: { success: true }, answers },
    ]);
    const onDialog = vi.fn().mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(b as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog }))
      .toEqual({ done: true, failed: false, result: { success: true }, answers });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(bridgeWith([{ status: "failed", result: { success: false }, answers }]) as any, "cmd_1",
      { waitMs: 1000, pollMs: 1 })).toEqual({ done: true, failed: true, result: { success: false }, answers });
    for (const none of [[], undefined, "Cancel"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await awaitJob(bridgeWith([{ status: "done", result: { success: true }, answers: none }]) as any, "cmd_1",
        { waitMs: 1000, pollMs: 1 })).toEqual({ done: true, failed: false, result: { success: true } });
    }
  });

  it("carries the button on a job that failed after the answer", async () => {
    const b = bridgeWith([
      { status: "running", dialog: LAYER, dialog_message: ASKING },
      { status: "failed", result: { success: false, error: "LoadFile failed" } },
    ]);
    const onDialog = vi.fn().mockResolvedValue({ kind: "answered", button: "Replace" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(b as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog }))
      .toEqual({ done: true, failed: true, result: { success: false, error: "LoadFile failed" }, answered: "Replace" });
  });

  // RB-1 (D1): a wait that ran out while CC5 still asked used to come back as plain "still running", and a run went on.
  it("hands a question CC5 still reports when the wait runs out back as a stop, not as 'still running'", async () => {
    const b = { getJob: vi.fn().mockResolvedValue({ job_id: "cmd_1", status: "running", dialog: LAYER, dialog_message: ASKING }) };
    const onDialog = vi.fn().mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await awaitJob(b as any, "cmd_1", { waitMs: 20, pollMs: 1, onDialog });
    expect(out).toEqual({ done: false, job_id: "cmd_1", dialog: `${ASKING} (${STILL_ASKING_NOTE})`, question: LAYER });
    expect(onDialog).toHaveBeenCalled();
    expect(STILL_ASKING_NOTE).toBe("CC5 still reported this question when the wait ended; it may be a newer window");
  });

  it("keeps the last question through polls that fail, and stops on it when the wait runs out", async () => {
    const b = {
      getJob: vi.fn()
        .mockResolvedValueOnce({ status: "running", dialog: LAYER, dialog_message: ASKING })
        .mockRejectedValue(new BridgeUnreachableError("fetch failed (read ECONNRESET)")),
    };
    const onDialog = vi.fn().mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(b as any, "cmd_1", { waitMs: 20, pollMs: 1, onDialog }))
      .toEqual({ done: false, job_id: "cmd_1", dialog: `${ASKING} (${STILL_ASKING_NOTE})`, question: LAYER });
    expect(onDialog).toHaveBeenCalledTimes(1);
  });

  it("does not stop when the question was gone at the last poll, or when the client cancelled the wait", async () => {
    const gone = {
      getJob: vi.fn()
        .mockResolvedValueOnce({ status: "running", dialog: LAYER, dialog_message: ASKING })
        .mockResolvedValue({ status: "running" }),
    };
    const clicked = vi.fn().mockResolvedValue({ kind: "answered", button: "Replace" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(gone as any, "cmd_1", { waitMs: 200, pollMs: 1, onDialog: clicked }))
      .toEqual({ done: false, job_id: "cmd_1", answered: "Replace" });
    expect(gone.getJob.mock.calls.length).toBeGreaterThan(1);

    const ac = new AbortController();
    const cancelled = {
      getJob: vi.fn().mockImplementation(async () => {
        ac.abort();
        return { status: "running", dialog: LAYER, dialog_message: ASKING };
      }),
    };
    const waits = vi.fn().mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(cancelled as any, "cmd_1", { waitMs: 60_000, pollMs: 60_000, signal: ac.signal, onDialog: waits }))
      .toEqual({ done: false, job_id: "cmd_1" });
  });

  // RB-3: the button the wait clicked was dropped when the same job then stopped on another question.
  it("names the button it clicked in this job when it stops, unless the stop's note names it already", async () => {
    const apply = 'CC5 is waiting for an answer to "Apply the preset?". Buttons: OK, Cancel.';
    const b = bridgeWith([
      { status: "running", dialog: LAYER, dialog_message: ASKING },
      { status: "running", dialog: APPLY, dialog_message: apply },
    ]);
    const onDialog = vi.fn().mockResolvedValueOnce({ kind: "answered", button: "Replace" }).mockResolvedValueOnce({ kind: "stop" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(b as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog })).toEqual({
      done: false, job_id: "cmd_1", question: APPLY, answered: "Replace",
      dialog: `${apply} (this run already answered 'Replace / Material Only' in this job with 'Replace')`,
    });

    const late = { getJob: vi.fn().mockResolvedValue({ status: "running", dialog: LAYER, dialog_message: ASKING }) };
    const thenWaits = vi.fn().mockResolvedValueOnce({ kind: "answered", button: "Material Only" }).mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(late as any, "cmd_1", { waitMs: 20, pollMs: 1, onDialog: thenWaits })).toEqual({
      done: false, job_id: "cmd_1", question: LAYER, answered: "Material Only",
      dialog: `${ASKING} (${STILL_ASKING_NOTE}; this run already answered 'Replace / Material Only' in this job with 'Material Only')`,
    });

    const again = { getJob: vi.fn().mockResolvedValue({ status: "running", dialog: LAYER, dialog_message: ASKING }) };
    const note = "this run already answered it 3 times with 'Replace'; CC5 is asking again or did not take that click";
    const repeated = vi.fn().mockResolvedValueOnce({ kind: "answered", button: "Replace" }).mockResolvedValueOnce({ kind: "stop", note });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(again as any, "cmd_1", { waitMs: 1000, pollMs: 1, onDialog: repeated }))
      .toEqual({ done: false, job_id: "cmd_1", question: LAYER, answered: "Replace", dialog: `${ASKING} (${note})` });
  });
});

/** SkinGen's About box (F-85, F-94): no buttons; its labels hold the licence serial, which the plugin redacts. */
const ABOUT = { title: "CCSkinGen", text: "SkinGen 2.0\nS/N : (serial)\nCopyright Reallusion", buttons: [] };
/** A plugin older than batch F (server.py _waiting_dialog_error) words every window as a question for answer_cc5_dialog. */
const oldWaiting = (question: string, title: string, buttons: string, id: string) =>
  `CC5 is waiting for an answer to "${question}"${title ? ` (the "${title}" window)` : ""}. Buttons: ${buttons}. The ` +
  `command is still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a real choice), ` +
  `then check its result with job_status("${id}").`;
const ABOUT_WAITING = oldWaiting("SkinGen 2.0 S/N : (serial) Copyright Reallusion", "CCSkinGen", "none found", "cmd_1");
/** SkinGen's About box as a batch F plugin words a command waiting in it. */
const ABOUT_WAITING_F = 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP ' +
  'tool can close it). The command is still running as job cmd_1: read its result with job_status("cmd_1") once it ' +
  "is closed.";

// Review #3, #7, #19 (F-94): a job waiting in a window with no buttons was told to "answer it with answer_cc5_dialog",
// which has nothing to click there, while get_cc5_dialog for the same window said to close it in CC5.
describe("a job waiting in a window no MCP tool can answer (review #3, #7, #19)", () => {
  it("load_asset and the other job tools word SkinGen's About box as a window to close in CC5", async () => {
    const b = bridgeWith([{ status: "running", dialog: ABOUT, dialog_message: ABOUT_WAITING }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = await runJobTool(b as any, "bake_skin_textures", {}, () => "ok");
    expect(tool.isError).toBe(true);
    expect(tool.content[0].text).toBe('CC5 has a window open with no buttons: "CCSkinGen" - close it in Character ' +
      "Creator 5 (no MCP tool can close it).\nJob cmd_1 is waiting on this window; read its result with job_status " +
      "once it is closed.");
    expect(tool.content[0].text).not.toContain("answer_cc5_dialog");
    expect(tool.content[0].text).not.toContain("S/N");
  });

  it("a recipe or batch step stops with that wording and the window as its question", async () => {
    const b = bridgeWith([{ status: "running", dialog: ABOUT, dialog_message: ABOUT_WAITING }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const step = await runJobStep(b as any, "load_asset", {}, { waitMs: 1000, pollMs: 1 });
    expect(step).toEqual({ success: false, error: formatDialog(ABOUT, "cmd_1"), stopped: { job_id: "cmd_1", question: ABOUT } });
    expect(pendingResult({ job_id: "cmd_1", dialog: step.error })).toEqual({ isError: true,
      content: [{ type: "text", text: formatDialog(ABOUT, "cmd_1") }] });
  });

  it("keeps the note of a wait that ran out after the window's wording", async () => {
    const b = { getJob: vi.fn().mockResolvedValue({ job_id: "cmd_1", status: "running", dialog: ABOUT, dialog_message: ABOUT_WAITING }) };
    const onDialog = vi.fn().mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(b as any, "cmd_1", { waitMs: 20, pollMs: 1, onDialog })).toEqual({
      done: false, job_id: "cmd_1", dialog: `${formatDialog(ABOUT, "cmd_1")} (${STILL_ASKING_NOTE})`, question: ABOUT });
  });

  it("keeps a batch F plugin's own wording of that window", async () => {
    const b = bridgeWith([{ status: "running", dialog: ABOUT, dialog_message: ABOUT_WAITING_F }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJob(b as any, "load_asset", {}, { waitMs: 1000, pollMs: 1 }))
      .toEqual({ done: false, job_id: "cmd_1", dialog: ABOUT_WAITING_F, question: ABOUT });
  });

  it("words a window whose buttons the bridge cannot read (F-99) and one whose text it could not read (review #8)", () => {
    const qml = { title: "Export FBX", text: "", buttons: [], buttons_unreadable: true };
    const qmlText = jobDialogMessage("cmd_1", { dialog: qml, dialog_message: oldWaiting("Export FBX", "", "none found", "cmd_1") });
    expect(qmlText).toBe(formatDialog(qml, "cmd_1"));
    expect(qmlText).toContain("answer or close it in Character Creator 5 (no MCP tool can click its buttons)");
    const unread = { title: "Character Creator 5", text: "", buttons: ["OK", "Cancel"], text_read: false };
    const unreadText = jobDialogMessage("cmd_1",
      { dialog: unread, dialog_message: oldWaiting("Character Creator 5", "", "OK, Cancel", "cmd_1") });
    expect(unreadText).toBe(formatDialog(unread, "cmd_1"));
    expect(unreadText).toContain("its text could not be read, so ask the user to answer it in CC5");
  });

  it("keeps the plugin's text for a question, the crash-recovery prompt, and without a dialog", () => {
    expect(jobDialogMessage("cmd_1", { dialog: LAYER, dialog_message: ASKING })).toBe(ASKING);
    const layerWaiting = oldWaiting("The target object layer already exists.", "Character Creator 5",
      "Replace, Material Only, Cancel", "cmd_1");
    expect(jobDialogMessage("cmd_1", { dialog: LAYER, dialog_message: layerWaiting })).toBe(layerWaiting);
    // Closing the recovery prompt decides about the user's unsaved work: it stays a question without readable buttons.
    const recovery = { title: "Character Creator 5", text: "Unsaved project data found.", buttons: [] };
    const recoveryWaiting = oldWaiting("Unsaved project data found.", "Character Creator 5", "none found", "cmd_1");
    expect(jobDialogMessage("cmd_1", { dialog: recovery, dialog_message: recoveryWaiting })).toBe(recoveryWaiting);
    expect(jobDialogMessage("cmd_1", { dialog_message: ABOUT_WAITING })).toBe(ABOUT_WAITING);
    expect(jobDialogMessage("cmd_1", { dialog: ABOUT })).toBeUndefined();
  });

  it("says a job queued behind such a window runs once that window has closed", async () => {
    const blocked = "Job cmd_9 has not started: it is queued behind job cmd_8. " +
      oldWaiting("SkinGen 2.0 S/N : (serial) Copyright Reallusion", "CCSkinGen", "none found", "cmd_8") +
      ' Job cmd_9 runs after that answer; read its result with job_status("cmd_9").';
    const b = { getJob: vi.fn().mockResolvedValue({ job_id: "cmd_9", status: "queued", blocked_by: "cmd_8", dialog: ABOUT, dialog_message: blocked }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await awaitJob(b as any, "cmd_9", { waitMs: 1000, pollMs: 1 })).toEqual({
      done: false, job_id: "cmd_9", question: ABOUT, blocked_by: "cmd_8",
      dialog: "Job cmd_9 has not started: it is queued behind job cmd_8, which waits in this window:\nCC5 has a window " +
        'open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool can close it).\nJob cmd_9 ' +
        'runs once that window has closed; read its result with job_status("cmd_9").',
    });
  });
});

/** CC5 5.13's question at a content load during a SkinGen session (F-91, live: OK and Cancel). */
const SKINGEN = { title: "Character Creator 5", text: SKINGEN_QUESTION, buttons: ["OK", "Cancel"], text_read: true };
/** The plugin's text for a command waiting in that question (server.py _waiting_dialog_error). */
const skinGenWaiting = (id: string) => `CC5 is waiting for an answer to "${SKINGEN_QUESTION}" (the "Character ` +
  `Creator 5" window). Buttons: OK, Cancel. The command is still running as job ${id}: answer it with ` +
  `answer_cc5_dialog (ask the user when it is a real choice), then check its result with job_status("${id}").`;

// F-91 (live 2026-10-07): a content load during a SkinGen session asked this. get_cc5_dialog's reply gave the rule (a
// plain confirmation for a load the user asked for: answer OK and say so); load_asset's reply for the job did not.
describe("a job waiting in CC5's question before a content load ends a SkinGen session (F-91)", () => {
  it("load_asset and the other job tools give the rule on its own line after the question", async () => {
    const b = bridgeWith([{ status: "running", dialog: SKINGEN, dialog_message: skinGenWaiting("cmd_1") }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = await runJobTool(b as any, "load_asset", {}, () => "ok");
    expect(tool.isError).toBe(true);
    expect(tool.content[0].text).toBe(`${skinGenWaiting("cmd_1")}\n${SKINGEN_QUESTION_RULE}`);
  });

  it("finds the question in the dialog's title or text (case and line breaks ignored) or in the waiting text alone", () => {
    const plain = "CC5 is waiting for an answer. The command is still running as job cmd_1.";
    const split = { ...SKINGEN, text: "Applying this content will DEACTIVATE the current\nSkinGen  session.\nWould you like to continue?" };
    expect(pendingResult({ job_id: "cmd_1", dialog: plain, question: split }).content[0].text)
      .toBe(`${plain}\n${SKINGEN_QUESTION_RULE}`);
    const titled = { title: SKINGEN_QUESTION, text: "", buttons: ["OK", "Cancel"] };
    expect(pendingResult({ job_id: "cmd_1", dialog: plain, question: titled }).content[0].text)
      .toBe(`${plain}\n${SKINGEN_QUESTION_RULE}`);
    expect(pendingResult({ job_id: "cmd_1", dialog: skinGenWaiting("cmd_1") }))
      .toEqual({ isError: true, content: [{ type: "text", text: `${skinGenWaiting("cmd_1")}\n${SKINGEN_QUESTION_RULE}` }] });
  });

  it("adds nothing to another question, to a window the user answers in CC5, or a second time", () => {
    expect(pendingResult({ job_id: "cmd_1", dialog: ASKING, question: LAYER }).content[0].text).toBe(ASKING);
    // F-99: a window whose buttons the bridge cannot read is answered or closed in CC5: no MCP tool can click its OK.
    const qml = { ...SKINGEN, buttons: [], buttons_unreadable: true };
    const qmlWaiting = 'CC5 has a window open whose buttons this bridge cannot read: "Character Creator 5" - answer or ' +
      "close it in Character Creator 5 (no MCP tool can click its buttons). The command is still running as job cmd_1: " +
      'read its result with job_status("cmd_1") once it is closed.';
    expect(withSkinGenRule(qmlWaiting, qml)).toBe(qmlWaiting);
    const once = withSkinGenRule(skinGenWaiting("cmd_1"), SKINGEN);
    expect(withSkinGenRule(once, SKINGEN)).toBe(once);
    expect(once.split(SKINGEN_QUESTION_RULE)).toHaveLength(2);
    // The job's record is JSON from the plugin: a waiting text that is no text comes back as it was, never an exception.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(withSkinGenRule(42 as any, SKINGEN)).toBe(42);
  });

  it("leaves a recipe's or batch's WAIT text as the plugin wrote it", async () => {
    const b = bridgeWith([{ status: "running", dialog: SKINGEN, dialog_message: skinGenWaiting("cmd_1") }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(b as any, "load_asset", {}, { waitMs: 1000, pollMs: 1 }))
      .toEqual({ success: false, error: skinGenWaiting("cmd_1"), stopped: { job_id: "cmd_1", question: SKINGEN } });
  });
});

describe("startJob", () => {
  it("rejects without calling the bridge when already cancelled, and returns the job id otherwise", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const b = { startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_1" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(startJob(b as any, "load_asset", {}, cancelled.signal)).rejects.toBe(cancelled.signal.reason);
    expect(b.startJob).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await startJob(b as any, "load_asset", { file_path: "C:/a.ccEye" })).toBe("cmd_ab12cd34_1");
    expect(b.startJob).toHaveBeenCalledWith("load_asset", { file_path: "C:/a.ccEye" });
  });
});

describe("runJobStep", () => {
  it("keeps the job's own result fields and says which button it answered", async () => {
    const b = bridgeWith([
      { status: "running", dialog: LAYER, dialog_message: ASKING },
      { status: "done", result: { success: true, path: "C:/e/Eyes.ccEye", target: "Kevin", changes: { complete: true }, notes: ["x"] } },
    ]);
    const onDialog = vi.fn().mockResolvedValue({ kind: "answered", button: "Material Only" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(b as any, "load_asset", {}, { waitMs: 1000, pollMs: 1, onDialog })).toEqual({
      success: true, path: "C:/e/Eyes.ccEye", target: "Kevin", changes: { complete: true }, notes: ["x"], answered: "Material Only" });
  });

  it("stops with the job, the question and the job it is queued behind", async () => {
    const b = bridgeWith([{ status: "queued", blocked_by: "cmd_0", dialog: LAYER, dialog_message: ASKING }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(b as any, "load_asset", {}, { waitMs: 1000, pollMs: 1 }))
      .toEqual({ success: false, error: ASKING, stopped: { job_id: "cmd_1", question: LAYER, blocked_by: "cmd_0" } });
  });

  it("stops a step whose wait ran out while CC5 still asked, with the button the run clicked (RB-1, RB-3)", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_1" }),
      getJob: vi.fn().mockResolvedValue({ status: "running", dialog: LAYER, dialog_message: ASKING }),
    };
    const onDialog = vi.fn().mockResolvedValueOnce({ kind: "answered", button: "Replace" }).mockResolvedValue({ kind: "wait" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(b as any, "load_asset", {}, { waitMs: 20, pollMs: 1, onDialog })).toEqual({
      success: false,
      error: `${ASKING} (${STILL_ASKING_NOTE}; this run already answered 'Replace / Material Only' in this job with 'Replace')`,
      stopped: { job_id: "cmd_1", question: LAYER, answered: "Replace" },
    });
  });

  it("keeps the button the run clicked on a step still running when the client cancelled the wait (RB-3)", async () => {
    const ac = new AbortController();
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_1" }),
      getJob: vi.fn()
        .mockResolvedValueOnce({ status: "running", dialog: LAYER, dialog_message: ASKING })
        .mockImplementation(async () => {
          ac.abort();
          return { status: "running" };
        }),
    };
    const onDialog = vi.fn().mockResolvedValue({ kind: "answered", button: "Material Only" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(b as any, "load_asset", {}, { waitMs: 60_000, pollMs: 1, signal: ac.signal, onDialog }))
      .toEqual({ success: false, error: "still running in CC5 as job cmd_1 (check it with job_status)", answered: "Material Only" });
  });

  it("keeps the buttons answer_cc5_dialog clicked while a finished job waited (F-98), also on a failed one", async () => {
    const answers = [{ button: "Cancel", title: "Character Creator 5" }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(bridgeWith([{ status: "done", result: { success: true, path: "C:/e/Eyes.ccEye" }, answers }]) as any,
      "load_asset", {}, { pollMs: 1 })).toEqual({ success: true, path: "C:/e/Eyes.ccEye", answers });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(bridgeWith([{ status: "failed", result: { success: false, error: "x" }, answers }]) as any,
      "load_asset", {}, { pollMs: 1 })).toEqual({ success: false, error: "x", answers });
  });

  it("reports a failed job with its error, or 'failed' without one", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(bridgeWith([{ status: "failed", result: { success: false, error: "File not found" } }]) as any, "a", {}, { pollMs: 1 }))
      .toEqual({ success: false, error: "File not found" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await runJobStep(bridgeWith([{ status: "failed" }]) as any, "a", {}, { pollMs: 1 }))
      .toEqual({ success: false, error: "failed" });
  });
});

describe("JOB_ID_PATTERN", () => {
  it("accepts ids with the bridge's per-start nonce and older plain ids", () => {
    expect(JOB_ID_PATTERN.test("cmd_0f3a9b2c_12")).toBe(true);
    expect(JOB_ID_PATTERN.test("cmd_12")).toBe(true);
    expect(JOB_ID_PATTERN.test("cmd_xyz_12")).toBe(false);
    expect(JOB_ID_PATTERN.test("cmd_0f3a9b2c_12\n")).toBe(false);
  });
});

/**
 * D1/D3 run state (src/build-session.ts): which CC5 texts mean "blocked by a window", which question is CC5's
 * "Replace / Material Only", stop ids, and carrying the user's answer through one run.
 */

import fs from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BridgeHttpError, BridgeTimeoutError } from "../src/cc5-bridge.js";
import { formatDialog } from "../src/tools/dialog.js";
import {
  answerLayerQuestion, carryLayerAnswer, checkDialog, currentStop, dialogStopFromError, findStop, finishBuild,
  isBlockedByDialog, isLayerQuestion, isLayerWaitingText, isNotStartedTimeout, jobIdFromWaitingText, layerDialogHandler,
  openDialog, recordStop, startBuild, DIALOG_CHECK_MS, LAYER_ANSWERS, LAYER_EXPECT, MAX_LAYER_CLICKS_PER_JOB,
  STOP_ID_PATTERN,
} from "../src/build-session.js";

const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["&Replace", "Material Only", "Cancel"],
};
const APPLY = { title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] };

/** server.py _waiting_dialog_error for LAYER (the 409 text and a job's dialog_message). */
const waiting = (id: string) => 'CC5 is waiting for an answer to "The target object layer already exists. Do you want ' +
  'to replace the object, or the material only?" (the "Character Creator 5" window). Buttons: Replace, Material Only, ' +
  `Cancel. The command is still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a ` +
  `real choice), then check its result with job_status("${id}").`;
/** server.py _modal_dialog_error: a question, the Welcome page, a progress window. */
const GUARD = 'CC5 is waiting for an answer to "Replace?" - no MCP command is waiting on it, so it is probably the ' +
  "user's own or CC5's: ask the user to answer or close it in CC5, then try again.";
const WELCOME = "CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it in Character " +
  "Creator 5 (tick \"Don't show this again\" so it stays closed), then try again.";
const BUSY = 'CC5 is busy with "Exporting" (the progress window of a command it is running) - try again when it ' +
  "closes. Do not cancel it unless the user asks; they cancel it in CC5.";
/** server.py _modal_dialog_error for a window with no buttons (SkinGen's About box, F-85). */
const NO_BUTTONS = 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool ' +
  "can close it), then try again.";
const NOT_STARTED = "CC5 timed out (cancelled): Timed out before CC5 started the command; it was cancelled and will not run.";

beforeEach(() => {
  finishBuild(startBuild("recipe"));
});

describe("texts that mean CC5 had a window open", () => {
  it("isBlockedByDialog knows the guard, Welcome, busy, no-buttons and 409 texts, and nothing else", () => {
    for (const text of [GUARD, WELCOME, BUSY, NO_BUTTONS, waiting("cmd_ab12cd34_3")]) {
      expect(isBlockedByDialog(text)).toBe(true);
    }
    for (const text of ["No avatar in scene", undefined, "", NOT_STARTED]) expect(isBlockedByDialog(text)).toBe(false);
  });

  it("matches the texts server.py sends", () => {
    const server = fs.readFileSync(new URL("../cc5-plugin/server.py", import.meta.url), "utf-8");
    for (const text of ['CC5 is waiting for an answer to "', "CC5's Welcome / What's New page", 'CC5 is busy with "',
      'CC5 has a window open with no buttons: "', 'job_status("{job_id}")', "Timed out before CC5 started the command"]) {
      expect(server).toContain(text);
    }
  });

  it("jobIdFromWaitingText reads the job a 409 text names", () => {
    expect(jobIdFromWaitingText(waiting("cmd_ab12cd34_3"))).toBe("cmd_ab12cd34_3");
    expect(jobIdFromWaitingText(waiting("cmd_12"))).toBe("cmd_12");
    expect(jobIdFromWaitingText(GUARD)).toBeUndefined();
  });

  it("isNotStartedTimeout is only the bridge's 504 for a command that never started", () => {
    expect(isNotStartedTimeout(new BridgeHttpError(NOT_STARTED, 504))).toBe(true);
    expect(isNotStartedTimeout(new BridgeHttpError("CC5 timed out (still running): CC5 is still working on this command.", 504))).toBe(false);
    expect(isNotStartedTimeout(new BridgeHttpError(NOT_STARTED, 400))).toBe(false);
    expect(isNotStartedTimeout(new Error(NOT_STARTED))).toBe(false);
  });
});

describe("CC5's Replace / Material Only question", () => {
  it("isLayerQuestion is that question with exactly its three buttons", () => {
    expect(isLayerQuestion(LAYER)).toBe(true);
    expect(isLayerQuestion({ ...LAYER, buttons: ["Replace", "Material Only", "Cancel"] })).toBe(true);
    expect(isLayerQuestion({ ...LAYER, buttons: ["Yes", "No"] })).toBe(false);
    expect(isLayerQuestion({ ...LAYER, buttons: ["Replace", "Material Only"] })).toBe(false);
    expect(isLayerQuestion({ ...LAYER, buttons: [...LAYER.buttons, "Help"] })).toBe(false);
    expect(isLayerQuestion({ ...LAYER, progress: true })).toBe(false);
    expect(isLayerQuestion({ title: "", text: "Overwrite the file?", buttons: ["Replace", "Material Only", "Cancel"] })).toBe(false);
    expect(isLayerQuestion(null)).toBe(false);
    expect(isLayerQuestion(undefined)).toBe(false);
  });

  it("isLayerWaitingText reads it from a 409 text", () => {
    expect(isLayerWaitingText(waiting("cmd_ab12cd34_3"))).toBe(true);
    expect(isLayerWaitingText(GUARD)).toBe(false);
    expect(isLayerWaitingText('CC5 is waiting for an answer to "The target object layer already exists." Buttons: OK, Cancel.')).toBe(false);
  });

  it("only Replace and Material Only can be carried", () => {
    expect([...LAYER_ANSWERS]).toEqual(["Replace", "Material Only"]);
    expect(LAYER_EXPECT).toBe("target object layer already exists");
  });
});

describe("openDialog", () => {
  it("is null when the check fails or nothing (or only the allowed job's question) is open", async () => {
    const b = { getDialog: vi.fn() };
    b.getDialog.mockRejectedValueOnce(new Error("fetch failed"));
    b.getDialog.mockResolvedValueOnce(undefined);
    b.getDialog.mockResolvedValueOnce({ success: true, dialog: null, waiting_job: null });
    b.getDialog.mockResolvedValueOnce({ success: false, error: "No CC5" });
    b.getDialog.mockResolvedValueOnce({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = b as any;
    expect(await openDialog(bridge)).toBeNull();
    expect(await openDialog(bridge)).toBeNull();
    expect(await openDialog(bridge)).toBeNull();
    expect(await openDialog(bridge)).toBeNull();
    expect(await openDialog(bridge, { allowJob: "cmd_ab12cd34_1" })).toBeNull();
    expect(b.getDialog).toHaveBeenCalledWith(DIALOG_CHECK_MS);
  });

  it("returns the open dialog, also when it is another job's", async () => {
    const open = { success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_1" };
    const b = { getDialog: vi.fn().mockResolvedValue(open) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await openDialog(b as any)).toBe(open);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await openDialog(b as any, { allowJob: "cmd_ab12cd34_2" })).toBe(open);
  });
});

describe("checkDialog (RB-1)", () => {
  it("tells a check that failed apart from no dialog, and returns the open dialog", async () => {
    const open = { success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_1" };
    const b = { getDialog: vi.fn() };
    b.getDialog.mockRejectedValueOnce(new BridgeTimeoutError("No reply from CC5 within 3s."));
    b.getDialog.mockResolvedValueOnce(undefined);
    b.getDialog.mockResolvedValueOnce({ success: false, error: "No CC5" });
    b.getDialog.mockResolvedValueOnce({ success: true, dialog: null, waiting_job: null });
    b.getDialog.mockResolvedValueOnce(open);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = b as any;
    expect(await checkDialog(bridge)).toBe("unknown");
    expect(await checkDialog(bridge)).toBe("unknown");
    expect(await checkDialog(bridge)).toBe("unknown");
    expect(await checkDialog(bridge)).toBeNull();
    expect(await checkDialog(bridge)).toBe(open);
    expect(b.getDialog).toHaveBeenCalledWith(DIALOG_CHECK_MS);
  });
});

describe("dialogStopFromError", () => {
  const bridgeWith = (job?: unknown, dialog?: unknown) => ({
    getJob: vi.fn().mockResolvedValue(job),
    getDialog: vi.fn().mockResolvedValue(dialog),
  });

  it("409: CC5 runs the command as a job and waits on its question", async () => {
    const b = bridgeWith({ job_id: "cmd_ab12cd34_9", action: "set_skin_color", status: "running", dialog: LAYER });
    const text = waiting("cmd_ab12cd34_9");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await dialogStopFromError(b as any, new BridgeHttpError(text, 409)))
      .toEqual({ ran: true, jobId: "cmd_ab12cd34_9", question: LAYER, text });
    expect(b.getJob).toHaveBeenCalledTimes(1);
    expect(b.getJob).toHaveBeenCalledWith("cmd_ab12cd34_9");
  });

  it("409: a job that cannot be read leaves the question out; a text without a job id reads no job", async () => {
    const b = bridgeWith();
    b.getJob.mockRejectedValue(new Error("fetch failed"));
    const text = waiting("cmd_ab12cd34_9");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await dialogStopFromError(b as any, new BridgeHttpError(text, 409))).toEqual({ ran: true, jobId: "cmd_ab12cd34_9", text });
    expect(b.getJob).toHaveBeenCalledTimes(1);
    const c = bridgeWith();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await dialogStopFromError(c as any, new BridgeHttpError("CC5 is waiting for an answer to \"x\".", 409)))
      .toEqual({ ran: true, text: "CC5 is waiting for an answer to \"x\"." });
    expect(c.getJob).not.toHaveBeenCalled();
  });

  it("400 with the guard's text: the command never ran", async () => {
    const b = bridgeWith();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await dialogStopFromError(b as any, new BridgeHttpError(GUARD, 400))).toEqual({ ran: false, text: GUARD });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await dialogStopFromError(b as any, new BridgeHttpError("No avatar in scene", 400))).toBeNull();
    expect(b.getJob).not.toHaveBeenCalled();
    expect(b.getDialog).not.toHaveBeenCalled();
  });

  it("504 'never started' is a stop only while a window is open, and that window is not the step's own question", async () => {
    const open = bridgeWith(undefined, { success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_2" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = await dialogStopFromError(open as any, new BridgeHttpError(NOT_STARTED, 504));
    expect(info).toEqual({ ran: false, text: `${NOT_STARTED}\n${formatDialog(LAYER, "cmd_ab12cd34_2")}` });
    expect(info?.text).toContain("CC5 dialog");
    expect(info).not.toHaveProperty("question");
    expect(open.getDialog).toHaveBeenCalledWith(DIALOG_CHECK_MS);
    const none = bridgeWith(undefined, { success: true, dialog: null, waiting_job: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await dialogStopFromError(none as any, new BridgeHttpError(NOT_STARTED, 504))).toBeNull();
  });

  it("anything else is not a dialog stop", async () => {
    const b = bridgeWith();
    for (const err of [new Error("boom"), new BridgeHttpError("boom", 500), "boom", undefined]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await dialogStopFromError(b as any, err)).toBeNull();
    }
  });
});

describe("stops", () => {
  it("startBuild forgets an earlier stop and keeps it as replaced", () => {
    const first = startBuild("recipe");
    const s1 = recordStop(first, { step: "skin_rgb", ran: false, text: GUARD, waitMs: 120_000 });
    expect(s1).toMatchObject({ kind: "recipe", step: "skin_rgb", ran: false, layer: false });
    expect(STOP_ID_PATTERN.test(s1.id)).toBe(true);
    expect(findStop("recipe", s1.id)).toEqual({ build: first, stop: s1 });
    expect(findStop("batch", s1.id)).toBeUndefined();
    expect(currentStop()).toBe(s1);

    const second = startBuild("batch");
    expect(second.replaced).toBe(s1);
    expect(findStop("recipe", s1.id)).toBeUndefined();
    expect(currentStop()).toBeUndefined();
    finishBuild(first);  // not the current run: changes nothing
    const s2 = recordStop(second, { step: "export", ran: false, text: GUARD, waitMs: 300_000 });
    expect(currentStop()).toBe(s2);
    finishBuild(second);
    expect(currentStop()).toBeUndefined();
  });

  it("ids are the job id, else stop_<n>, and stop_<n> never repeats across runs", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = startBuild(i % 2 ? "batch" : "recipe");
      ids.push(recordStop(b, { step: "skin_rgb", ran: false, text: GUARD, waitMs: 1 }).id);
    }
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^stop_\d+$/);
    const b = startBuild("recipe");
    expect(recordStop(b, { step: "asset Eyes.ccEye", ran: true, jobId: "cmd_ab12cd34_9", text: GUARD, waitMs: 1 }).id)
      .toBe("cmd_ab12cd34_9");
    expect(STOP_ID_PATTERN.test("cmd_ab12cd34_9")).toBe(true);
    expect(STOP_ID_PATTERN.test("stop_x")).toBe(false);
  });

  it("is a layer stop only for the stopped command's own Replace / Material Only question", () => {
    const b = startBuild("recipe");
    const stop = (s: Parameters<typeof recordStop>[1]) => recordStop(b, s).layer;
    expect(stop({ step: "a", ran: true, jobId: "cmd_1", question: LAYER, text: waiting("cmd_1"), waitMs: 1 })).toBe(true);
    // The job could not be read after a 409: its text says which question it is.
    expect(stop({ step: "a", ran: true, jobId: "cmd_2", text: waiting("cmd_2"), waitMs: 1 })).toBe(true);
    // Queued behind another job's question, or blocked from outside (no job): not the user's layer question.
    expect(stop({ step: "a", ran: true, jobId: "cmd_3", question: LAYER, blockedBy: "cmd_2", text: waiting("cmd_2"), waitMs: 1 })).toBe(false);
    expect(stop({ step: "a", ran: false, question: LAYER, text: waiting("cmd_2"), waitMs: 1 })).toBe(false);
    expect(stop({ step: "a", ran: true, jobId: "cmd_4", question: APPLY, text: "Apply?", waitMs: 1 })).toBe(false);
  });

  it("is no fresh layer choice in a job the run already answered, and keeps the button it clicked (RB-3)", () => {
    const b = startBuild("recipe");
    const s = recordStop(b, { step: "asset Eyes_02.ccEye", ran: true, jobId: "cmd_5", question: LAYER, text: waiting("cmd_5"),
      waitMs: 1, answered: "Replace" });
    expect(s).toMatchObject({ id: "cmd_5", layer: false, answered: "Replace" });
    expect(findStop("recipe", "cmd_5")?.stop.answered).toBe("Replace");
  });
});

describe("carryLayerAnswer (D3)", () => {
  it("takes the user's button for the rest of the run, refusing Cancel, a second button and another question", () => {
    const build = startBuild("recipe");
    const layerStop = recordStop(build, {
      step: "asset Eyes_02.ccEye", ran: true, jobId: "cmd_ab12cd34_5", question: LAYER, text: waiting("cmd_ab12cd34_5"), waitMs: 1 });
    expect(carryLayerAnswer(build, layerStop, "Cancel")).toBe(
      "layer_answer must be 'Replace' or 'Material Only' (a Cancel is not carried to later questions). Nothing was sent to CC5.");
    expect(build.layerAnswer).toBeUndefined();
    expect(carryLayerAnswer(build, layerStop, "material only")).toBeNull();
    expect(build.layerAnswer).toBe("Material Only");
    expect(carryLayerAnswer(build, layerStop, "Material Only")).toBeNull();
    expect(carryLayerAnswer(build, layerStop, "Replace")).toBe("This run already answers 'Replace / Material Only' " +
      "with 'Material Only' (the user's first answer); it does not change within the run. Nothing was sent to CC5.");
    expect(build.layerAnswer).toBe("Material Only");

    const other = startBuild("recipe");
    const applyStop = recordStop(other, { step: "skin_rgb", ran: true, jobId: "cmd_ab12cd34_6", question: APPLY, text: "Apply?", waitMs: 1 });
    expect(carryLayerAnswer(other, applyStop, "Replace")).toBe("layer_answer answers only CC5's 'Replace / Material " +
      "Only' question, and this run stopped on a different one. Go on without layer_answer. Nothing was sent to CC5.");
    expect(other.layerAnswer).toBeUndefined();
  });
});

describe("answerLayerQuestion", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    job_id: "cmd_ab12cd34_7", action: "load_asset", status: "running" as const, dialog: LAYER,
    dialog_message: waiting("cmd_ab12cd34_7"), ...over,
  });

  it("clicks the run's answer in the Replace / Material Only question, expecting its words", async () => {
    const b = { answerDialog: vi.fn().mockResolvedValue({ success: true, clicked: "Material Only" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await answerLayerQuestion(b as any, job(), "Material Only")).toBe("Material Only");
    expect(b.answerDialog).toHaveBeenCalledWith("Material Only", LAYER_EXPECT);
    b.answerDialog.mockResolvedValueOnce({ success: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await answerLayerQuestion(b as any, job(), "Replace")).toBe("Replace");  // '&Replace' is that button
  });

  it("skips a queued job, another question, no answer and an answer that is not a button", async () => {
    const b = { answerDialog: vi.fn().mockResolvedValue({ success: true, clicked: "Replace" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = b as any;
    expect(await answerLayerQuestion(bridge, job({ blocked_by: "cmd_ab12cd34_6" }), "Replace")).toBeNull();
    expect(await answerLayerQuestion(bridge, job({ dialog: APPLY }), "Replace")).toBeNull();
    expect(await answerLayerQuestion(bridge, job(), undefined)).toBeNull();
    expect(await answerLayerQuestion(bridge, job(), "Keep Both")).toBeNull();
    expect(b.answerDialog).not.toHaveBeenCalled();
  });

  it("is null when CC5 refuses the click or cannot be reached", async () => {
    const b = { answerDialog: vi.fn() };
    b.answerDialog.mockResolvedValueOnce({ success: false, error: "No CC5 dialog is open" });
    b.answerDialog.mockRejectedValueOnce(new Error("fetch failed"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await answerLayerQuestion(b as any, job(), "Replace")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await answerLayerQuestion(b as any, job(), "Replace")).toBeNull();
  });
});

describe("layerDialogHandler", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    job_id: "cmd_ab12cd34_7", action: "load_asset", status: "running" as const, dialog: LAYER,
    dialog_message: waiting("cmd_ab12cd34_7"), ...over,
  });
  const answered = { kind: "answered", button: "Material Only" };
  const notClicked = { kind: "stop", note: "this run's answer 'Material Only' could not be clicked; answer it in CC5 or with answer_cc5_dialog" };
  let b: { answerDialog: ReturnType<typeof vi.fn>; getDialog: ReturnType<typeof vi.fn> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = () => layerDialogHandler(b as any, "Material Only")!;

  beforeEach(() => {
    b = { answerDialog: vi.fn().mockResolvedValue({ success: true, clicked: "Material Only" }), getDialog: vi.fn() };
  });

  it("is not there without an answer", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(layerDialogHandler(b as any, undefined)).toBeUndefined();
  });

  it("answers the question with the run's answer, and stops on any other question or a queued job", async () => {
    const h = handler();
    expect(await h(job())).toEqual(answered);
    expect(b.answerDialog).toHaveBeenCalledWith("Material Only", LAYER_EXPECT);
    expect(await h(job({ job_id: "cmd_ab12cd34_8", dialog: APPLY }))).toEqual({ kind: "stop" });
    expect(await h(job({ job_id: "cmd_ab12cd34_9", blocked_by: "cmd_ab12cd34_7" }))).toEqual({ kind: "stop" });
    expect(b.answerDialog).toHaveBeenCalledTimes(1);
  });

  it("waits while the job's record still shows the question it answered", async () => {
    const h = handler();
    expect(await h(job())).toEqual(answered);
    b.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    expect(await h(job())).toEqual({ kind: "wait" });
    b.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_1" });  // another job's
    expect(await h(job())).toEqual({ kind: "wait" });
    expect(b.answerDialog).toHaveBeenCalledTimes(1);
  });

  it(`clicks a live repeat on the same job up to ${MAX_LAYER_CLICKS_PER_JOB} times, then stops`, async () => {
    const h = handler();
    b.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_7" });
    expect(await h(job())).toEqual(answered);
    expect(await h(job())).toEqual(answered);
    expect(await h(job())).toEqual(answered);
    expect(await h(job())).toEqual({ kind: "stop", note: "this run already answered it 3 times with 'Material Only'; " +
      "CC5 is asking again or did not take that click" });
    expect(b.answerDialog).toHaveBeenCalledTimes(3);
    expect(await h(job({ job_id: "cmd_ab12cd34_8" }))).toEqual(answered);  // each job has its own count
  });

  it("waits when a failed first click finds the question gone, and stops when it is still open", async () => {
    const h = handler();
    b.answerDialog.mockResolvedValue({ success: false, error: "No CC5 dialog is open" });
    b.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    expect(await h(job())).toEqual({ kind: "wait" });
    b.answerDialog.mockRejectedValue(new Error("fetch failed"));
    b.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_7" });
    expect(await h(job())).toEqual(notClicked);
  });

  it("stops when a repeat click is refused", async () => {
    const h = handler();
    expect(await h(job())).toEqual(answered);
    b.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_7" });
    b.answerDialog.mockResolvedValue({ success: false, error: "refused" });
    expect(await h(job())).toEqual(notClicked);
  });

  // RB-1: a click that opened another window blocks CC5's dialog lane, so the click and the check both fail.
  it("stops when a failed first click cannot be checked either: CC5 did not answer the dialog check", async () => {
    const h = handler();
    b.answerDialog.mockRejectedValue(new BridgeHttpError("CC5 timed out (still running): CC5 is still working on this command.", 504));
    b.getDialog.mockRejectedValue(new BridgeTimeoutError("No reply from CC5 within 3s."));
    expect(await h(job())).toEqual({ kind: "stop", note: "this run's answer 'Material Only' may not have been clicked, and " +
      "CC5 did not answer a check for open dialogs; look at CC5 (get_cc5_dialog) before going on" });
    b.getDialog.mockResolvedValueOnce({ success: false, error: "No CC5" });
    expect((await h(job())).kind).toBe("stop");  // a reply that is no dialog check is no answer either
    // A check that answers and shows no such question still waits.
    b.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    expect(await h(job())).toEqual({ kind: "wait" });
  });

  it("waits when a check fails after a click that worked: CC5 may be finishing the load", async () => {
    const h = handler();
    expect(await h(job())).toEqual(answered);
    b.getDialog.mockRejectedValue(new BridgeTimeoutError("No reply from CC5 within 3s."));
    expect(await h(job())).toEqual({ kind: "wait" });
    expect(b.answerDialog).toHaveBeenCalledTimes(1);
  });
});

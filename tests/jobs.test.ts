import { describe, it, expect, vi } from "vitest";
import { awaitJob, runJob, runJobStep, runJobTool, startJob, JOB_ID_PATTERN, STILL_ASKING_NOTE } from "../src/jobs.js";
import { BridgeHttpError, BridgeUnreachableError } from "../src/cc5-bridge.js";

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
    const b = bridgeWith([{ status: "running" }, { status: "running", dialog: { title: "", text: "Replace?", buttons: [] }, dialog_message: message }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "load_asset", {}, { waitMs: 60_000, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_1", dialog: message, question: { title: "", text: "Replace?", buttons: [] } });
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

import { describe, it, expect, beforeEach } from "vitest";
import { registerJobTools } from "../../src/tools/jobs.js";
import { BridgeHttpError, BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE } from "../../src/tools/unity.js";
import { SKINGEN_QUESTION, SKINGEN_QUESTION_RULE } from "../../src/prompts/content-rules.js";
import { CANCELLED_CHANGED, CANCELLED_NOTHING, CANCELLED_UNSURE } from "../../src/recipe.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerJobTools(server as any, bridge as any);
});

describe("job_status", () => {
  it("reports a running job", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "running" });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("Still running");
  });

  it("shows the question a running job waits on", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "load_asset", status: "running",
      dialog_message: 'CC5 is waiting for an answer to "Replace?". Buttons: Replace, Cancel.' });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Buttons: Replace, Cancel");
  });

  it("returns the finished result as JSON", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "x", status: "done", result: { success: true, fbx: "a.fbx" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("a.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("flags a failed job as an error", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "failed", result: { success: false, error: "disk full" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("disk full");
  });

  it("flags a finished export that ran without some of its settings", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["WARNING: SetOption2 failed, flags2 NOT applied: x"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\)/);
  });

  it("labels an import with warnings without making it an error (repeating it would import twice)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "import_fbx", status: "done",
      result: { success: true, notes: ["WARNING: 1 clothing mesh(es) did not import: Hood"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished with warnings \(import_fbx\)/);
  });

  it("says the job was lost in a CC5 restart when the bridge no longer knows it", async () => {
    bridge.getJob.mockRejectedValue(new BridgeHttpError("Unknown job: cmd_0f3a9b2c_12", 404));
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_0f3a9b2c_12" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      "Job cmd_0f3a9b2c_12 not found. CC5 was probably restarted and the job's result is lost. Check the output folder, then run the operation again.");
  });

  it("asks whether CC5 is running when it cannot be reached", async () => {
    bridge.getJob.mockRejectedValue(new BridgeUnreachableError("fetch failed"));
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_0f3a9b2c_12" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Is CC5 running");
  });

  // X-2: CC5's timeline left at one frame after the export is no export setting CC5 failed to apply.
  it("does not make an export an error for a timeline CC5 could not set back, and says so on its own line", async () => {
    const timeline = `${TIMELINE_NOT_RESTORED_PREFIX}CC5's timeline was set to one frame for this export and could not be set back (x)`;
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: [timeline] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\):\n/);
    expect(r.content[0].text.split("\n").at(-1)).toBe(TIMELINE_USABLE_LINE);
    expect(TIMELINE_USABLE_LINE).toBe("The FBX is usable; CC5's timeline was left at one frame: set its length in " +
      "Character Creator 5.");

    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_textures", status: "done",
      result: { success: true, notes: [timeline, "WARNING: SetTextureSize failed: x"] } });
    const both = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(both.isError).toBe(true);
    expect(both.content[0].text.split("\n").at(-1)).toBe(TIMELINE_LEFT_LINE);

    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["target_tool=Unity preset applied"] } });
    const plain = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(plain.content[0].text).not.toContain("timeline");
  });

  it("flags an export_for_unity that did not carry the injuries (WP-3 relies on this)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["WARNING: injuries not carried: Std_Skin_Arm: the bake failed"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\):\n/);
    expect(r.content[0].text).toContain("injuries not carried");
  });
});

// F-34: a load that waited on a CC5 question finishes here, so job_status shows load_asset's own reply.
describe("job_status for a finished load_asset", () => {
  const PANTS = "C:/c/US_Army_Uniform_Pants.ccCloth";
  const changes = (facts: unknown[]) => ({ complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 300,
    compared: { worn: 2, morphs: 10, materials: 30 }, skipped: 0, truncated: false, facts });
  const PANTS_ADDED = { kind: "worn_added", group: "clothing", id: "13", name: "Pants" };
  const BOXERS_REMOVED = { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" };

  it("shows the change report, labelled with warnings when it has CHECK lines (not an error)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "done",
      result: { success: true, path: PANTS, target: "Kevin", changes: changes([PANTS_ADDED, BOXERS_REMOVED]) } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe([
      "Finished with warnings (load_asset):",
      `Asset loaded: ${PANTS} (applied to Kevin)`,
      "Compared before and after: 2 worn items, 10 shaping morphs, 30 materials (0.3 s).",
      "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item",
      "Applied: added Pants (clothing)",
      "NOT CHECKED: how it sits on the character (skin or scalp showing through, floating items): run check_fit",
    ].join("\n"));
  });

  it("says Finished when nothing needs checking", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "done",
      result: { success: true, path: PANTS, target: "Kevin", changes: changes([PANTS_ADDED]) } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished \(load_asset\):\nAsset loaded: /);
    expect(r.content[0].text).not.toContain("CHECK ");
  });

  it("reports a failed load as an error", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "failed",
      result: { success: false, error: "File not found: C:/x.ccCloth" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Failed (load_asset):\nFailed to load asset: File not found: C:/x.ccCloth");
  });

  // F-92 precaution (cc5_api.load_asset): a .ccProject load clears CC5's selection first and its note names what was
  // selected; scene content has no change report, so the note was never shown.
  it("shows the plugin's notes on a scene-content load, also after a failure", async () => {
    const PROJECT = "C:/p/Scene.ccProject";
    const cleared = "CC5's selection (Pants) was cleared before the project load: a project replaces the scene, and " +
      "deleting a character while one of its worn items is selected can crash CC5 (F-92).";
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "done",
      result: { success: true, path: PROJECT, notes: [cleared] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Finished (load_asset):\nAsset loaded: ${PROJECT}\n${cleared}`);
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "failed",
      result: { success: false, error: "LoadFile failed", notes: [cleared] } });
    const failed = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(`Failed (load_asset):\nFailed to load asset: LoadFile failed\n${cleared}`);
  });

  it("describes the change report", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "job_status")?.[1] as string;
    expect(description).toContain("(export, load, batch step)");
    expect(description).toContain("a finished load_asset also shows what the load changed (CHECK and NOT CHECKED lines)");
    expect(description.length).toBeLessThan(2000);
  });
});

// F-98 (batch F review #8, #28): CC5 reports a command done after answer_cc5_dialog clicked Cancel in its question (live:
// the user's Cancel in an eye preset's Replace / Material Only applied nothing, and the recipe said OK). job_status read
// only the result: such a load read "Finished (load_asset): Asset loaded: ... (applied to Kevin)", a SkinGen preset's
// still claimed a SkinGen session, and an export answered Cancel read "Finished (export_for_unity)".
describe("job_status for a job whose CC5 question was answered Cancel (F-98)", () => {
  const CANCEL = [{ button: "Cancel", title: "Character Creator 5" }];
  const HAZEL = "C:/Templates/Eye/_Hazel1 Eyes.ccEye";
  const CORDIAL = "C:/Templates/Makeup/Full Makeup/Cordial.ccSkinGenPreset";
  const changes = (facts: unknown[], over: Record<string, unknown> = {}) => ({ complete: true, target: "Kevin",
    target_is_first: true, elapsed_ms: 300, compared: { worn: 2, morphs: 10, materials: 30 }, skipped: 0,
    truncated: false, facts, ...over });
  const COMPARED = "Compared before and after: 2 worn items, 10 shaping morphs, 30 materials (0.3 s).";
  const LOOK = "NOT CHECKED: what CC5 shows but cannot report (hair, brows or clothing hidden in the viewport, makeup " +
    "or skin layers): capture the face (frame_camera face) and the whole body (home) and compare them with captures " +
    "from before the load";
  /** A load_asset job that finished after answer_cc5_dialog clicked `answers` in its question. */
  const loadJob = (result: unknown, answers: unknown = CANCEL, status = "done") =>
    bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "load_asset", status, result, answers });
  const jobStatus = (job_id = "cmd_5") => server.getRegisteredTool("job_status")({ job_id });

  it("says a load answered Cancel was cancelled in CC5 and applied nothing, never that it loaded", async () => {
    loadJob({ success: true, path: HAZEL, target: "Kevin", changes: changes([]) });
    const r = await jobStatus();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(["Cancelled in CC5 (load_asset):",
      `Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_NOTHING})`, COMPARED, LOOK].join("\n"));
    expect(r.content[0].text).not.toContain("Asset loaded");
  });

  it("says what CC5 still changed, and that CC5 may not have done it when the comparison did not run", async () => {
    const cornea = { kind: "material", mesh: "CC_Base_Eye", material: "Std_Cornea_R", field: "opacity", before: 1, after: 0.8 };
    loadJob({ success: true, path: HAZEL, target: "Kevin", changes: changes([cornea]) });
    expect((await jobStatus()).content[0].text).toBe(["Cancelled in CC5 (load_asset):",
      `Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_CHANGED})`, COMPARED,
      "Applied: opacity on CC_Base_Eye/Std_Cornea_R: 0.8", LOOK].join("\n"));
    const off = "WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared";
    loadJob({ success: true, path: HAZEL, target: "Kevin", changes: changes([], { complete: false }), notes: [off] });
    const unsure = await jobStatus();
    expect(unsure.isError).toBe(true);
    expect(unsure.content[0].text).toBe(["Cancelled in CC5 (load_asset):",
      `Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_UNSURE})`, `NOT CHECKED: ${off}`, LOOK].join("\n"));
  });

  it("leaves out a SkinGen preset's session NOTE, and names a load that also failed as cancelled", async () => {
    loadJob({ success: true, path: CORDIAL, target: "Kevin", changes: changes([]) });
    const r = await jobStatus();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(["Cancelled in CC5 (load_asset):",
      `Asset load cancelled: ${CORDIAL} for Kevin (${CANCELLED_NOTHING})`, COMPARED, LOOK].join("\n"));
    expect(r.content[0].text).not.toContain("SkinGen session");
    loadJob({ success: false, error: "LoadFile failed", path: HAZEL, target: "Kevin", changes: changes([]) }, CANCEL, "failed");
    const failed = await jobStatus();
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text.split("\n").slice(0, 2)).toEqual(["Cancelled in CC5 (load_asset):",
      `Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_NOTHING}; LoadFile failed)`]);
  });

  it("says an export answered Cancel may not have written the FBX as asked: check it before using it", async () => {
    const result = { success: true, fbx: "D:/Unity/Assets/Patients/A/A.fbx" };
    bridge.getJob.mockResolvedValue({ job_id: "cmd_6", action: "export_for_unity", status: "done", result, answers: CANCEL });
    const r = await jobStatus("cmd_6");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Cancelled in CC5 (export_for_unity):\n${JSON.stringify(result, null, 2)}\n` +
      "CC5's question (the \"Character Creator 5\" window) was answered 'Cancel', so CC5 may not have written the FBX " +
      "as asked: check it before using it.");
    // X-2: the FBX is called usable only when nothing else went wrong, so never beside a Cancel. A window without a
    // title is not named.
    const timeline = `${TIMELINE_NOT_RESTORED_PREFIX}CC5's timeline was set to one frame for this export and could not ` +
      "be set back (x)";
    bridge.getJob.mockResolvedValue({ job_id: "cmd_6", action: "export_textures", status: "done",
      result: { success: true, notes: [timeline] }, answers: [{ button: "Cancel", title: "" }] });
    const lines = (await jobStatus("cmd_6")).content[0].text.split("\n");
    expect(lines[0]).toBe("Cancelled in CC5 (export_textures):");
    expect(lines.slice(-2)).toEqual(["CC5's question was answered 'Cancel', so CC5 may not have written the FBX as " +
      "asked: check it before using it.", TIMELINE_LEFT_LINE]);
  });

  it("says another job answered Cancel may not have done what was asked, naming the Cancel's own window", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_7", action: "apply_pose", status: "done", result: { success: true },
      answers: [{ button: "OK", title: "Pose" }, { button: "Cancel", title: "Character Creator 5" }] });
    const r = await jobStatus("cmd_7");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Cancelled in CC5 (apply_pose):\n${JSON.stringify({ success: true }, null, 2)}\n` +
      "CC5's question (the \"Character Creator 5\" window) was answered 'Cancel', so CC5 may not have done what was asked.");
  });

  it("keeps the replies of jobs whose answers hold no Cancel", async () => {
    loadJob({ success: true, path: HAZEL, target: "Kevin", changes: changes([]) },
      [{ button: "Replace", title: "Character Creator 5" }]);
    const loaded = await jobStatus();
    expect(loaded.isError).toBeUndefined();
    expect(loaded.content[0].text).toBe(["Finished (load_asset):", `Asset loaded: ${HAZEL} (applied to Kevin)`, COMPARED,
      LOOK].join("\n"));
    bridge.getJob.mockResolvedValue({ job_id: "cmd_6", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx" }, answers: [{ button: "OK", title: "Character Creator 5" }] });
    const exported = await jobStatus("cmd_6");
    expect(exported.isError).toBeUndefined();
    expect(exported.content[0].text)
      .toBe(`Finished (export_for_unity):\n${JSON.stringify({ success: true, fbx: "a.fbx" }, null, 2)}`);
  });
});

// Reviews #3, #7, #19 (F-94): job_status showed a plugin's "answer it with answer_cc5_dialog" for a window that tool
// cannot answer, while load_asset's reply for the same job already said to close it in CC5 (jobDialogMessage).
describe("job_status for a job waiting in a window no MCP tool can answer", () => {
  /** SkinGen's About box (F-85, F-94): no buttons; its labels hold the licence serial, which the plugin redacts. */
  const ABOUT = { title: "CCSkinGen", text: "SkinGen 2.0\nS/N : (serial)\nCopyright Reallusion", buttons: [] };
  /** A plugin older than batch F words every window as a question for answer_cc5_dialog. */
  const oldWaiting = (id: string) => 'CC5 is waiting for an answer to "SkinGen 2.0 S/N : (serial) Copyright ' +
    `Reallusion" (the "CCSkinGen" window). Buttons: none found. The command is still running as job ${id}: answer it ` +
    `with answer_cc5_dialog (ask the user when it is a real choice), then check its result with job_status("${id}").`;
  const CLOSE = 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool ' +
    "can close it).";

  it("words SkinGen's About box from an older plugin as a window to close in CC5, as load_asset does", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "bake_skin_textures", status: "running", dialog: ABOUT,
      dialog_message: oldWaiting("cmd_3") });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`${CLOSE}\nJob cmd_3 is waiting on this window; read its result with job_status ` +
      "once it is closed.");
    expect(r.content[0].text).not.toContain("answer_cc5_dialog");
    expect(r.content[0].text).not.toContain("S/N");
  });

  it("says a job queued behind such a window runs once that window has closed", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "queued", blocked_by: "cmd_3",
      dialog: ABOUT, dialog_message: `Job cmd_4 has not started: it is queued behind job cmd_3. ${oldWaiting("cmd_3")} ` +
        'Job cmd_4 runs after that answer; read its result with job_status("cmd_4").' });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Job cmd_4 has not started: it is queued behind job cmd_3, which waits in this " +
      `window:\n${CLOSE}\nJob cmd_4 runs once that window has closed; read its result with job_status("cmd_4").`);
  });

  it("keeps a batch F plugin's own words for that window, and a question's text", async () => {
    const own = `${CLOSE} The command is still running as job cmd_3: read its result with job_status("cmd_3") once it ` +
      "is closed.";
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "bake_skin_textures", status: "running", dialog: ABOUT,
      dialog_message: own });
    expect((await server.getRegisteredTool("job_status")({ job_id: "cmd_3" })).content[0].text).toBe(own);
    const replace = 'CC5 is waiting for an answer to "Replace?". Buttons: Replace, Cancel.';
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "load_asset", status: "running",
      dialog: { title: "", text: "Replace?", buttons: ["Replace", "Cancel"] }, dialog_message: replace });
    expect((await server.getRegisteredTool("job_status")({ job_id: "cmd_3" })).content[0].text).toBe(replace);
  });
});

// F-91 (live 2026-10-07): a content load during a SkinGen session asked this. get_cc5_dialog gave the rule (a plain
// confirmation for a load the user asked for: answer OK and say so); job_status did not.
describe("job_status for a job waiting in CC5's question before a content load ends a SkinGen session (F-91)", () => {
  const SKINGEN = { title: "Character Creator 5", text: SKINGEN_QUESTION, buttons: ["OK", "Cancel"], text_read: true };
  const waiting = `CC5 is waiting for an answer to "${SKINGEN_QUESTION}" (the "Character Creator 5" window). Buttons: ` +
    "OK, Cancel. The command is still running as job cmd_3: answer it with answer_cc5_dialog (ask the user when it is " +
    'a real choice), then check its result with job_status("cmd_3").';

  it("gives the rule on its own line after the question", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "load_asset", status: "running", dialog: SKINGEN,
      dialog_message: waiting });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`${waiting}\n${SKINGEN_QUESTION_RULE}`);
  });

  it("gives it to a job queued behind that question too, and finds the question in a waiting text without the dialog", async () => {
    const queued = `Job cmd_4 has not started: it is queued behind job cmd_3. ${waiting} Job cmd_4 runs after that ` +
      'answer; read its result with job_status("cmd_4").';
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "queued", blocked_by: "cmd_3",
      dialog: SKINGEN, dialog_message: queued });
    expect((await server.getRegisteredTool("job_status")({ job_id: "cmd_4" })).content[0].text)
      .toBe(`${queued}\n${SKINGEN_QUESTION_RULE}`);
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "load_asset", status: "running", dialog_message: waiting });
    expect((await server.getRegisteredTool("job_status")({ job_id: "cmd_3" })).content[0].text)
      .toBe(`${waiting}\n${SKINGEN_QUESTION_RULE}`);
  });
});

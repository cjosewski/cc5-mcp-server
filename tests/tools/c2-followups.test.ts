/**
 * Batch C follow-ups (C2 and its review): job tools that show CC5's question instead of "still running", their
 * error text when a call fails, and the tool descriptions C2 corrected.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BridgeHttpError, BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { pendingResult } from "../../src/jobs.js";
import { registerPipelineTools } from "../../src/tools/pipeline.js";
import { registerUnityTools } from "../../src/tools/unity.js";
import { registerMorphTools } from "../../src/tools/morph.js";
import { registerEditTools } from "../../src/tools/edit.js";
import { registerSceneTools } from "../../src/tools/scene.js";
import { registerDialogTools } from "../../src/tools/dialog.js";
import { registerCharacterTools, BODY_PRESETS } from "../../src/tools/character.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  for (const register of [registerPipelineTools, registerUnityTools, registerMorphTools, registerEditTools,
    registerSceneTools, registerDialogTools, registerCharacterTools]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(server as any, bridge as any);
  }
});

const JOB_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["export_goz", { output_dir: "C:/GoZ/P1", pose: "tpose" }],
  ["import_fbx", { file_path: "C:/a/jacket.fbx", kind: "clothing" }],
  ["export_textures", { output_dir: "C:/SP", character_name: "P1" }],
  ["export_for_unity", { unity_dir: "D:/P/Assets/C", character_name: "P1", wait_seconds: 25 }],
];

describe("pendingResult", () => {
  it("is CC5's question when the job waits on a dialog, else the still-running note and the hint", () => {
    expect(pendingResult({ job_id: "cmd_1", dialog: 'CC5 is waiting for an answer to "Replace?".' }))
      .toEqual({ content: [{ type: "text", text: 'CC5 is waiting for an answer to "Replace?".' }], isError: true });
    expect(pendingResult({ job_id: "cmd_1" }, "Hint.")).toEqual({ content: [{ type: "text",
      text: 'Still running in CC5 (job cmd_1). Call job_status with job_id "cmd_1" to get the result. ' +
        "Do not start the same operation again. Hint." }] });
  });
});

describe("job tools show CC5's question, not 'still running' (C2 review)", () => {
  it.each(JOB_TOOLS)("%s", async (name, args) => {
    const question = 'CC5 is waiting for an answer to "Replace?" (the "Character Creator 5" window). ' +
      'Read it with get_cc5_dialog, answer it with answer_cc5_dialog, then job_status("cmd_9").';
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", status: "running", dialog_message: question });
    const r = await server.getRegisteredTool(name)(args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(question);
  });
});

describe("a job queued behind another command's dialog (C2b review)", () => {
  it.each(JOB_TOOLS)("%s shows the question at once instead of waiting its whole budget", async (name, args) => {
    const blocked = 'Job cmd_9 has not started: it is queued behind job cmd_8. CC5 is waiting for an answer to ' +
      '"Replace?". Buttons: Replace, Cancel. Job cmd_9 runs after that answer; read its result with job_status("cmd_9").';
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", status: "queued", blocked_by: "cmd_8", dialog_message: blocked });
    const r = await server.getRegisteredTool(name)(args);
    expect(bridge.getJob).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(blocked);
  });
});

describe("job tools' error text when a call fails (C2 review)", () => {
  it.each(JOB_TOOLS)("%s shows CC5's own refusal as CC5 wrote it", async (name, args) => {
    bridge.startJob.mockRejectedValue(new BridgeHttpError("No avatar in scene", 400));
    const r = await server.getRegisteredTool(name)(args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("No avatar in scene");
  });

  it.each(JOB_TOOLS)("%s asks whether CC5 is running when it cannot be reached", async (name, args) => {
    bridge.startJob.mockRejectedValue(new BridgeUnreachableError("fetch failed (connect ECONNREFUSED 127.0.0.1:5101)"));
    const r = await server.getRegisteredTool(name)(args);
    expect(r.content[0].text).toBe("CC5 bridge error: fetch failed (connect ECONNREFUSED 127.0.0.1:5101). " +
      "Is CC5 running with the MCP Bridge plugin?");
  });

  it.each(JOB_TOOLS)("%s says a job CC5 no longer knows is lost", async (name, args) => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
    bridge.getJob.mockRejectedValue(new BridgeHttpError("Unknown job: cmd_5", 404));
    const r = await server.getRegisteredTool(name)(args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("CC5 bridge error: Job cmd_5 not found. CC5 was probably restarted and the job's " +
      "result is lost. Check the output folder, then run the operation again.");
  });
});

describe("tool descriptions corrected in C2 (C2 review)", () => {
  const call = (name: string) => server.tool.mock.calls.find((c) => c[0] === name);
  const description = (name: string) => call(name)?.[1] as string;

  it("adjust_morph's examples are real morph IDs (F-12)", () => {
    const shape = call("adjust_morph")?.[2] as Record<string, { description?: string }>;
    const ids = [...(shape.morph_id.description ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const known = new Set(Object.values(BODY_PRESETS).flat().map((m) => m.morph_id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(known.has(id)).toBe(true);
  });

  it("reset_morphs warns about identity morphs and never says to zero them (F-11)", () => {
    const d = description("reset_morphs");
    expect(d).toContain("identity morphs");
    expect(d).toContain("use undo");
    expect(d).toContain("never zero a template's identity morphs");
    expect(d).not.toContain("set those morphs to 0");
  });

  it("undo and redo say what CC5 does not report (F-55)", () => {
    expect(description("undo")).toContain("CC5 does not say when nothing is left to undo");
    expect(description("redo")).toContain("redo is then refused");
    expect(description("redo")).toContain("redo then says it succeeded and changes nothing");
  });

  it("set_subdivision_level says the HD data comes from Modify > Subdivide (F-16)", () => {
    expect(description("set_subdivision_level")).toContain("Modify > Subdivide");
  });

  it("check_cc5_connection gives both waits (F-59)", () => {
    const d = description("check_cc5_connection");
    expect(d).toContain("about 30 s");
    expect(d).toContain("about 5 s");
    expect(d).not.toContain("holds every command");
  });

  it("the dialog tools give the progress-window rule (F-56) and the user's-own-dialog rule", () => {
    expect(description("get_cc5_dialog")).toContain("progress window");
    expect(description("answer_cc5_dialog")).toContain("progress window");
    expect(description("answer_cc5_dialog")).toContain("A dialog no MCP command is waiting on");
  });

  it("describe_character says a template's own shape is not graded (F-60)", () => {
    expect(description("describe_character")).toContain("not graded");
  });
});

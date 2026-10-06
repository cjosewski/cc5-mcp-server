import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runBatch, registerBatchTools, BatchSchema, type Manifest } from "../../src/tools/batch.js";
import { registerBuilderTools } from "../../src/tools/builder.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let started: ReturnType<typeof mockJobs>;
/** Results the next export_for_unity jobs return, in order; afterwards each export succeeds. */
let exportResults: unknown[];
const ok = { success: true };
const exported = (name: string) => ({ success: true, fbx: `D:/P/Assets/Pt/${name}/${name}.fbx`, folder: `D:/P/Assets/Pt/${name}`, files: [] });
const baseLoads = () => started.filter((j) => j.action === "load_asset");

beforeEach(() => {
  bridge = createMockBridge();
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: 1, type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
  bridge.setSkinCondition.mockResolvedValue(ok);
  bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, triangles: 2000, materials: 4 } });
  exportResults = [];
  started = mockJobs(bridge, { export_for_unity: (p) => exportResults.shift() ?? exported(String(p.character_name)) });
});

const input = {
  base_character: "D:/Base/Male.ccAvatar",
  unity_dir: "D:/P/Assets/Pt",
  variants: [
    { name: "A", recipe: { skin_condition: { condition: "pale" as const, amount: 0.5 } } },
    { name: "B", recipe: {} },
  ],
};

describe("runBatch", () => {
  it("reloads the base for every variant, exports, and writes the manifest each time", async () => {
    const writes: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, (man) => writes.push(man.variants.length));
    // The base loads as a job: a dressed .ccAvatar can outlast the bridge's 30 s limit for direct calls.
    expect(baseLoads()).toEqual([
      { action: "load_asset", params: { file_path: "D:/Base/Male.ccAvatar" } },
      { action: "load_asset", params: { file_path: "D:/Base/Male.ccAvatar" } },
    ]);
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(m.variants.map((v) => v.ok)).toEqual([true, true]);
    expect(m.variants[0].budget_pass).toBe(true);
    expect(writes).toEqual([1, 2]);
  });

  it("records a failed export and continues", async () => {
    exportResults.push({ success: false, error: "disk full" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0]).toMatchObject({ ok: false, error: "disk full" });
    expect(m.variants[1].ok).toBe(true);
  });

  it("exports a posed variant with include_current_pose", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBatch(bridge as any, { ...input, variants: [{ name: "Supine", recipe: { pose_file: "C:/p/Supine.rlMotion" } }] }, () => undefined);
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ include_current_pose: true }));
  });

  it("records a CC5 crash on that variant, writes the manifest, and continues", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new Error("fetch failed"));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, (man) => writes.push(JSON.stringify(man)));
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: "fetch failed" });
    expect(m.variants[1]).toMatchObject({ name: "B", ok: true });
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]).variants[0]).toMatchObject({ name: "A", ok: false, error: "fetch failed" });
  });

  it("marks a variant not ok when a recipe step fails, but still exports it", async () => {
    bridge.setSkinCondition.mockResolvedValueOnce({ success: false, error: "No avatar in scene" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0].ok).toBe(false);
    expect(m.variants[0].steps).toContainEqual({ step: "skin_condition", ok: false, detail: "No avatar in scene" });
    expect(m.variants[0].fbx).toBe("D:/P/Assets/Pt/A/A.fbx");
    expect(m.variants[1].ok).toBe(true);
  });
});

describe("runBatch scene and stats failures", () => {
  it("fails a variant whose old avatar cannot be removed, without loading the base onto it", async () => {
    bridge.deleteAvatar.mockResolvedValueOnce({ success: false, error: "locked" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: "could not remove existing avatar Old: locked" });
    expect(baseLoads()).toHaveLength(1);
    expect(m.variants[1].ok).toBe(true);
  });

  it("keeps the exported fbx but records an error when mesh stats fail", async () => {
    bridge.getMeshStats.mockResolvedValueOnce({ success: false, error: "No avatar in scene" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0]).toMatchObject({ ok: false, fbx: "D:/P/Assets/Pt/A/A.fbx", error: "mesh stats failed: No avatar in scene" });
    expect(m.variants[0].budget_pass).toBeUndefined();
    expect(m.variants[1].ok).toBe(true);
  });

  it("fails a variant exported without some of its settings and keeps the warnings in the manifest", async () => {
    exportResults.push({ ...exported("A"), notes: ["target_tool=Unity preset applied", "WARNING: SetTextureSize failed: x"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, notes: ["WARNING: SetTextureSize failed: x"] });
    expect(m.variants[0].error).toContain("WARNING: SetTextureSize failed: x");
    expect(m.variants[1].ok).toBe(true);
    expect(m.variants[1].notes).toBeUndefined();
  });
});

describe("runBatch with export subdivision", () => {
  // export_for_unity subdivides only the FBX (RExportFbxSetting.SetExportLevel leaves the scene at base level),
  // so getMeshStats counts base-mesh faces and cannot vouch for a sub_d_level > 0 export.
  it("does not report a budget pass from base-mesh faces when sub_d_level > 0", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 20_000, triangles: 40_000, materials: 4 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, sub_d_level: 2 }, () => undefined);
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ sub_d_level: 2 }));
    expect(m.variants[0].budget_pass).toBeUndefined();
    expect(m.variants[0].budget?.[0]).toMatch(/^NOT CHECKED Triangles: .*sub_d_level 2.*about 16x.*640,000/);
    expect(m.variants[0].ok).toBe(true);
  });

  it("still reports a budget fail when the base mesh is already over budget", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, triangles: 2000, materials: 99 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, sub_d_level: 1 }, () => undefined);
    expect(m.variants[0].budget_pass).toBe(false);
    expect(m.variants[0].budget).toContainEqual(expect.stringMatching(/^OVER Materials: 99/));
  });

  it("checks triangles as before when sub_d_level is 0", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, sub_d_level: 0 }, () => undefined);
    expect(m.variants[0].budget_pass).toBe(true);
    expect(m.variants[0].budget?.[0]).toMatch(/^OK +Triangles: 2,000 \//);
  });

  it("says in the tool summary that the triangle budget was not checked", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc5-batch-")), "Proj", "Assets", "Pt");
    try {
      const server = createMockServer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerBatchTools(server as any, bridge as any);
      const r = await server.getRegisteredTool("batch_generate_patients")({ ...input, unity_dir: dir, sub_d_level: 1 });
      expect(r.content[0].text).toContain("OK   A (triangle budget not checked: sub_d_level 1)");
      const written = JSON.parse(fs.readFileSync(path.join(dir, "patients_manifest.json"), "utf8"));
      expect(written.variants[0].budget_pass).toBeUndefined();
    } finally {
      fs.rmSync(path.resolve(dir, "..", "..", ".."), { recursive: true, force: true });
    }
  });
});

function batchHandler() {
  const server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBatchTools(server as any, bridge as any);
  return server.getRegisteredTool("batch_generate_patients");
}

describe("batch_generate_patients description", () => {
  // Live CC5 5.13 (Task 18): the first FBX export of a CC5 session crashed CC5 in about 3 of 4 sessions.
  it("warns that CC5 often crashes on the first FBX export and says how to recover", () => {
    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerBatchTools(server as any, bridge as any);
    const description = server.tool.mock.calls.find((c) => c[0] === "batch_generate_patients")?.[1] as string;
    expect(description).toContain("Character Creator 5 5.13 often crashes on the first FBX export after it starts");
    expect(description).toContain("if CC5 closes during the first variant, restart CC5, answer its recovery prompt and run the batch again");
    expect(description).toContain("patients_manifest.json records the error of each variant that failed");
  });
});

// The handler creates unity_dir and writes patients_manifest.json in TypeScript, before CC5 sees anything,
// so these guards are the only thing between a bad request and a folder written outside a Unity project.
describe("batch_generate_patients refuses bad input before writing anything", () => {
  let project: string;
  beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-batch-")); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("refuses a unity_dir outside a Unity Assets folder", async () => {
    const outside = path.join(project, "Exports");
    const r = await batchHandler()({ ...input, unity_dir: outside });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("inside a Unity project's Assets folder");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("refuses a network (UNC) unity_dir", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const r = await batchHandler()({ ...input, unity_dir: "//host/share/Assets/x" });
    expect(r.isError).toBe(true);
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a base_character that is not a local .ccAvatar", async () => {
    const unityDir = path.join(project, "Assets", "Pt");
    const r = await batchHandler()({ ...input, unity_dir: unityDir, base_character: "//host/share/Male.ccAvatar" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("base_character");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(fs.existsSync(unityDir)).toBe(false);
  });

  it("refuses variant names that are the same folder on Windows", async () => {
    const unityDir = path.join(project, "Assets", "Pt");
    const r = await batchHandler()({ ...input, unity_dir: unityDir,
      variants: [{ name: "Patient_A", recipe: {} }, { name: "patient_a", recipe: {} }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Variant names must be unique");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(fs.existsSync(unityDir)).toBe(false);
    expect(BatchSchema.safeParse({ ...input, variants: [{ name: "A", recipe: {} }, { name: "A", recipe: {} }] }).success).toBe(false);
    expect(BatchSchema.safeParse(input).success).toBe(true);
  });

  it("reports a batch with a failed variant as an error", async () => {
    exportResults.push({ success: false, error: "disk full" });
    const r = await batchHandler()({ ...input, unity_dir: path.join(project, "Assets", "Pt") });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("1/2 variants exported");
    expect(r.content[0].text).toContain("FAIL A: disk full");
  });
});

describe("batch cancellation, one scene edit at a time, and progress", () => {
  let project: string;
  beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-batch-")); });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it("sends CC5 nothing more once the client cancels, and says so in the manifest", async () => {
    const ac = new AbortController();
    // The client cancels (Esc, or its own timeout) while CC5 applies variant A's skin condition.
    bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return ok; });
    const writes: Manifest[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants: [...input.variants, { name: "C", recipe: {} }] },
      (man) => writes.push(structuredClone(man)), { signal: ac.signal });
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);  // variant A's scene clear only
    expect(baseLoads()).toHaveLength(1);
    expect(started.map((j) => j.action)).not.toContain("export_for_unity");
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
    expect(m.variants).toHaveLength(1);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: "cancelled before this variant finished" });
    expect(m.variants[0].steps).toEqual([{ step: "skin_condition", ok: true, detail: "" }]);
    expect(m.cancelled).toBe("Cancelled by the client. Not started: B, C.");
    expect(writes.at(-1)).toEqual(m);
  });

  it("stops waiting for an export when cancelled, naming the job CC5 is still running", async () => {
    const ac = new AbortController();
    bridge.startJob.mockImplementation(async (action: string) => ({ job_id: action === "export_for_unity" ? "cmd_ab12cd34_7" : "cmd_ab12cd34_1" }));
    bridge.getJob.mockImplementation(async (id: string) => {
      if (id !== "cmd_ab12cd34_7") return { job_id: id, action: "load_asset", status: "done", result: ok };
      ac.abort();
      return { job_id: id, action: "export_for_unity", status: "running" };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, { signal: ac.signal });
    expect(m.variants[0].error).toBe("cancelled before this variant finished (export still running in CC5 as job cmd_ab12cd34_7)");
    expect(m.cancelled).toBe("Cancelled by the client. Not started: B.");
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
  });

  it("records CC5's question when an export waits on a dialog, not 'export still running' (C2 review)", async () => {
    const question = 'CC5 is waiting for an answer to "Overwrite?". Buttons: Yes, No. The command is still running as ' +
      'job cmd_ab12cd34_7: answer it with answer_cc5_dialog (ask the user when it is a real choice), then check its ' +
      'result with job_status("cmd_ab12cd34_7").';
    bridge.startJob.mockImplementation(async (action: string) => ({ job_id: action === "export_for_unity" ? "cmd_ab12cd34_7" : "cmd_ab12cd34_1" }));
    bridge.getJob.mockImplementation(async (id: string) => id === "cmd_ab12cd34_7"
      ? { job_id: id, action: "export_for_unity", status: "running", dialog_message: question }
      : { job_id: id, action: "load_asset", status: "done", result: ok });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants: [input.variants[0]] }, () => undefined);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: question });
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
  });

  it("returns a cancelled batch as an error and writes the cancellation to the manifest file", async () => {
    const ac = new AbortController();
    bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return ok; });
    const unityDir = path.join(project, "Assets", "Pt");
    const r = await batchHandler()({ ...input, unity_dir: unityDir }, { signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.startsWith("Cancelled by the client. Not started: B.")).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(unityDir, "patients_manifest.json"), "utf8"));
    expect(written.cancelled).toBe("Cancelled by the client. Not started: B.");
  });

  it("refuses a second batch, and a recipe, while a batch is running", async () => {
    const unityDir = path.join(project, "Assets", "Pt");
    let resume!: () => void;
    bridge.getAvatars.mockImplementationOnce(() => new Promise((resolve) => { resume = () => resolve([]); }));
    const handler = batchHandler();
    const first = handler({ ...input, unity_dir: unityDir });

    const second = await handler({ ...input, unity_dir: unityDir });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("is still running in CC5");
    expect(second.content[0].text).toContain("patients_manifest.json");
    const builder = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerBuilderTools(builder as any, bridge as any);
    const recipe = await builder.getRegisteredTool("apply_character_recipe")({ recipe: { skin_condition: { condition: "pale", amount: 1 } } });
    expect(recipe.isError).toBe(true);
    expect(recipe.content[0].text).toContain("batch_generate_patients");
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();

    resume();
    expect((await first).isError).toBeUndefined();
    expect(bridge.getAvatars).toHaveBeenCalledTimes(2);  // the refused batch never touched the scene
    expect((await handler({ ...input, unity_dir: unityDir })).isError).toBeUndefined();  // released again
  });

  it("sends a progress notification after every recipe step and variant when the client asks for progress", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const r = await batchHandler()({ ...input, unity_dir: path.join(project, "Assets", "Pt") },
      { signal: new AbortController().signal, _meta: { progressToken: "tok" }, sendNotification });
    expect(r.isError).toBeUndefined();
    const sent = sendNotification.mock.calls.map(([n]) => n);
    expect(sent.every((n) => n.method === "notifications/progress" && n.params.progressToken === "tok")).toBe(true);
    expect(sent.map((n) => n.params.progress)).toEqual([1, 2, 3]);
    expect(sent.map((n) => n.params.message)).toEqual(["A (1/2): OK skin_condition", "A (1/2): done", "B (2/2): done"]);
  });

  it("sends no progress notification when the client did not ask for progress", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await batchHandler()({ ...input, unity_dir: path.join(project, "Assets", "Pt") },
      { signal: new AbortController().signal, sendNotification });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

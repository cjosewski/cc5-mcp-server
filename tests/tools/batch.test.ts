import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runBatch, registerBatchTools, readManifest, mergeManifest, BatchSchema,
  type BatchStopDetail, type Manifest, type ManifestVariant,
} from "../../src/tools/batch.js";
import { registerBuilderTools } from "../../src/tools/builder.js";
import { BridgeHttpError } from "../../src/cc5-bridge.js";
import { finishBuild, startBuild, LAYER_EXPECT } from "../../src/build-session.js";
import { formatDialog } from "../../src/tools/dialog.js";
import {
  INJURY_WARNING_PREFIX, TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, injuryLines, injuryQuestion, type InjuryReport,
} from "../../src/tools/unity.js";
import { BATCH_RULE, CANCEL_NOT_CARRIED } from "../../src/prompts/content-rules.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { makeUnityProject, markUnityProject } from "../helpers/unity-project.js";

let bridge: MockBridge;
let started: ReturnType<typeof mockJobs>;
/** Results the next export_for_unity jobs return, in order; afterwards each export succeeds. */
let exportResults: unknown[];
const ok = { success: true };
/** F-75: the plugin's report for a character with no skin overlays and no skin condition. */
const noInjuries = (fields: Partial<InjuryReport> = {}): InjuryReport => ({
  choice: "omit", not_carried: [], unverified: [], done: [], failed: [], notes: [], calibrated: null, ...fields,
});
/** An export by a plugin older than F-75: no injuries report. */
const plainExport = (name: string) =>
  ({ success: true, fbx: `D:/P/Assets/Pt/${name}/${name}.fbx`, folder: `D:/P/Assets/Pt/${name}`, files: [] });
const exported = (name: string) => ({ ...plainExport(name), injuries: noInjuries() });
const baseLoads = () => started.filter((j) => j.action === "load_asset");
const exportsOf = () => started.filter((j) => j.action === "export_for_unity");
/** runBatch checks the bases before any CC5 call (F-81); these tests use made-up paths. */
const anyFile = { fileExists: () => true };

beforeEach(() => {
  bridge = createMockBridge();
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: 1, type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
  bridge.setSkinCondition.mockResolvedValue(ok);
  bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, triangles: 2000, materials: 4 } });
  exportResults = [];
  started = mockJobs(bridge, { export_for_unity: (p) => exportResults.shift() ?? exported(String(p.character_name)) });
  finishBuild(startBuild("batch"));  // no stop left over from another test
});

const input = {
  base_character: "D:/Base/Male.ccAvatar",
  unity_dir: "D:/P/Assets/Pt",
  injuries: "omit" as const,  // A is pale: an FBX cannot carry the pallor (F-75)
  variants: [
    { name: "A", recipe: { skin_condition: { condition: "pale" as const, amount: 0.5 } } },
    { name: "B", recipe: {}, export_base_unchanged: true },
  ],
};

// ── CC5 texts and jobs ───────────────────────────────────────────────────────────────────────────────────────────

const EYES = "C:/Templates/Eye/Eyes_01.ccEye";
const PANTS = "C:/c/Pants.ccCloth";
const RED_VELVET = "C:/Templates/Makeup/Lip Makeup/Makeup & SFX/Red Velvet.ccSkinGenPreset";
const RGB: [number, number, number] = [0.8, 0.6, 0.5];
const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["&Replace", "Material Only", "Cancel"],
};
const LAYER_QUESTION = "The target object layer already exists. Do you want to replace the object, or the material only?";
const APPLY = { title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] };
const OVERWRITE = { title: "", text: "Overwrite?", buttons: ["Yes", "No"] };
const PROGRESS = { title: "Exporting", text: "Exporting FBX...", buttons: ["Cancel"], progress: true };
/** server.py _modal_dialog_error: the open-dialog guard failed the command; it never ran. */
const GUARD = 'CC5 is waiting for an answer to "Replace?" - no MCP command is waiting on it, so it is probably the ' +
  "user's own or CC5's: ask the user to answer or close it in CC5, then try again.";
/** server.py _execute_sync's 504 for a direct call that never started (cc5-bridge.ts adds the prefix). */
const NOT_STARTED = "CC5 timed out (cancelled): Timed out before CC5 started the command; it was cancelled and will not run.";
/** server.py _waiting_dialog_error: a 409's text and a waiting job's dialog_message. */
const waiting = (id: string, question = LAYER_QUESTION, buttons = "Replace, Material Only, Cancel") =>
  `CC5 is waiting for an answer to "${question}" (the "Character Creator 5" window). Buttons: ${buttons}. The command is ` +
  `still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a real choice), then check ` +
  `its result with job_status("${id}").`;
const changes = (facts: unknown[]) => ({ complete: true, target: "Old", target_is_first: true, elapsed_ms: 420,
  compared: { worn: 3, morphs: 12, materials: 30 }, skipped: 0, truncated: false, facts });
const SKIN_FACT = { kind: "material", mesh: "CC_Base_Body", material: "Std_Skin_Head", field: "diffuse",
  before: [204, 153, 128], after: [255, 255, 255] };
/** The id in a manifest's stopped line. */
const continueId = (text: string) => /continue_after: "([^"]+)"/.exec(text)?.[1] ?? "";

type Script = { status: "queued" | "running" | "done" | "failed"; result?: unknown; dialog?: unknown; dialog_message?: string; blocked_by?: string };
const finished = (result: unknown): Script => ({ status: "done", result });
const asking = (id: string, dialog: unknown = LAYER, message = waiting(id)): Script =>
  ({ status: "running", dialog, dialog_message: message });
const loadedEye = (file: string): Script => finished({ success: true, path: file, target: "Old", changes: changes([]) });

/** Jobs that report what the test scripts: `next` says how a new job starts, `set` changes what a job reports later. */
function jobStore(next: (action: string, params: Record<string, unknown>, id: string) => Script) {
  const jobs = new Map<string, { action: string; script: Script }>();
  const list: Array<{ id: string; action: string; params: Record<string, unknown> }> = [];
  bridge.startJob.mockImplementation(async (action: string, params: Record<string, unknown>) => {
    const id = `cmd_ab12cd34_${list.length + 1}`;
    list.push({ id, action, params });
    jobs.set(id, { action, script: next(action, params, id) });
    return { job_id: id };
  });
  bridge.getJob.mockImplementation(async (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new BridgeHttpError(`Unknown job: ${id}`, 404);
    return { job_id: id, action: job.action, ...job.script };
  });
  return {
    started: list,
    set(id: string, script: Script) {
      const job = jobs.get(id);
      if (job) job.script = script;
    },
  };
}

/** Eye presets ask CC5's Replace / Material Only question; the base loads and every export finishes. */
const eyesAsk = (exportResult: (name: string) => unknown = exported) => jobStore((action, params, id) => {
  if (action === "export_for_unity") return finished(exportResult(String(params.character_name)));
  return String(params.file_path).endsWith(".ccEye") ? asking(id) : finished(ok);
});
const eyeVariants = [
  { name: "A", recipe: { assets: [EYES], skin_rgb: RGB } },
  { name: "B", recipe: {}, export_base_unchanged: true },
];

// ── The tool, in a Unity project with a saved base ───────────────────────────────────────────────────────────────

type Project = { root: string; base: string; unityDir: string; manifestPath: string };
/** A temp Unity project with a saved base in it: the tool checks both before any CC5 call (F-76, F-81). */
function makeProject(): Project {
  const root = makeUnityProject();
  const base = path.join(root, "Male.ccAvatar");
  fs.writeFileSync(base, "saved base");
  const unityDir = path.join(root, "Assets", "Pt");
  return { root, base, unityDir, manifestPath: path.join(unityDir, "patients_manifest.json") };
}
const inProject = (p: Project, fields: Record<string, unknown> = {}) =>
  ({ ...input, base_character: p.base, unity_dir: p.unityDir, ...fields });

function batchHandler() {
  const server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBatchTools(server as any, bridge as any);
  return server.getRegisteredTool("batch_generate_patients");
}

describe("runBatch", () => {
  it("reloads the base for every variant, exports, and writes the manifest each time", async () => {
    const writes: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, (man) => writes.push(man.variants.length), anyFile);
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
    // F-80: each entry says when it was made and from which base, so a manifest of several batches stays readable.
    expect(m.variants[0].base).toBe("D:/Base/Male.ccAvatar");
    expect(Number.isNaN(Date.parse(m.variants[0].created ?? ""))).toBe(false);
  });

  it("records a failed export and continues", async () => {
    exportResults.push({ success: false, error: "disk full" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
    expect(m.variants[0]).toMatchObject({ ok: false, error: "disk full" });
    expect(m.variants[1].ok).toBe(true);
  });

  it("exports a posed variant with include_current_pose", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBatch(bridge as any, { ...input, variants: [{ name: "Supine", recipe: { pose_file: "C:/p/Supine.rlMotion" } }] }, () => undefined, anyFile);
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ include_current_pose: true }));
  });

  it("records a CC5 crash on that variant, writes the manifest, and continues", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new Error("fetch failed"));
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, (man) => writes.push(JSON.stringify(man)), anyFile);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: "fetch failed" });
    expect(m.variants[1]).toMatchObject({ name: "B", ok: true });
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]).variants[0]).toMatchObject({ name: "A", ok: false, error: "fetch failed" });
  });

  it("marks a variant not ok when a recipe step fails, but still exports it", async () => {
    bridge.setSkinCondition.mockResolvedValueOnce({ success: false, error: "No avatar in scene" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
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
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: "could not remove existing avatar Old: locked" });
    expect(baseLoads()).toHaveLength(1);
    expect(m.variants[1].ok).toBe(true);
  });

  it("keeps the exported fbx but records an error when mesh stats fail", async () => {
    bridge.getMeshStats.mockResolvedValueOnce({ success: false, error: "No avatar in scene" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
    expect(m.variants[0]).toMatchObject({ ok: false, fbx: "D:/P/Assets/Pt/A/A.fbx", error: "mesh stats failed: No avatar in scene" });
    expect(m.variants[0].budget_pass).toBeUndefined();
    expect(m.variants[1].ok).toBe(true);
  });

  it("fails a variant exported without some of its settings and keeps the warnings in the manifest", async () => {
    exportResults.push({ ...exported("A"), notes: ["target_tool=Unity preset applied", "WARNING: SetTextureSize failed: x"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
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
    const m = await runBatch(bridge as any, { ...input, sub_d_level: 2 }, () => undefined, anyFile);
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ sub_d_level: 2 }));
    expect(m.variants[0].budget_pass).toBeUndefined();
    expect(m.variants[0].budget?.[0]).toMatch(/^NOT CHECKED Triangles: .*sub_d_level 2.*about 16x.*640,000/);
    expect(m.variants[0].ok).toBe(true);
  });

  it("still reports a budget fail when the base mesh is already over budget", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, triangles: 2000, materials: 99 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, sub_d_level: 1 }, () => undefined, anyFile);
    expect(m.variants[0].budget_pass).toBe(false);
    expect(m.variants[0].budget).toContainEqual(expect.stringMatching(/^OVER Materials: 99/));
  });

  it("checks triangles as before when sub_d_level is 0", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, sub_d_level: 0 }, () => undefined, anyFile);
    expect(m.variants[0].budget_pass).toBe(true);
    expect(m.variants[0].budget?.[0]).toMatch(/^OK +Triangles: 2,000 \//);
  });

  it("says in the tool summary that the triangle budget was not checked", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-batch-"));
    const proj = path.join(tmp, "Proj");
    markUnityProject(proj);
    const base = path.join(proj, "Male.ccAvatar");
    fs.writeFileSync(base, "saved base");
    const dir = path.join(proj, "Assets", "Pt");
    try {
      const r = await batchHandler()({ ...input, base_character: base, unity_dir: dir, sub_d_level: 1 });
      expect(r.content[0].text).toContain("OK   A (triangle budget not checked: sub_d_level 1)");
      const written = JSON.parse(fs.readFileSync(path.join(dir, "patients_manifest.json"), "utf8"));
      expect(written.variants[0].budget_pass).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("batch_generate_patients description", () => {
  const registered = () => {
    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerBatchTools(server as any, bridge as any);
    return server.tool.mock.calls.find((c) => c[0] === "batch_generate_patients");
  };

  // Live CC5 5.13 (Task 18): the first FBX export of a CC5 session crashed CC5 in about 3 of 4 sessions.
  it("warns that CC5 often crashes on the first FBX export and says how to recover", () => {
    const description = registered()?.[1] as string;
    expect(description).toContain("Character Creator 5 5.13 often crashes on the first FBX export after it starts");
    expect(description).toContain("if CC5 closes during the first variant, restart CC5, answer its recovery prompt and run the batch again");
    expect(description).toContain("patients_manifest.json records the error of each variant that failed");
  });

  it("describes the stop, continue_after, layer_answer, control patients, the manifest and injuries, then the batch rule", () => {
    const description = registered()?.[1] as string;
    for (const text of [
      "A CC5 question stops the batch: nothing more is sent to CC5 until it is answered, and the reply gives the " +
        "continue_after call that finishes the stopped variant from where it stopped.",
      "A batch does not start while a CC5 dialog is open.",
      "Replace / Material Only has no standing answer: after the user picked a button, pass it as layer_answer with " +
        "continue_after; it answers the same question for the rest of this batch only.",
      "A variant with an empty recipe is refused unless export_base_unchanged is true (a control patient).",
      "patients_manifest.json keeps the entries of earlier batches in the same folder; a variant run again replaces its entry.",
      "A .ccAvatar does not keep the facial expression: give each variant that needs one an expression step.",
      "variants that have them need injuries ('bake', 'separate' or 'omit'), as the user chose; there is no default.",
      "unity_dir must be inside an existing Unity project, and base_character must exist.",
    ]) {
      expect(description).toContain(text);
    }
    expect(description.endsWith(BATCH_RULE)).toBe(true);
    expect(description.length).toBeLessThan(2000);
  });

  it("takes continue_after, layer_answer and injuries in the schema, with no default injuries", () => {
    const shape = BatchSchema.shape;
    expect(shape.continue_after.safeParse("cmd_ab12cd34_1").success).toBe(true);
    expect(shape.continue_after.safeParse("stop_3").success).toBe(true);
    expect(shape.continue_after.safeParse("anything").success).toBe(false);
    expect(shape.layer_answer.safeParse("Material Only").success).toBe(true);
    expect(shape.layer_answer.safeParse("Cancel").success).toBe(false);
    expect(shape.layer_answer.description).toContain("for the rest of this batch only; there is no standing answer");
    // RB-6: the schema takes no Cancel, so its description says how to go on after one.
    expect(shape.layer_answer.description?.endsWith(CANCEL_NOT_CARRIED)).toBe(true);
    expect(shape.injuries.safeParse("omit").success).toBe(true);
    expect(shape.injuries.safeParse(undefined).success).toBe(true);
    expect(shape.injuries.description).toContain("there is no default");
    expect(shape.unity_dir.description).toContain("ProjectSettings\\ProjectVersion.txt");
    expect(registered()?.[2]).toBe(BatchSchema.shape);
  });
});

// The handler creates unity_dir and writes patients_manifest.json in TypeScript, before CC5 sees anything,
// so these guards are the only thing between a bad request and a folder written outside a Unity project.
describe("batch_generate_patients refuses bad input before writing anything", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  const noCC5Call = () => {
    for (const call of [bridge.getDialog, bridge.getAvatars, bridge.startJob]) expect(call).not.toHaveBeenCalled();
  };

  it("refuses a unity_dir outside a Unity Assets folder", async () => {
    const outside = path.join(p.root, "Exports");
    const r = await batchHandler()(inProject(p, { unity_dir: outside }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`unity_dir must be inside a Unity project's Assets folder: ${outside}. Nothing was sent to CC5.`);
    noCC5Call();
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("refuses an Assets folder that is not inside a Unity project (F-76)", async () => {
    const unityDir = path.join(p.root, "NoProj", "Assets", "Pt");
    const r = await batchHandler()(inProject(p, { unity_dir: unityDir }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`unity_dir is not inside a Unity project: ${unityDir}.`);
    expect(r.content[0].text).toContain(path.join(p.root, "NoProj", "ProjectSettings", "ProjectVersion.txt"));
    expect(r.content[0].text.endsWith(". Nothing was sent to CC5.")).toBe(true);
    noCC5Call();
    expect(fs.existsSync(path.join(p.root, "NoProj"))).toBe(false);
  });

  it("refuses a network (UNC) unity_dir", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const r = await batchHandler()(inProject(p, { unity_dir: "//host/share/Assets/x" }));
    expect(r.isError).toBe(true);
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a base_character that is not a local .ccAvatar", async () => {
    const r = await batchHandler()(inProject(p, { base_character: "//host/share/Male.ccAvatar" }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("base_character");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(fs.existsSync(p.unityDir)).toBe(false);
  });

  // F-81: variant 1's scene clear deleted the user's character before a mistyped base failed to load.
  it("refuses a base_character that does not exist, before any CC5 call or folder", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const missing = path.join(p.root, "Gone.ccAvatar");
    const r = await batchHandler()(inProject(p, { base_character: missing }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`base_character not found: ${missing}. Nothing was sent to CC5.`);
    noCC5Call();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("refuses a variant whose recipe base does not exist, naming the variant", async () => {
    const missing = path.join(p.root, "Kevin.ccAvatar");
    const r = await batchHandler()(inProject(p, { variants: [{ name: "A", recipe: { base: missing } }] }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Variant A: base not found: ${missing}. Nothing was changed in CC5: the characters ` +
      "in the scene were left as they were.");
    noCC5Call();
    expect(fs.existsSync(p.unityDir)).toBe(false);
  });

  it("runBatch itself refuses a missing base or variant base, before any CC5 call", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runBatch(bridge as any, input, () => undefined, { fileExists: () => false }))
      .rejects.toThrow("base_character not found: D:/Base/Male.ccAvatar");
    const variants = [{ name: "A", recipe: { base: "C:/b/Kevin.ccAvatar" } }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runBatch(bridge as any, { ...input, variants }, () => undefined,
      { fileExists: (f: string) => f === input.base_character }))
      .rejects.toThrow("Variant A: base not found: C:/b/Kevin.ccAvatar.");
    noCC5Call();
    expect(bridge.deleteAvatar).not.toHaveBeenCalled();
  });

  it("refuses variant names that are the same folder on Windows", async () => {
    const r = await batchHandler()(inProject(p, { variants: [
      { name: "Patient_A", recipe: {}, export_base_unchanged: true },
      { name: "patient_a", recipe: {}, export_base_unchanged: true }] }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Variant names must be unique");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(fs.existsSync(p.unityDir)).toBe(false);
    expect(BatchSchema.safeParse({ ...input, variants: [
      { name: "A", recipe: {}, export_base_unchanged: true }, { name: "A", recipe: {}, export_base_unchanged: true }] }).success).toBe(false);
    expect(BatchSchema.safeParse(input).success).toBe(true);
  });

  it("reports a batch with a failed variant as an error", async () => {
    exportResults.push({ success: false, error: "disk full" });
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("1/2 variants exported");
    expect(r.content[0].text).toContain("FAIL A: disk full");
  });
});

// F-79: a variant with an empty recipe exported an unchanged copy of the base and reported OK.
describe("empty recipes and control patients (F-79)", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  const issues = (value: unknown) => {
    const r = BatchSchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  const EMPTY = "Variant Empty has an empty recipe: it would export the base unchanged. Give it recipe steps, or set " +
    "export_base_unchanged: true for a control patient.";

  it("refuses a variant with an empty recipe, naming it, before any CC5 call or folder", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const r = await batchHandler()(inProject(p, { variants: [input.variants[0], { name: "Refused", recipe: {} }] }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Invalid batch: Variant Refused has an empty recipe: it would export the base " +
      "unchanged. Give it recipe steps, or set export_base_unchanged: true for a control patient.");
    for (const call of [bridge.getDialog, bridge.getAvatars, bridge.startJob]) expect(call).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("the schema refuses an empty recipe ({} or {assets: []}) unless export_base_unchanged, and refuses both together", () => {
    for (const recipe of [{}, { assets: [] }]) {
      expect(issues({ ...input, variants: [{ name: "Empty", recipe }] })).toEqual([EMPTY]);
      expect(issues({ ...input, variants: [{ name: "Empty", recipe, export_base_unchanged: false }] })).toEqual([EMPTY]);
      expect(issues({ ...input, variants: [{ name: "Empty", recipe, export_base_unchanged: true }] })).toEqual([]);
    }
    expect(issues({ ...input, variants: [{ name: "Both", recipe: { skin_rgb: RGB }, export_base_unchanged: true }] }))
      .toEqual(["Variant Both has export_base_unchanged: true and recipe steps: leave out one or the other."]);
  });

  it("exports a control patient and says it is the base on purpose", async () => {
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("\nOK   B (the base, unchanged on purpose)");
    expect(exportsOf().map((j) => j.params.character_name)).toEqual(["A", "B"]);
    const written = readManifest(p.manifestPath);
    expect(written?.variants[1]).toMatchObject({ name: "B", ok: true, steps: [], export_base_unchanged: true });
    expect(written?.variants[0].export_base_unchanged).toBeUndefined();
  });
});

describe("batch cancellation, one scene edit at a time, and progress", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => fs.rmSync(p.root, { recursive: true, force: true }));

  it("sends CC5 nothing more once the client cancels, and says so in the manifest", async () => {
    const ac = new AbortController();
    // The client cancels (Esc, or its own timeout) while CC5 applies variant A's skin condition.
    bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return ok; });
    const writes: Manifest[] = [];
    const variants = [...input.variants, { name: "C", recipe: {}, export_base_unchanged: true }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants }, (man) => writes.push(structuredClone(man)),
      { ...anyFile, signal: ac.signal });
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
    const m = await runBatch(bridge as any, input, () => undefined, { ...anyFile, signal: ac.signal });
    expect(m.variants[0].error).toBe("cancelled before this variant finished (export still running in CC5 as job cmd_ab12cd34_7)");
    expect(m.cancelled).toBe("Cancelled by the client. Not started: B.");
    expect(m.stopped).toBeUndefined();
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
  });

  it("returns a cancelled batch as an error and writes the cancellation to the manifest file", async () => {
    const ac = new AbortController();
    bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return ok; });
    const r = await batchHandler()(inProject(p), { signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.startsWith("Cancelled by the client. Not started: B.")).toBe(true);
    const written = JSON.parse(fs.readFileSync(p.manifestPath, "utf8"));
    expect(written.cancelled).toBe("Cancelled by the client. Not started: B.");
  });

  it("refuses a second batch, and a recipe, while a batch is running", async () => {
    let resume: (() => void) | undefined;
    bridge.getAvatars.mockImplementationOnce(() => new Promise((resolve) => { resume = () => resolve([]); }));
    const handler = batchHandler();
    const first = handler(inProject(p));

    const second = await handler(inProject(p));
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

    // The first batch checks for an open CC5 dialog before its scene clear: wait until it holds the scene.
    await vi.waitFor(() => expect(resume).toBeDefined());
    resume?.();
    expect((await first).isError).toBeUndefined();
    expect(bridge.getAvatars).toHaveBeenCalledTimes(2);  // the refused batch never touched the scene
    expect((await handler(inProject(p))).isError).toBeUndefined();  // released again
  });

  it("sends a progress notification after every recipe step and variant when the client asks for progress", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const r = await batchHandler()(inProject(p), { signal: new AbortController().signal, _meta: { progressToken: "tok" }, sendNotification });
    expect(r.isError).toBeUndefined();
    const sent = sendNotification.mock.calls.map(([n]) => n);
    expect(sent.every((n) => n.method === "notifications/progress" && n.params.progressToken === "tok")).toBe(true);
    expect(sent.map((n) => n.params.progress)).toEqual([1, 2, 3]);
    expect(sent.map((n) => n.params.message)).toEqual(["A (1/2): OK skin_condition", "A (1/2): done", "B (2/2): done"]);
  });

  it("sends no progress notification when the client did not ask for progress", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await batchHandler()(inProject(p), { signal: new AbortController().signal, sendNotification });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// F-80: a second batch into the same folder overwrote patients_manifest.json, and the earlier entries vanished.
describe("patients_manifest.json keeps earlier batches (F-80)", () => {
  const at = (day: number) => `2026-10-0${day}T10:00:00.000Z`;
  const entry = (name: string, fields: Partial<ManifestVariant> = {}): ManifestVariant =>
    ({ name, ok: true, steps: [], created: at(1), base: "D:/Base/Male.ccAvatar", ...fields });
  const run = (variants: ManifestVariant[], fields: Partial<Manifest> = {}): Manifest =>
    ({ created: at(1), base: "D:/Base/Male.ccAvatar", unity_dir: "D:/P/Assets/Pt", variants, ...fields });

  it("keeps the earlier entries and adds a new variant with its own time", () => {
    const merged = mergeManifest(run([entry("A", { fbx: "A.fbx" }), entry("B", { fbx: "B.fbx" })]),
      run([entry("C", { created: at(6), fbx: "C.fbx" })], { created: at(6) }));
    expect(merged.variants.map((v) => [v.name, v.created])).toEqual([["A", at(1)], ["B", at(1)], ["C", at(6)]]);
    expect(merged.created).toBe(at(6));
    expect(mergeManifest(null, run([entry("C")]))).toEqual(run([entry("C")]));
  });

  it("replaces only the variant run again, ignoring case, after the entries it kept", () => {
    const merged = mergeManifest(run([entry("A"), entry("patient_b", { fbx: "old.fbx" }), entry("C")]),
      run([entry("Patient_B", { created: at(6), fbx: "new.fbx" })]));
    expect(merged.variants.map((v) => [v.name, v.fbx])).toEqual([["A", undefined], ["C", undefined], ["Patient_B", "new.fbx"]]);
    expect(merged.variants[2].earlier_export).toBeUndefined();
  });

  it("keeps the way to the last FBX of a variant this run did not export", () => {
    const failed = mergeManifest(run([entry("A", { fbx: "A1.fbx" })]),
      run([entry("A", { created: at(5), ok: false, error: "disk full" })]));
    expect(failed.variants).toEqual([entry("A", { created: at(5), ok: false, error: "disk full",
      earlier_export: { created: at(1), fbx: "A1.fbx" } })]);
    // A later run that did not export it either keeps that older FBX, not nothing.
    const stopped = mergeManifest(failed, run([entry("A", { created: at(6), ok: false, stopped: true })]));
    expect(stopped.variants[0].earlier_export).toEqual({ created: at(1), fbx: "A1.fbx" });
    const again = mergeManifest(stopped, run([entry("A", { created: at(7), fbx: "A2.fbx" })]));
    expect(again.variants[0].earlier_export).toBeUndefined();
  });

  it("drops an earlier run's cancelled and stopped notes, and keeps a hand-written field", () => {
    const earlier = { ...run([entry("A")], { cancelled: "Cancelled by the client. Not started: B.",
      stopped: "Stopped at A: it has skin overlays." }), note: "restored by hand" } as Manifest;
    const merged = mergeManifest(earlier, run([entry("B")], { created: at(6) }));
    expect(merged).toMatchObject({ note: "restored by hand", created: at(6) });
    expect(merged.cancelled).toBeUndefined();
    expect(merged.stopped).toBeUndefined();
    expect(mergeManifest(earlier, run([entry("C")], { stopped: "Stopped at C (export): now" })).stopped)
      .toBe("Stopped at C (export): now");
  });

  describe("readManifest", () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-manifest-"));
      file = path.join(dir, "patients_manifest.json");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("gives null for no file, and an older manifest's entries their run's time and base", () => {
      expect(readManifest(file)).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ created: at(2), base: "D:/Base/Old.ccAvatar", unity_dir: "D:/P/Assets/Pt",
        variants: [{ name: "A", ok: true, steps: [], fbx: "A.fbx" },
          { name: "B", ok: true, steps: [], created: at(3), base: "D:/Base/B.ccAvatar" }] }));
      expect(readManifest(file)?.variants).toEqual([
        { created: at(2), base: "D:/Base/Old.ccAvatar", name: "A", ok: true, steps: [], fbx: "A.fbx" },
        { created: at(3), base: "D:/Base/B.ccAvatar", name: "B", ok: true, steps: [] },
      ]);
    });

    it("throws for a file that is not JSON, or has no variants list of named entries", () => {
      fs.writeFileSync(file, "{ not json");
      expect(() => readManifest(file)).toThrow();
      for (const content of [{ created: at(2) }, { variants: "A" }, { variants: [{ ok: true }] }, ["A"]]) {
        fs.writeFileSync(file, JSON.stringify(content));
        expect(() => readManifest(file)).toThrow("not a batch manifest (no variants list)");
      }
    });

    // RB-5: Windows PowerShell 5's Set-Content -Encoding UTF8 writes a byte-order mark, which JSON.parse refuses.
    it("reads a manifest saved with a UTF-8 byte-order mark", () => {
      const content = JSON.stringify({ created: at(2), base: "D:/Base/Old.ccAvatar", unity_dir: "D:/P/Assets/Pt",
        variants: [{ name: "A", ok: true, steps: [], fbx: "A.fbx" }] });
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]));
      expect(fs.readFileSync(file, "utf8").charCodeAt(0)).toBe(0xfeff);
      expect(readManifest(file)?.variants).toEqual([
        { created: at(2), base: "D:/Base/Old.ccAvatar", name: "A", ok: true, steps: [], fbx: "A.fbx" }]);
    });
  });

  describe("in the tool", () => {
    let p: Project;
    beforeEach(() => { p = makeProject(); });
    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(p.root, { recursive: true, force: true });
    });
    const writeEarlier = (content: unknown) => {
      fs.mkdirSync(p.unityDir, { recursive: true });
      fs.writeFileSync(p.manifestPath, typeof content === "string" ? content : JSON.stringify(content));
    };

    it("adds this batch to the manifest on every write, after the earlier entries", async () => {
      writeEarlier({ created: at(1), base: p.base, unity_dir: p.unityDir, note: "kept",
        variants: [{ name: "Old", ok: true, steps: [], fbx: "Old.fbx" }] });
      const write = vi.spyOn(fs, "writeFileSync");
      const r = await batchHandler()(inProject(p));
      expect(r.isError).toBeUndefined();
      const writes = write.mock.calls.filter(([file]) => file === p.manifestPath)
        .map(([, data]) => (JSON.parse(String(data)) as Manifest).variants.map((v) => v.name));
      expect(writes).toEqual([["Old", "A"], ["Old", "A", "B"]]);
      expect(r.content[0].text.split("\n")[0]).toBe(`2/2 variants exported. Manifest: ${p.manifestPath} The manifest ` +
        "also lists 1 earlier variant(s).");
      expect(readManifest(p.manifestPath)).toMatchObject({ note: "kept",
        variants: [{ name: "Old", fbx: "Old.fbx", created: at(1) }, { name: "A", ok: true }, { name: "B", ok: true }] });
    });

    it("refuses a manifest it cannot read before any CC5 call, and leaves it as it was", async () => {
      writeEarlier("{ not json");
      const r = await batchHandler()(inProject(p));
      expect(r.isError).toBe(true);
      expect(r.content[0].text.startsWith(`${p.manifestPath} exists but cannot be read (`)).toBe(true);
      expect(r.content[0].text.endsWith("): move or fix it first, so its entries are not lost. Nothing was sent to CC5.")).toBe(true);
      expect(bridge.getDialog).not.toHaveBeenCalled();
      expect(bridge.getAvatars).not.toHaveBeenCalled();
      expect(fs.readFileSync(p.manifestPath, "utf8")).toBe("{ not json");
      writeEarlier({ variants: {} });
      expect((await batchHandler()(inProject(p))).content[0].text).toBe(`${p.manifestPath} exists but cannot be read ` +
        "(not a batch manifest (no variants list)): move or fix it first, so its entries are not lost. Nothing was sent to CC5.");
      expect(bridge.startJob).not.toHaveBeenCalled();
    });

    it("adds to a manifest saved with a UTF-8 byte-order mark instead of refusing the batch (RB-5)", async () => {
      // U+FEFF by its code point: an invisible literal in the source is easily lost in an edit.
      writeEarlier(String.fromCharCode(0xfeff) + JSON.stringify({ created: at(1), base: p.base, unity_dir: p.unityDir,
        variants: [{ name: "Old", ok: true, steps: [], fbx: "Old.fbx" }] }));
      expect(fs.readFileSync(p.manifestPath, "utf8").charCodeAt(0)).toBe(0xfeff);
      const r = await batchHandler()(inProject(p));
      expect(r.isError).toBeUndefined();
      expect(readManifest(p.manifestPath)?.variants.map((v) => v.name)).toEqual(["Old", "A", "B"]);
    });

    it("keeps the earlier entries of variants a cancelled run did not reach", async () => {
      writeEarlier({ created: at(1), base: p.base, unity_dir: p.unityDir,
        variants: [{ name: "B", ok: true, steps: [], fbx: "B-old.fbx" }, { name: "Z", ok: true, steps: [], fbx: "Z.fbx" }] });
      const ac = new AbortController();
      bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return ok; });
      const r = await batchHandler()(inProject(p), { signal: ac.signal });
      expect(r.isError).toBe(true);
      const written = readManifest(p.manifestPath);
      expect(written?.cancelled).toBe("Cancelled by the client. Not started: B.");
      expect(written?.variants.map((v) => [v.name, v.fbx])).toEqual([["B", "B-old.fbx"], ["Z", "Z.fbx"], ["A", undefined]]);
    });
  });
});

describe("a batch does not start while CC5 shows a window (D1)", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(p.root, { recursive: true, force: true });
  });

  it("refuses at once with the dialog, sends CC5 nothing and creates no folder", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`${formatDialog(APPLY, null)}\nNothing was sent to CC5: a batch does not start while a ` +
      "CC5 dialog is open. Once it is answered or closed, run batch_generate_patients again.");
    expect(bridge.getDialog).toHaveBeenCalledWith(3000);
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(fs.existsSync(p.unityDir)).toBe(false);
  });

  it("says CC5 is busy when the window is a progress window", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: PROGRESS, waiting_job: "cmd_ab12cd34_9" });
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`${formatDialog(PROGRESS, "cmd_ab12cd34_9")}\nNothing was sent to CC5: a batch does ` +
      "not start while CC5 is busy. When that window has closed, run batch_generate_patients again.");
    expect(r.content[0].text).toContain("CC5 is busy");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
  });

  it("goes ahead when the dialog check itself fails", async () => {
    bridge.getDialog.mockRejectedValue(new Error("No reply from CC5 within 3s."));
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBeUndefined();
    expect(exportsOf()).toHaveLength(2);
  });

  it("releases the scene after a refusal", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });
    expect((await batchHandler()(inProject(p))).isError).toBe(true);
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBeUndefined();
    expect(exportsOf()).toHaveLength(2);
  });

  it("leaves a stopped batch's continue_after alone when it refuses a new batch", async () => {
    const store = eyesAsk();
    await batchHandler()(inProject(p, { variants: eyeVariants }));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_2" });
    const refused = await batchHandler()(inProject(p));
    expect(refused.content[0].text).toContain("Nothing was sent to CC5: a batch does not start while a CC5 dialog is open.");
    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    bridge.setSkinColor.mockResolvedValue(ok);
    const r = await batchHandler()(inProject(p, { variants: eyeVariants, continue_after: "cmd_ab12cd34_2" }));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toContain("Note: the earlier");
  });
});

// Flight 01 (findings 687-689): an export waiting in a CC5 question was recorded as a failed variant, and every later
// variant's first call queued behind it for 30 s, then failed: a 25-minute batch that exported nothing.
describe("runBatch stops on a CC5 question or window (D1)", () => {
  /** Records each stop and gives it an id, as the tool's recordStop does. */
  const stopsInto = (stops: BatchStopDetail[]) => ({
    ...anyFile,
    onStop: (d: BatchStopDetail) => {
      stops.push(d);
      return d.jobId ?? `stop_${stops.length}`;
    },
  });
  const stoppedLine = (step: string, waits: boolean, rest: string) => `Stopped at A (${step}): ` +
    (waits ? "CC5 is waiting for an answer nobody has given yet" : "it could not run while CC5 shows a window nobody has answered") +
    `, so nothing more was sent to CC5. ${rest}`;

  it("stops when a call never started behind an open window (504 and a dialog), and starts nothing else", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new BridgeHttpError(NOT_STARTED, 504));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });
    const stops: BatchStopDetail[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, stopsInto(stops));
    const text = `${NOT_STARTED} ${formatDialog(APPLY, null).split("\n").join(" ")}`;
    expect(m.stopped).toBe(stoppedLine("scene clear", false, 'Not started: B. continue_after: "stop_1".'));
    expect(m.variants).toHaveLength(1);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, stopped: true, steps: [], error: `stopped: ${text}; not exported` });
    expect(bridge.getAvatars).toHaveBeenCalledTimes(1);
    expect(bridge.getDialog).toHaveBeenCalledWith(3000);
    expect(started).toEqual([]);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ variant: "A", phase: "scene", step: "scene clear", ran: false, text, notStarted: ["B"],
      settings: { base_character: "D:/Base/Male.ccAvatar", unity_dir: "D:/P/Assets/Pt", sub_d_level: 0, texture_size: 2048, injuries: "omit" } });
    expect(stops[0].jobId).toBeUndefined();
    expect(stops[0].variantDef).toEqual(BatchSchema.parse(input).variants[0]);
  });

  it("fails the variant on a 504 with no window open, and goes on with the next", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new BridgeHttpError(NOT_STARTED, 504));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
    expect(m.stopped).toBeUndefined();
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, error: NOT_STARTED });
    expect(m.variants[0].stopped).toBeUndefined();
    expect(m.variants[1]).toMatchObject({ name: "B", ok: true });
  });

  it("stops when the open-dialog guard refused the scene clear (400)", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new BridgeHttpError(GUARD, 400));
    const stops: BatchStopDetail[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, stopsInto(stops));
    expect(m.stopped).toBe(stoppedLine("scene clear", false, 'Not started: B. continue_after: "stop_1".'));
    expect(m.variants[0].error).toBe(`stopped: ${GUARD}; not exported`);
    expect(stops[0]).toMatchObject({ phase: "scene", step: "scene clear", ran: false, text: GUARD });
    expect(bridge.getDialog).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it("stops when the base load waits in a question: no recipe step, no export", async () => {
    const store = jobStore((action, params, id) => action === "load_asset" && params.file_path === input.base_character
      ? asking(id, APPLY, waiting(id, "Apply the preset?", "OK, Cancel")) : finished(ok));
    const stops: BatchStopDetail[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, stopsInto(stops));
    expect(m.stopped).toBe(stoppedLine("base load", true, 'Not started: B. continue_after: "cmd_ab12cd34_1".'));
    expect(stops[0]).toMatchObject({ phase: "base", step: "base load", ran: true, jobId: "cmd_ab12cd34_1", question: APPLY,
      waitMs: 300_000, text: waiting("cmd_ab12cd34_1", "Apply the preset?", "OK, Cancel") });
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();
    expect(store.started.map((j) => j.action)).toEqual(["load_asset"]);
  });

  it("stops when the open-dialog guard failed the base load: the continuation clears the scene again", async () => {
    jobStore((action) => action === "load_asset" ? { status: "failed", result: { success: false, error: GUARD } } : finished(ok));
    const stops: BatchStopDetail[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, stopsInto(stops));
    expect(m.stopped).toBe(stoppedLine("base load", false, 'Not started: B. continue_after: "stop_1".'));
    expect(stops[0]).toMatchObject({ phase: "scene", step: "base load", ran: false, text: GUARD });
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();
  });

  it("stops when a recipe step's load waits in a question, and keeps what is left of the recipe", async () => {
    const store = jobStore((_action, params, id) => String(params.file_path).endsWith(".ccEye") ? asking(id) : finished(ok));
    const stops: BatchStopDetail[] = [];
    const variants = [{ name: "A", recipe: { assets: [EYES], skin_condition: { condition: "pale" as const, amount: 0.5 } } },
      input.variants[1]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants }, () => undefined, stopsInto(stops));
    expect(m.stopped).toBe(stoppedLine("asset Eyes_01.ccEye", true, 'Not started: B. continue_after: "cmd_ab12cd34_2".'));
    expect(m.variants[0]).toMatchObject({ stopped: true, error: `stopped: ${waiting("cmd_ab12cd34_2")}; not exported` });
    expect(m.variants[0].steps).toEqual([expect.objectContaining({ step: "asset Eyes_01.ccEye", ok: false })]);
    expect(stops[0]).toMatchObject({ phase: "recipe", step: "asset Eyes_01.ccEye", ran: true, jobId: "cmd_ab12cd34_2",
      question: LAYER, asset: EYES, waitMs: 120_000, remaining: { skin_condition: { condition: "pale", amount: 0.5 } } });
    expect(stops[0].steps).toBe(m.variants[0].steps);
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();
    expect(store.started.map((j) => j.action)).toEqual(["load_asset", "load_asset"]);
  });

  it("stops when the export waits in a question: no budget check, and the later variants are not started", async () => {
    const question = waiting("cmd_ab12cd34_7", "Overwrite?", "Yes, No");
    bridge.startJob.mockImplementation(async (action: string) => ({ job_id: action === "export_for_unity" ? "cmd_ab12cd34_7" : "cmd_ab12cd34_1" }));
    bridge.getJob.mockImplementation(async (id: string) => id === "cmd_ab12cd34_7"
      ? { job_id: id, action: "export_for_unity", status: "running", dialog: OVERWRITE, dialog_message: question }
      : { job_id: id, action: "load_asset", status: "done", result: ok });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
    expect(m.variants).toHaveLength(1);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, stopped: true, error: `stopped: ${question}; not exported` });
    expect(m.stopped).toBe(stoppedLine("export", true, "Not started: B."));
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
    expect(bridge.getAvatars).toHaveBeenCalledTimes(1);
  });

  it("stops when the open-dialog guard failed the export job: it never ran", async () => {
    exportResults.push({ success: false, error: GUARD });
    const stops: BatchStopDetail[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, stopsInto(stops));
    expect(m.stopped).toBe(stoppedLine("export", false, 'Not started: B. continue_after: "stop_1".'));
    expect(stops[0]).toMatchObject({ phase: "export", step: "export", ran: false, text: GUARD });
    expect(stops[0].exported).toBeUndefined();
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
  });

  it("stops at the budget check when a window blocks the stats, keeping the finished export", async () => {
    bridge.getMeshStats.mockRejectedValueOnce(new BridgeHttpError(GUARD, 400));
    const stops: BatchStopDetail[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, stopsInto(stops));
    expect(m.stopped).toBe(stoppedLine("budget check", false, 'Not started: B. continue_after: "stop_1".'));
    expect(m.variants[0]).toMatchObject({ stopped: true, fbx: "D:/P/Assets/Pt/A/A.fbx",
      error: `stopped: ${GUARD}; exported, but the Quest budget was not checked` });
    expect(stops[0]).toMatchObject({ phase: "export", step: "budget check", ran: false });
    expect(stops[0].jobId).toBeUndefined();
    expect(stops[0].exported).toMatchObject({ done: true, failed: false, result: { fbx: "D:/P/Assets/Pt/A/A.fbx" } });
    expect(exportsOf()).toHaveLength(1);
  });

  it("refuses to go on with a variant that is not listed first, before any CC5 call", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runBatch(bridge as any, input, () => undefined, { ...anyFile, resume: { variant: "B", phase: "export", steps: [] } }))
      .rejects.toThrow("The batch goes on with variant B, so that variant must come first (not A).");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
  });
});

describe("batch_generate_patients goes on after the answer (continue_after)", () => {
  let p: Project;
  beforeEach(() => {
    p = makeProject();
    bridge.setSkinColor.mockResolvedValue(ok);
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  const eyeArgs = () => inProject(p, { variants: eyeVariants });
  const NOT_THERE = "continue_after cmd_ab12cd34_2 is not where the last batch stopped (or the MCP server restarted): " +
    "run the variants not finished as a new batch. Nothing was sent to CC5.";

  it("stops at the question with the continue_after call, then finishes that variant from there and runs the rest", async () => {
    const store = eyesAsk();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const first = await batchHandler()(eyeArgs(), { signal: new AbortController().signal, _meta: { progressToken: 1 }, sendNotification });
    expect(first.isError).toBe(true);
    expect(first.content[0].text.split("\n")).toEqual([
      "Stopped at A (asset Eyes_01.ccEye): CC5 is waiting for an answer nobody has given yet, so nothing more was sent " +
        'to CC5. Not started: B. continue_after: "cmd_ab12cd34_2".',
      `0/1 variants exported. Manifest: ${p.manifestPath}`,
      `WAIT A: stopped: ${waiting("cmd_ab12cd34_2")}; not exported`,
      "To go on after the answer: call batch_generate_patients again with the same base_character, unity_dir, " +
        'sub_d_level, texture_size and injuries, continue_after "cmd_ab12cd34_2", and these variants: A first and ' +
        "unchanged (it is finished from where it stopped; its recipe is not run again), then B.",
      "This is a real choice: show the user the question and buttons with your recommendation; answer it with " +
        "answer_cc5_dialog(<button>, expect: 'target object layer already exists'); then go on with layer_answer set to " +
        "that button: it answers the same question for the rest of this batch only. If the user picked Cancel, go on " +
        "with continue_after and no layer_answer: a Cancel is not carried, and the next identical question goes to the " +
        "user again.",
    ]);
    expect(sendNotification.mock.calls.map(([n]) => n.params.message)).toEqual(["A (1/2): WAIT asset Eyes_01.ccEye", "A (1/2): stopped"]);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(store.started.map((j) => j.action)).toEqual(["load_asset", "load_asset"]);
    expect(readManifest(p.manifestPath)?.stopped).toContain('continue_after: "cmd_ab12cd34_2"');

    store.set("cmd_ab12cd34_2", loadedEye(EYES));  // the user answered in CC5: the eye load finished
    const progress = vi.fn().mockResolvedValue(undefined);
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" },
      { signal: new AbortController().signal, _meta: { progressToken: 2 }, sendNotification: progress });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n").slice(0, 3)).toEqual([
      `2/2 variants exported. Manifest: ${p.manifestPath}`, "OK   A", "OK   B (the base, unchanged on purpose)"]);
    expect(progress.mock.calls.map(([n]) => n.params.message)).toEqual([
      "A: waiting for job cmd_ab12cd34_2 (after the answer)", "A (1/2): OK skin_rgb", "A (1/2): done", "B (2/2): done"]);
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
    expect(store.started.map((j) => j.action)).toEqual(["load_asset", "load_asset", "export_for_unity", "load_asset", "export_for_unity"]);
    expect(store.started.filter((j) => j.params.file_path === EYES)).toHaveLength(1);
    const written = readManifest(p.manifestPath);
    expect(written?.stopped).toBeUndefined();
    expect(written?.variants.map((v) => [v.name, v.ok])).toEqual([["A", true], ["B", true]]);
    expect(written?.variants[0].steps.map((s) => s.step)).toEqual(["asset Eyes_01.ccEye (after the answer)", "skin_rgb"]);

    // A finished batch cannot be continued.
    expect((await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" })).content[0].text).toBe(NOT_THERE);
  });

  it("uses the export that finished after the answer: no second export, then the budget check", async () => {
    const store = jobStore((action, _params, id) => action === "export_for_unity"
      ? asking(id, OVERWRITE, waiting(id, "Overwrite?", "Yes, No")) : finished(ok));
    const args = inProject(p, { variants: [input.variants[0]] });
    const first = await batchHandler()(args);
    expect(first.content[0].text.split("\n")[0]).toBe("Stopped at A (export): CC5 is waiting for an answer nobody has " +
      'given yet, so nothing more was sent to CC5. Not started: none. continue_after: "cmd_ab12cd34_2".');
    expect(first.content[0].text).toContain("its recipe is not run again), then nothing else.");
    expect(first.content[0].text).not.toContain("This is a real choice");
    expect(bridge.getMeshStats).not.toHaveBeenCalled();

    store.set("cmd_ab12cd34_2", finished(exported("A")));
    const r = await batchHandler()({ ...args, continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(store.started.filter((j) => j.action === "export_for_unity")).toHaveLength(1);
    expect(bridge.getMeshStats).toHaveBeenCalledTimes(1);
    expect(bridge.setSkinCondition).toHaveBeenCalledTimes(1);
    expect(readManifest(p.manifestPath)?.variants[0]).toMatchObject({ name: "A", ok: true, fbx: "D:/P/Assets/Pt/A/A.fbx", budget_pass: true });
  });

  it("goes on after a base load that waited in a question: no second load, then the whole recipe", async () => {
    const store = jobStore((action, params, id) => action === "load_asset"
      ? asking(id, APPLY, waiting(id, "Apply the preset?", "OK, Cancel"))
      : finished(exported(String(params.character_name))));
    const args = inProject(p, { variants: [input.variants[0]] });
    const first = await batchHandler()(args);
    expect(first.content[0].text.split("\n")[0]).toBe("Stopped at A (base load): CC5 is waiting for an answer nobody " +
      'has given yet, so nothing more was sent to CC5. Not started: none. continue_after: "cmd_ab12cd34_1".');
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();

    store.set("cmd_ab12cd34_1", finished(ok));
    const r = await batchHandler()({ ...args, continue_after: "cmd_ab12cd34_1" });
    expect(r.isError).toBeUndefined();
    expect(store.started.map((j) => j.action)).toEqual(["load_asset", "export_for_unity"]);
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);
    expect(bridge.setSkinCondition).toHaveBeenCalledTimes(1);
  });

  it("waits for a scene clear that waited in a question, then clears the scene again", async () => {
    const text = waiting("cmd_ab12cd34_9", "Delete Old?", "OK, Cancel");
    bridge.deleteAvatar.mockRejectedValueOnce(new BridgeHttpError(text, 409));
    bridge.getJob.mockResolvedValueOnce({ job_id: "cmd_ab12cd34_9", action: "delete_avatar", status: "running", dialog: APPLY, dialog_message: text });
    const first = await batchHandler()(inProject(p));
    expect(first.content[0].text.split("\n")[0]).toBe("Stopped at A (scene clear): CC5 is waiting for an answer nobody " +
      'has given yet, so nothing more was sent to CC5. Not started: B. continue_after: "cmd_ab12cd34_9".');
    expect(bridge.getJob).toHaveBeenCalledTimes(1);
    expect(started).toEqual([]);

    bridge.getJob.mockResolvedValueOnce({ job_id: "cmd_ab12cd34_9", action: "delete_avatar", status: "done", result: ok });
    const r = await batchHandler()({ ...inProject(p), continue_after: "cmd_ab12cd34_9" });
    expect(r.isError).toBeUndefined();
    // The stopped clear, then A's and B's: a stop in the scene clear has no one-character check, it starts it again.
    expect(bridge.getAvatars).toHaveBeenCalledTimes(3);
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(3);
    expect(baseLoads()).toHaveLength(2);
  });

  it("runs the scene clear again after a window kept it from running", async () => {
    bridge.getAvatars.mockRejectedValueOnce(new BridgeHttpError(GUARD, 400));
    const args = inProject(p, { variants: [input.variants[0]] });
    const first = await batchHandler()(args);
    const id = continueId(first.content[0].text);
    expect(id).toMatch(/^stop_\d+$/);
    expect(first.content[0].text).toContain(`\nWAIT A: stopped: ${GUARD}; not exported\n`);
    expect(started).toEqual([]);
    const r = await batchHandler()({ ...args, continue_after: id });
    expect(r.isError).toBeUndefined();
    expect(bridge.getAvatars).toHaveBeenCalledTimes(2);
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(baseLoads()).toHaveLength(1);
  });

  it("reads the budget again after a window blocked it, without a second export", async () => {
    bridge.getMeshStats.mockRejectedValueOnce(new BridgeHttpError(GUARD, 400));
    const args = inProject(p, { variants: [input.variants[0]] });
    const first = await batchHandler()(args);
    expect(first.content[0].text.split("\n")[0]).toMatch(new RegExp("^Stopped at A \\(budget check\\): it could not run " +
      "while CC5 shows a window nobody has answered, so nothing more was sent to CC5\\. Not started: none\\. " +
      'continue_after: "stop_\\d+"\\.$'));
    const r = await batchHandler()({ ...args, continue_after: continueId(first.content[0].text) });
    expect(r.isError).toBeUndefined();
    expect(exportsOf()).toHaveLength(1);
    expect(bridge.getMeshStats).toHaveBeenCalledTimes(2);
    expect(bridge.getAvatars).toHaveBeenCalledTimes(2);  // A's scene clear, then the check that only A is in the scene
    expect(readManifest(p.manifestPath)?.variants[0]).toMatchObject({ ok: true, budget_pass: true, fbx: "D:/P/Assets/Pt/A/A.fbx" });
  });

  it("goes on after a question whose job CC5 did not name, and reports that step as not known", async () => {
    const asked = 'CC5 is waiting for an answer to "Apply the skin colour?".';
    bridge.setSkinColor.mockRejectedValueOnce(new BridgeHttpError(asked, 409));
    const args = inProject(p, { variants: [{ name: "A", recipe: { skin_rgb: RGB, pose_file: "C:/p/Supine.rlMotion" } }] });
    const first = await batchHandler()(args);
    const id = continueId(first.content[0].text);
    expect(id).toMatch(/^stop_\d+$/);
    expect(first.content[0].text.split("\n")[0]).toBe("Stopped at A (skin_rgb): it could not run while CC5 shows a " +
      `window nobody has answered, so nothing more was sent to CC5. Not started: none. continue_after: "${id}".`);
    expect(started.map((j) => j.action)).toEqual(["load_asset"]);

    const r = await batchHandler()({ ...args, continue_after: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.split("\n")).toContain("FAIL A");
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);  // CC5 ran it under the question: not sent again
    expect(started.map((j) => j.action)).toEqual(["load_asset", "apply_pose", "export_for_unity"]);
    expect(readManifest(p.manifestPath)?.variants[0].steps).toEqual([
      { step: "skin_rgb (after the answer)", ok: false,
        detail: "its job id is unknown: check the scene (list_clothes, capture_viewport) before relying on it" },
      { step: "pose_file", ok: true, detail: "" },
    ]);
  });

  it("refuses a continuation while CC5 still asks, keeps the stop, and goes on after the answer", async () => {
    const store = eyesAsk();
    await batchHandler()(eyeArgs());
    const still = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(still.isError).toBe(true);
    expect(still.content[0].text).toBe(`${waiting("cmd_ab12cd34_2")}\nAnswer it first, then call batch_generate_patients ` +
      'with continue_after "cmd_ab12cd34_2" again. Nothing else was sent to CC5.');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(bridge.getDialog).toHaveBeenCalledTimes(1);  // the first batch's check only

    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    expect((await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" })).isError).toBeUndefined();
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
  });

  it("refuses a continuation while another CC5 window is open, and keeps the stop", async () => {
    const store = eyesAsk();
    await batchHandler()(eyeArgs());
    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`${formatDialog(APPLY, null)}\nNothing was sent to CC5: a batch does not start while a ` +
      'CC5 dialog is open. Once it is answered or closed, call batch_generate_patients with continue_after "cmd_ab12cd34_2" again.');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    expect((await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" })).isError).toBeUndefined();
  });

  it("refuses an unknown continue_after without any CC5 call", async () => {
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "stop_999999" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("continue_after stop_999999 is not where the last batch stopped (or the MCP server " +
      "restarted): run the variants not finished as a new batch. Nothing was sent to CC5.");
    for (const call of [bridge.getDialog, bridge.getAvatars, bridge.getJob, bridge.startJob]) expect(call).not.toHaveBeenCalled();
    expect(fs.existsSync(p.unityDir)).toBe(false);
  });

  it("refuses a continuation whose first variant, its recipe or the batch settings differ, before any CC5 call", async () => {
    const store = eyesAsk();
    await batchHandler()(eyeArgs());
    const calls = () => [bridge.getDialog, bridge.getAvatars, bridge.getJob, bridge.startJob].map((f) => f.mock.calls.length);
    const before = calls();
    const cont = { ...eyeArgs(), continue_after: "cmd_ab12cd34_2" };
    const swapped = await batchHandler()({ ...cont, variants: [eyeVariants[1], eyeVariants[0]] });
    expect(swapped.content[0].text).toBe("continue_after cmd_ab12cd34_2 belongs to variant A: list it first, then the " +
      "variants not started (B). Nothing was sent to CC5.");
    const changed = await batchHandler()({ ...cont, variants: [{ name: "A", recipe: { assets: [EYES] } }, eyeVariants[1]] });
    expect(changed.content[0].text).toBe("continue_after cmd_ab12cd34_2 finishes variant A as it was when the batch " +
      "stopped, and its recipe or settings differ now: pass it unchanged, or run it as a new batch without continue_after. " +
      "Nothing was sent to CC5.");
    const otherDir = path.join(p.root, "Assets", "Other");
    const moved = await batchHandler()({ ...cont, unity_dir: otherDir });
    expect(moved.content[0].text).toBe("continue_after cmd_ab12cd34_2 goes on with the batch settings it stopped with; " +
      "unity_dir differs now. Nothing was sent to CC5.");
    const sizes = await batchHandler()({ ...cont, sub_d_level: 1, texture_size: 1024 });
    expect(sizes.content[0].text).toBe("continue_after cmd_ab12cd34_2 goes on with the batch settings it stopped with; " +
      "sub_d_level, texture_size differ now. Nothing was sent to CC5.");
    expect(calls()).toEqual(before);
    expect(fs.existsSync(otherDir)).toBe(false);

    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    expect((await batchHandler()(cont)).isError).toBeUndefined();  // the refusals kept the stop
  });

  it("refuses to finish a variant in a scene that changed during the pause, and forgets the stop", async () => {
    const store = eyesAsk();
    await batchHandler()(eyeArgs());
    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    bridge.getAvatars.mockRejectedValueOnce(new BridgeHttpError("CC5 is not ready", 500));
    const unread = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(unread.content[0].text).toBe("CC5 bridge error: CC5 is not ready");  // the stop is kept

    bridge.getAvatars.mockResolvedValue([{ name: "Old", id: 1, type: "avatar" }, { name: "Kevin", id: 2, type: "avatar" }]);
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("The scene holds 2 characters now, not just variant A: it changed while the batch was " +
      "stopped, so A cannot be finished from where it stopped. Run A and the variants not started (B) as a new batch, " +
      "without continue_after. Nothing was changed in CC5.");
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);  // the first run's scene clear only
    expect((await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" })).content[0].text).toBe(NOT_THERE);
  });

  it("finishes a variant whose own base step a window kept from running, in the scene that step emptied", async () => {
    // The variant's base step deleted the character, then the open-dialog guard failed its load: the scene holds no
    // character when the batch goes on, and the continuation runs that base step again.
    const variantBase = path.join(p.root, "Variant.ccAvatar");
    fs.writeFileSync(variantBase, "saved variant base");
    let failed = false;
    const store = jobStore((action, params) => {
      if (action === "export_for_unity") return finished(exported(String(params.character_name)));
      if (action === "load_asset" && params.file_path === variantBase && !failed) {
        failed = true;
        return finished({ success: false, error: GUARD });
      }
      return finished(ok);
    });
    const args = inProject(p, { variants: [{ name: "A", recipe: { base: variantBase, skin_rgb: RGB } }] });
    const first = await batchHandler()(args);
    expect(first.isError).toBe(true);
    const id = continueId(first.content[0].text);
    expect(id).toMatch(/^stop_\d+$/);
    expect(first.content[0].text).toContain(GUARD);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    bridge.getAvatars.mockResolvedValue([]);
    const r = await batchHandler()({ ...args, continue_after: id });
    expect(r.isError).toBeUndefined();
    expect(store.started.filter((j) => j.params.file_path === variantBase)).toHaveLength(2);
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
    expect(readManifest(p.manifestPath)?.variants[0]).toMatchObject({ name: "A", ok: true });
  });

  it("forgets the stop when CC5 lost the job, and says how to go on", async () => {
    eyesAsk();
    await batchHandler()(eyeArgs());
    bridge.getJob.mockRejectedValue(new BridgeHttpError("Unknown job: cmd_ab12cd34_2", 404));
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Job cmd_ab12cd34_2 not found. CC5 was probably restarted and the job's result is " +
      "lost. Check the output folder, then run the operation again. The batch stop is forgotten: run A and the variants " +
      "not started (B) as a new batch.");
    expect((await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" })).content[0].text).toBe(NOT_THERE);
  });

  it("keeps the stop when the client cancels the wait, or the stopped step is still running", async () => {
    const store = eyesAsk();
    await batchHandler()(eyeArgs());
    store.set("cmd_ab12cd34_2", { status: "running" });
    const ac = new AbortController();
    bridge.getJob.mockImplementationOnce(async (id: string) => {
      ac.abort();
      return { job_id: id, action: "load_asset", status: "running" };
    });
    const cancelled = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" }, { signal: ac.signal });
    expect(cancelled.content[0].text).toBe('Cancelled by the client: nothing else was sent to CC5; continue_after ' +
      '"cmd_ab12cd34_2" still works.');

    vi.useFakeTimers();
    const pending = batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    await vi.advanceTimersByTimeAsync(200_000);
    const running = await pending;
    vi.useRealTimers();
    expect(running.content[0].text).toBe("Variant A: asset Eyes_01.ccEye is still running in CC5 (job cmd_ab12cd34_2). " +
      'Wait for it (job_status "cmd_ab12cd34_2"), then call batch_generate_patients with continue_after "cmd_ab12cd34_2" ' +
      "again. Nothing else was sent to CC5.");
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    expect((await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" })).isError).toBeUndefined();
  });

  // RB-3: the continuation's wait clicked the user's button, then a check refused to go on; the retry lost the click.
  it("names the button its wait clicked in the step after the answer, also when the first try was refused", async () => {
    const store = eyesAsk();
    await batchHandler()(eyeArgs());  // stops at A's eye preset (cmd_ab12cd34_2); the user picks Replace
    bridge.answerDialog.mockImplementation(async (button: string) => {
      store.set("cmd_ab12cd34_2", loadedEye(EYES));  // the batch's click answers it and the load finishes
      return { success: true, clicked: button, dialog: LAYER };
    });
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });  // another window is open
    vi.useFakeTimers();
    let refused: Awaited<ReturnType<ReturnType<typeof batchHandler>>>;
    try {
      const pending = batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2", layer_answer: "Replace" });
      await vi.advanceTimersByTimeAsync(5_000);
      refused = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("Nothing was sent to CC5: a batch does not start while a CC5 dialog is open.");
    expect(bridge.answerDialog).toHaveBeenCalledWith("Replace", LAYER_EXPECT);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(readManifest(p.manifestPath)?.variants[0].steps[0]).toMatchObject({ step: "asset Eyes_01.ccEye (after the answer)",
      ok: true, detail: "CC5 asked 'Replace / Material Only'; answered 'Replace' (the user's answer earlier in this run)" });
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
  });

  // RB-4: a manifest write that threw ended the batch with only the file-system error, and the stop was forgotten.
  it("keeps a stop when patients_manifest.json cannot be written, and says the file does not show this run", async () => {
    const store = eyesAsk();
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((file) => {
      if (file === p.manifestPath) throw new Error("EBUSY: resource busy or locked");
    });
    let first: Awaited<ReturnType<ReturnType<typeof batchHandler>>>;
    try {
      first = await batchHandler()(eyeArgs());
    } finally {
      write.mockRestore();
    }
    expect(first.isError).toBe(true);
    const lines = first.content[0].text.split("\n");
    expect(lines[0]).toBe("Stopped at A (asset Eyes_01.ccEye): CC5 is waiting for an answer nobody has given yet, so " +
      'nothing more was sent to CC5. Not started: B. continue_after: "cmd_ab12cd34_2".');
    expect(lines).toContain("patients_manifest.json could not be written (EBUSY: resource busy or locked): it does not show " +
      "this run.");
    expect(first.content[0].text).toContain('continue_after "cmd_ab12cd34_2", and these variants: A first and unchanged');
    expect(fs.existsSync(p.manifestPath)).toBe(false);

    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toContain("could not be written");
    expect(readManifest(p.manifestPath)?.variants.map((v) => [v.name, v.ok])).toEqual([["A", true], ["B", true]]);
  });

  it("keeps a stop it recorded when the run fails after it, and says how to go on (RB-4)", async () => {
    const store = eyesAsk();
    // The client's connection breaks when the batch reports its stop.
    const sendNotification = vi.fn((n: { params: { message?: string } }) => {
      if (String(n.params.message).endsWith(": stopped")) throw new Error("transport closed");
      return Promise.resolve();
    });
    const first = await batchHandler()(eyeArgs(), { signal: new AbortController().signal, _meta: { progressToken: 1 }, sendNotification });
    expect(first.isError).toBe(true);
    expect(first.content[0].text.split("\n")).toEqual([
      "transport closed",
      `The batch had stopped at asset Eyes_01.ccEye before that: ${waiting("cmd_ab12cd34_2")}`,
      'After the answer, call batch_generate_patients with continue_after "cmd_ab12cd34_2".',
    ]);

    store.set("cmd_ab12cd34_2", loadedEye(EYES));
    const r = await batchHandler()({ ...eyeArgs(), continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(readManifest(p.manifestPath)?.variants.map((v) => [v.name, v.ok])).toEqual([["A", true], ["B", true]]);
  });

  it("no longer counts a preset's skin-colour CHECK from before the stop once skin_rgb ran after it", async () => {
    const store = jobStore((action, params, id) => {
      if (action === "export_for_unity") return finished(exported(String(params.character_name)));
      if (params.file_path === RED_VELVET) return finished({ success: true, path: RED_VELVET, target: "Old", changes: changes([SKIN_FACT]) });
      return String(params.file_path).endsWith(".ccEye") ? asking(id) : finished(ok);
    });
    const args = inProject(p, { variants: [{ name: "A", recipe: { assets: [RED_VELVET, EYES], skin_rgb: RGB } }] });
    const first = await batchHandler()(args);
    expect(first.content[0].text.split("\n")[0]).toMatch(/^Stopped at A \(asset Eyes_01\.ccEye\)/);
    expect(readManifest(p.manifestPath)?.variants[0].steps[0].checks?.[0]).toMatch(/^skin colour on Std_Skin_Head/);

    store.set("cmd_ab12cd34_3", loadedEye(EYES));
    const r = await batchHandler()({ ...args, continue_after: "cmd_ab12cd34_3" });
    expect(r.isError).toBeUndefined();
    const a = readManifest(p.manifestPath)?.variants[0];
    expect(a).toMatchObject({ name: "A", ok: true });
    expect(a?.checks).toBeUndefined();
    expect(a?.steps.map((s) => s.step)).toEqual(["asset Red Velvet.ccSkinGenPreset", "asset Eyes_01.ccEye (after the answer)", "skin_rgb"]);
    expect(a?.steps[0].superseded?.[0]).toContain("set again by skin_rgb later in this recipe");
  });
});

describe("Replace / Material Only in a batch (D3)", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  const twoEyes = () => inProject(p, { variants: [{ name: "A", recipe: { assets: [EYES] } }, { name: "B", recipe: { assets: [EYES] } }] });
  const OTHER_QUESTION = "layer_answer answers only CC5's 'Replace / Material Only' question, and this run stopped on a " +
    "different one. Go on without layer_answer. Nothing was sent to CC5.";

  it("refuses layer_answer without continue_after: there is no standing answer", async () => {
    const r = await batchHandler()({ ...twoEyes(), layer_answer: "Replace" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("layer_answer only goes on after a batch stopped on CC5's 'Replace / Material Only' " +
      "question (with continue_after). There is no standing answer: run the batch without it; if CC5 asks, the batch " +
      "stops and the question goes to the user. Nothing was sent to CC5.");
    expect(bridge.getDialog).not.toHaveBeenCalled();
    expect(bridge.getAvatars).not.toHaveBeenCalled();
  });

  it("answers the same question in later variants with the user's button, and a new batch asks again", async () => {
    const store = eyesAsk();
    bridge.answerDialog.mockImplementation(async (button: string) => {
      const asked = store.started[store.started.length - 1];
      store.set(asked.id, loadedEye(String(asked.params.file_path)));  // CC5 takes the click and the load finishes
      return { success: true, clicked: button, dialog: LAYER };
    });
    const first = await batchHandler()(twoEyes());
    expect(first.content[0].text.split("\n")[0]).toMatch(/^Stopped at A \(asset Eyes_01\.ccEye\)/);
    expect(first.content[0].text).toContain("it answers the same question for the rest of this batch only.");
    store.set("cmd_ab12cd34_2", loadedEye(EYES));  // the user picked Material Only and it was answered

    vi.useFakeTimers();
    const pending = batchHandler()({ ...twoEyes(), continue_after: "cmd_ab12cd34_2", layer_answer: "Material Only" });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await pending;
    vi.useRealTimers();
    expect(r.isError).toBeUndefined();
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
    expect(bridge.answerDialog).toHaveBeenCalledWith("Material Only", LAYER_EXPECT);
    const written = readManifest(p.manifestPath);
    expect(written?.variants[1]).toMatchObject({ name: "B", ok: true });
    // The manifest names each answer the batch gave for the user.
    expect(written?.variants[1].steps[0]).toMatchObject({ step: "asset Eyes_01.ccEye", ok: true,
      detail: "CC5 asked 'Replace / Material Only'; answered 'Material Only' (the user's answer earlier in this run)" });

    const again = await batchHandler()(twoEyes());
    expect(again.content[0].text.split("\n")[0]).toMatch(/^Stopped at A \(asset Eyes_01\.ccEye\)/);
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
  });

  it("refuses layer_answer after a stop on another question", async () => {
    jobStore((action, params, id) => {
      if (action === "export_for_unity") return finished(exported(String(params.character_name)));
      return String(params.file_path).endsWith(".ccEye") ? asking(id, APPLY, waiting(id, "Apply the preset?", "OK, Cancel")) : finished(ok);
    });
    const first = await batchHandler()(twoEyes());
    expect(first.content[0].text).not.toContain("This is a real choice");
    const r = await batchHandler()({ ...twoEyes(), continue_after: "cmd_ab12cd34_2", layer_answer: "Replace" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(OTHER_QUESTION);
    expect(bridge.getDialog).toHaveBeenCalledTimes(1);  // the first batch's check only
  });

  it("does not take a layer question another job is queued behind as the batch's own question", async () => {
    jobStore((action, params, id) => {
      if (action === "export_for_unity") return finished(exported(String(params.character_name)));
      return String(params.file_path).endsWith(".ccEye")
        ? { status: "queued", dialog: LAYER, dialog_message: waiting("cmd_ab12cd34_99"), blocked_by: "cmd_ab12cd34_99" }
        : finished(ok);
    });
    const first = await batchHandler()(twoEyes());
    expect(first.content[0].text).toContain('continue_after "cmd_ab12cd34_2"');
    expect(first.content[0].text).not.toContain("This is a real choice");
    const r = await batchHandler()({ ...twoEyes(), continue_after: "cmd_ab12cd34_2", layer_answer: "Material Only" });
    expect(r.content[0].text).toBe(OTHER_QUESTION);
  });

  it("notes a stop that a new batch replaced, last", async () => {
    eyesAsk();
    await batchHandler()(twoEyes());
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n").at(-1)).toBe("Note: the earlier batch that stopped at asset Eyes_01.ccEye " +
      '(continue_after "cmd_ab12cd34_2") was not continued; that stop is forgotten.');
    expect((await batchHandler()({ ...twoEyes(), continue_after: "cmd_ab12cd34_2" })).content[0].text)
      .toContain("is not where the last batch stopped");
  });
});

// F-75: an FBX carries neither a Diffuse Blend overlay nor the skin shader's pallor; the user picks, with no default.
describe("skin overlays and skin conditions in a batch (F-75)", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => fs.rmSync(p.root, { recursive: true, force: true }));
  const ARM = "overlay.png on Std_Skin_Arm (Diffuse Blend overlay at 60%)";
  const noChoice = (variants: unknown[]) => ({ base_character: p.base, unity_dir: p.unityDir, variants });

  it("refuses variants with overlays, a diffuse_blend texture or a pale skin and no injuries choice, before any CC5 call", async () => {
    const overlay = { name: "Bruised", recipe: { overlays: [{ image_path: "C:/o/bruise.png", strength: 60 }] } };
    const blend = { name: "Cut", recipe: { textures: [{ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Arm",
      channel: "diffuse_blend", image_path: "C:/t/cut.png" }] } };
    const pale = { name: "Pale", recipe: { skin_condition: { condition: "pale", amount: 0.4 } } };
    const r = await batchHandler()(noChoice([overlay, blend, pale, { name: "Tinted", recipe: { skin_rgb: RGB } }]));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Choose injuries ('bake', 'separate' or 'omit') for this batch or for variants " +
      "Bruised, Cut, Pale: they add skin overlays, a diffuse_blend texture or a pale skin condition, which an FBX cannot " +
      "carry. Ask the user, then run the batch again. Nothing was sent to CC5.");
    for (const call of [bridge.getDialog, bridge.getAvatars, bridge.startJob]) expect(call).not.toHaveBeenCalled();
    expect(fs.existsSync(p.unityDir)).toBe(false);
  });

  it("takes a variant's own choice, and needs none for a pale skin or an overlay at 0; no choice is sent then", async () => {
    bridge.applySkinOverlay.mockResolvedValue(ok);
    const r = await batchHandler()(noChoice([
      { name: "Bruised", recipe: { overlays: [{ image_path: "C:/o/bruise.png", strength: 60 }] }, injuries: "separate" },
      { name: "Calm", recipe: { skin_condition: { condition: "pale", amount: 0 }, overlays: [{ image_path: "C:/o/bruise.png", strength: 0 }] } },
    ]));
    expect(r.isError).toBeUndefined();
    expect(exportsOf().map((j) => j.params.injuries)).toEqual(["separate", undefined]);
    expect(exportsOf()[1].params).not.toHaveProperty("injuries");
  });

  it("sends a variant's own injuries over the batch's", async () => {
    const variants = [{ ...input.variants[0], injuries: "bake" as const }, input.variants[1]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBatch(bridge as any, { ...input, variants }, () => undefined, anyFile);
    expect(exportsOf().map((j) => j.params.injuries)).toEqual(["bake", "omit"]);
  });

  it("stops when an export needs an injuries choice: the question goes to the user, and nothing more is exported", async () => {
    const report = noInjuries({ choice: null, not_carried: [ARM] });
    exportResults.push({ success: false, needs_choice: true, injuries: report,
      error: "Not exported: this character has skin overlays or a skin condition that an FBX cannot carry." });
    bridge.setSkinColor.mockResolvedValue(ok);
    const variants = [{ name: "A", recipe: { skin_rgb: RGB } }, { name: "B", recipe: {}, export_base_unchanged: true }];
    const r = await batchHandler()(noChoice(variants));
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text.split("\n")[0]).toBe("Stopped at A: it has skin overlays or a skin condition and no injuries choice was " +
      "given, so it was not exported. Not started: B.");
    // TS-4: the variant's question ends with the batch's way on, not with export_for_unity (which skips the batch).
    const question = injuryQuestion(report, "then run batch_generate_patients again with injuries (or this variant's own " +
      "injuries) and the variants not finished");
    expect(text).toContain(`\nFAIL A: ${question}\n`);
    expect(text).not.toContain("export_for_unity");
    expect(text).toContain("To go on: ask the user how skin overlays and skin conditions should reach Unity for these " +
      "patients ('bake', 'separate' or 'omit'; there is no default), then run batch_generate_patients again with injuries " +
      "(or a variant's own injuries) and the variants not finished: A, B.");
    expect(text).not.toContain("continue_after");
    const written = readManifest(p.manifestPath);
    expect(written?.variants).toHaveLength(1);
    expect(written?.variants[0]).toMatchObject({ name: "A", ok: false, error: question });
    expect(written?.variants[0].stopped).toBeUndefined();
    expect(written?.stopped).toBe(text.split("\n")[0]);
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
    expect(exportsOf()).toHaveLength(1);
    expect(exportsOf()[0].params).not.toHaveProperty("injuries");
    // No continue_after: the fix is the injuries parameter, so the batch runs again.
    const again = await batchHandler()({ ...noChoice(variants), continue_after: "cmd_2" });
    expect(again.content[0].text).toContain("is not where the last batch stopped");
  });

  it("records what each export did with the injuries", async () => {
    const report = noInjuries({ not_carried: [ARM] });
    exportResults.push({ ...exported("A"), injuries: report });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined, anyFile);
    expect(m.variants[0].injuries).toEqual(injuryLines(report));
    expect(m.variants[0].injuries?.[0]).toBe("Left out of this export, as asked (an FBX cannot carry them):");
    expect(m.variants[0].ok).toBe(true);
  });

  it("fails a variant whose injuries did not all reach the export, apart from settings CC5 did not apply", async () => {
    const failed = "Std_Skin_Arm: this export wrote no Std_Skin_Arm_Diffuse image, so nothing was baked into it";
    exportResults.push({ ...exported("A"), notes: ["target_tool=Unity preset applied", `${INJURY_WARNING_PREFIX}${failed}`],
      injuries: noInjuries({ choice: "bake", not_carried: [ARM], failed: [failed] }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, injuries: "bake" }, () => undefined, anyFile);
    expect(m.variants[0]).toMatchObject({ name: "A", ok: false, fbx: "D:/P/Assets/Pt/A/A.fbx", error: `injuries not carried: ${failed}` });
    expect(m.variants[0].notes).toBeUndefined();
    expect(m.variants[0].error).not.toContain("exported without some of its settings");

    // A report without failed lines: the WARNING notes themselves still fail the variant.
    exportResults.push({ ...exported("A"), notes: [`${INJURY_WARNING_PREFIX}injuries step failed: boom`] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m2 = await runBatch(bridge as any, { ...input, injuries: "bake" }, () => undefined, anyFile);
    expect(m2.variants[0]).toMatchObject({ ok: false, error: "injuries not carried: injuries step failed: boom" });
  });

  it("names the variants whose export carried no injuries report: the plugin is older than that check", async () => {
    exportResults.push(plainExport("A"), plainExport("B"));
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("\nSkin overlays and skin conditions were not checked for A, B: the installed CC5 " +
      "plugin is older than that check (reinstall it with install-plugin.ps1).");
    expect(readManifest(p.manifestPath)?.variants[0].injuries).toEqual(injuryLines());
  });
});

// F-34: every content load is compared before and after; a batch is watched by nobody while it runs.
describe("content loads that changed more than they were for (F-34)", () => {
  it("fails a variant whose load removed the Boxers, keeps its FBX and asks to check with the user", async () => {
    started = mockJobs(bridge, {
      load_asset: (params) => params.file_path === PANTS
        ? { success: true, path: PANTS, target: "Old", changes: changes([
          { kind: "worn_added", group: "clothing", id: "13", name: "Pants" },
          { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" }]) }
        : ok,
      export_for_unity: (params) => exported(String(params.character_name)),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants: [{ name: "A", recipe: { assets: [PANTS] } }] }, () => undefined, anyFile);
    const a = m.variants[0];
    expect(a.checks?.[0].startsWith("asset Pants.ccCloth: ")).toBe(true);
    expect(a.checks).toEqual(["asset Pants.ccCloth: removed Boxers (clothing): CC5 may have swapped it out for this item"]);
    expect(a.ok).toBe(false);
    expect(a.fbx).toBe("D:/P/Assets/Pt/A/A.fbx");
    expect(a.error).toBe("exported, but check with the user: asset Pants.ccCloth: removed Boxers (clothing): CC5 may " +
      "have swapped it out for this item (CC5 side effects of this recipe: running it again gives the same result)");
  });

  // RB-2: each step's CHECK lines are capped only when the batch reports them, after superseding.
  it("caps each step's CHECK lines in the variant's checks, and keeps them all in its steps", async () => {
    const morphs = Array.from({ length: 13 }, (_, i) => ({ kind: "morph", id: `m${i}`, before: 0, after: 0.1 }));
    started = mockJobs(bridge, {
      load_asset: (params) => params.file_path === PANTS
        ? { success: true, path: PANTS, target: "Old", changes: changes([
          { kind: "worn_added", group: "clothing", id: "13", name: "Pants" }, ...morphs]) }
        : ok,
      export_for_unity: (params) => exported(String(params.character_name)),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants: [{ name: "A", recipe: { assets: [PANTS] } }] }, () => undefined, anyFile);
    const a = m.variants[0];
    expect(a.steps[0].checks).toHaveLength(13);
    expect(a.checks).toHaveLength(13);
    expect(a.checks?.[11]).toBe("asset Pants.ccCloth: shaping morph m11: 0 -> 0.1");
    expect(a.checks?.at(-1)).toBe("asset Pants.ccCloth: ... and 1 more");
    expect(a.ok).toBe(false);
  });

  it("does not count a makeup preset's skin colour when the recipe's skin_rgb sets it again", async () => {
    started = mockJobs(bridge, {
      load_asset: (params) => params.file_path === RED_VELVET
        ? { success: true, path: RED_VELVET, target: "Old", changes: changes([SKIN_FACT]) } : ok,
      export_for_unity: (params) => exported(String(params.character_name)),
    });
    bridge.setSkinColor.mockResolvedValue(ok);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, { ...input, variants: [{ name: "A", recipe: { assets: [RED_VELVET], skin_rgb: RGB } }] },
      () => undefined, anyFile);
    expect(m.variants[0].checks).toBeUndefined();
    expect(m.variants[0].ok).toBe(true);
    expect(m.variants[0].error).toBeUndefined();
    expect(m.variants[0].steps[0].superseded?.[0]).toContain("set again by skin_rgb later in this recipe");
  });
});

describe("what a batch reports besides each variant (F-77, F-86)", () => {
  let p: Project;
  beforeEach(() => { p = makeProject(); });
  afterEach(() => fs.rmSync(p.root, { recursive: true, force: true }));
  const UNDO = "CC5 cleared its undo history with these exports: changes made before them can no longer be undone.";

  // F-77: a .ccAvatar does not keep the facial expression, so a variant without an expression step is neutral-faced.
  it("notes a neutral face only for variants without an expression step, and counts them", async () => {
    bridge.setExpression.mockResolvedValue(ok);
    const r = await batchHandler()(inProject(p, { variants: [
      { name: "A", recipe: { expression: [{ name: "Smile", weight: 0.5 }] } }, input.variants[1]] }));
    expect(r.isError).toBeUndefined();
    const written = readManifest(p.manifestPath);
    expect(written?.variants[0].info).toBeUndefined();
    expect(written?.variants[1].info).toEqual(["No expression step: exported with a neutral face (a .ccAvatar does not " +
      "keep the facial expression)."]);
    expect(r.content[0].text).toContain("\n1 variant(s) have no expression step and were exported with a neutral face " +
      "(a .ccAvatar does not keep the facial expression).");
  });

  // F-86: an FBX export clears CC5's undo history.
  it("ends with one line when the exports cleared CC5's undo history", async () => {
    exportResults.push({ ...exported("A"), undo_history_cleared: true }, { ...exported("B"), undo_history_cleared: true });
    const lines = (await batchHandler()(inProject(p))).content[0].text.split("\n");
    expect(lines.at(-1)).toBe(UNDO);
    expect(lines.filter((l) => l.includes("cleared its undo history"))).toHaveLength(1);
    const plain = await batchHandler()(inProject(p));
    expect(plain.content[0].text).not.toContain("cleared its undo history");
  });

  it("keeps the note about a replaced stop last, after the undo-history line", async () => {
    eyesAsk((name) => ({ ...exported(name), undo_history_cleared: true }));
    await batchHandler()(inProject(p, { variants: eyeVariants }));
    const lines = (await batchHandler()(inProject(p))).content[0].text.split("\n");
    expect(lines.slice(-2)).toEqual([UNDO, "Note: the earlier batch that stopped at asset Eyes_01.ccEye (continue_after " +
      '"cmd_ab12cd34_2") was not continued; that stop is forgotten.']);
  });

  // TS-5: two soldiers exported with their FBX kept read '0/2 variants exported'.
  it("counts a variant whose FBX was written as exported, and says how many are OK when that differs", async () => {
    started = mockJobs(bridge, {
      load_asset: (params) => params.file_path === PANTS
        ? { success: true, path: PANTS, target: "Old", changes: changes([
          { kind: "worn_added", group: "clothing", id: "13", name: "Pants" },
          { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" }]) }
        : ok,
      export_for_unity: (params) => exported(String(params.character_name)),
    });
    const r = await batchHandler()(inProject(p, { variants: [{ name: "A", recipe: { assets: [PANTS] } }, input.variants[1]] }));
    expect(r.isError).toBe(true);
    const lines = r.content[0].text.split("\n");
    expect(lines[0]).toBe(`2/2 variants exported (1 OK: see the lines below). Manifest: ${p.manifestPath}`);
    expect(lines[1]).toMatch(/^FAIL A: exported, but check with the user: /);
    expect(lines[2]).toBe("OK   B (the base, unchanged on purpose)");
  });

  // X-2: CC5's timeline left at one frame after the export is no export setting it failed to apply.
  it("keeps a variant whose export left CC5's timeline at one frame OK, and says so once for the batch", async () => {
    const timeline = `${TIMELINE_NOT_RESTORED_PREFIX}CC5's timeline was set to one frame for this export and could not ` +
      "be set back (SetEndTime: x)";
    exportResults.push({ ...exported("A"), notes: [timeline] });
    const r = await batchHandler()(inProject(p));
    expect(r.isError).toBeUndefined();
    const written = readManifest(p.manifestPath);
    expect(written?.variants[0]).toMatchObject({ name: "A", ok: true });
    expect(written?.variants[0].notes).toBeUndefined();
    expect(written?.variants[0].info).toEqual([
      "No expression step: exported with a neutral face (a .ccAvatar does not keep the facial expression).",
      TIMELINE_LEFT_LINE]);
    expect(written?.variants[1].info).toEqual([
      "No expression step: exported with a neutral face (a .ccAvatar does not keep the facial expression)."]);
    expect(r.content[0].text).toContain("\nCC5's timeline was left at one frame after the export of A: set its length in " +
      "Character Creator 5 (this does not change the FBX files).");
    expect(r.content[0].text).not.toContain("exported without some of its settings");
    expect(r.content[0].text.split("\n")[0]).toBe(`2/2 variants exported. Manifest: ${p.manifestPath}`);
  });
});

describe("the CC5 texts a batch reads", () => {
  it("matches what server.py sends for a direct call that never started", () => {
    const server = fs.readFileSync(new URL("../../cc5-plugin/server.py", import.meta.url), "utf-8");
    expect(server).toContain("Timed out before CC5 started the command");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerUnityTools, isInUnityAssets, isLocalAbsolute, evaluateBudget, estimateTextureGpuMb, scanTextures, QUEST_DEFAULTS,
  unityFolderError, identicalMaterialCopies, withoutTearlineOcclusion, injuryQuestion, injuryLines,
  INJURY_CHOICES, INJURY_WARNING_PREFIX, UNDO_HISTORY_CLEARED, withUndoHistoryLine, EXPORT_AGAIN_WITH_INJURIES,
  TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE, type InjuryReport, type TextureInfo,
} from "../../src/tools/unity.js";
import type { MeshStatsResult } from "../../src/types.js";
import { tiff, bmp } from "../helpers/images.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { makeUnityProject, markUnityProject } from "../helpers/unity-project.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerUnityTools(server as any, bridge as any);
});

// export_for_unity refuses an Assets folder with no Unity project around it (F-76), so the export tests use one.
const PROJECT = makeUnityProject();
const UNITY_DIR = path.join(PROJECT, "Assets", "C");
const FBX = path.join(UNITY_DIR, "P1", "P1.fbx");

const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("isInUnityAssets", () => {
  it("accepts a folder under Assets", () => expect(isInUnityAssets("D:/Proj/Assets/Chars")).toBe(true));
  it("rejects a folder outside Assets", () => expect(isInUnityAssets("D:/Proj/Exports")).toBe(false));
});

describe("isLocalAbsolute", () => {
  it("accepts a local drive path", () => expect(isLocalAbsolute("D:/Proj/Assets/Chars")).toBe(true));
  it("rejects UNC, device and NT-prefixed paths", () => {
    for (const p of ["//host/share/Assets", String.raw`\\host\share\Assets`, String.raw`\\?\UNC\host\share\Assets`, String.raw`\??\UNC\host\share`]) {
      expect(isLocalAbsolute(p)).toBe(false);
    }
  });
});

describe("unityFolderError (F-76)", () => {
  it("accepts a folder inside the Assets folder of a marked Unity project", () => {
    expect(unityFolderError(path.join(PROJECT, "Assets", "Patients"))).toBeNull();
  });

  it("refuses an Assets folder with no ProjectSettings\\ProjectVersion.txt beside it, naming the missing file", () => {
    const root = tempDir("cc5-not-unity-");
    const folder = path.join(root, "Assets", "Patients");
    expect(unityFolderError(folder)).toBe(`unity_dir is not inside a Unity project: ${folder}. `
      + `${path.join(root, "ProjectSettings", "ProjectVersion.txt")} does not exist `
      + "(a Unity project has ProjectSettings\\ProjectVersion.txt beside its Assets folder)");
    expect(fs.existsSync(path.join(root, "Assets"))).toBe(false);
  });

  it("accepts a project nested inside another folder's Assets folder (Outer/Assets/Inner)", () => {
    const inner = path.join(tempDir("cc5-outer-"), "Assets", "Inner");
    markUnityProject(inner);
    expect(unityFolderError(path.join(inner, "Assets", "Patients"))).toBeNull();
  });

  it("keeps today's text for a folder outside any Assets folder", () => {
    expect(unityFolderError("D:/Exports/P1")).toBe("unity_dir must be inside a Unity project's Assets folder: D:/Exports/P1");
  });
});

describe("export_for_unity", () => {
  const handler = () => server.getRegisteredTool("export_for_unity");
  const description = () => server.tool.mock.calls.find((c) => c[0] === "export_for_unity")?.[1] as string;
  const shape = () => server.tool.mock.calls.find((c) => c[0] === "export_for_unity")?.[2] as
    Record<string, { description?: string; parse: (v: unknown) => unknown }>;

  // Live CC5 5.13 (Task 18): the first FBX export of a CC5 session crashed CC5 in about 3 of 4 sessions.
  it("tells the agent to save the character before the session's first FBX export", () => {
    expect(description()).toContain("save_character");
    expect(description()).toContain("first FBX export");
  });

  it("refuses a folder outside Assets without calling CC5", async () => {
    const r = await handler()({ unity_dir: "D:/Exports", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("refuses an Assets folder with no Unity project around it, naming the missing file, without calling CC5", async () => {
    const root = tempDir("cc5-f76-");
    const r = await handler()({ unity_dir: path.join(root, "Assets", "Patients"), character_name: "F76" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("is not inside a Unity project");
    expect(r.content[0].text).toContain(path.join(root, "ProjectSettings", "ProjectVersion.txt"));
    expect(bridge.startJob).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "Assets"))).toBe(false);
  });

  it("refuses a network (UNC) folder without calling CC5", async () => {
    const r = await handler()({ unity_dir: "//fileserver/share/Game/Assets/Characters", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("runs the export as a job and lists files", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
    bridge.getJob.mockResolvedValue({
      job_id: "cmd_1", action: "export_for_unity", status: "done",
      result: { success: true, fbx: FBX, folder: path.dirname(FBX), files: [{ path: "x.png", bytes: 1048576 }], notes: [] },
    });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ character_name: "P1" }));
    expect(r.content[0].text).toContain("P1.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("returns the job id when the export outlasts the wait", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "export_for_unity", status: "running" });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", wait_seconds: 0 });
    expect(r.content[0].text).toContain("cmd_9");
  });

  const finished = (result: Record<string, unknown>, status = "done") => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_1", action: "export_for_unity", status, result });
  };
  const exported = (extra: Record<string, unknown>) =>
    finished({ success: true, fbx: FBX, folder: path.dirname(FBX), files: [], notes: [], ...extra });

  it("flags an export CC5 made without some of its settings, and prints the warnings", async () => {
    exported({ notes: ["target_tool=Unity preset applied", "WARNING: SetTextureSize failed: bad enum"] });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", texture_size: 2048 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("WARNING: SetTextureSize failed: bad enum");
    expect(r.content[0].text).not.toContain("target_tool=Unity preset applied");
    expect(r.content[0].text).not.toContain("Switch to Unity");
  });

  it("prints the notes of a failed export", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_1", action: "export_for_unity", status: "failed", result: {
      success: false, error: "CC5 exported without the requested FBX settings",
      notes: ["WARNING: option flags (target-tool preset / axis / etc.) were NOT applied"] } });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("without the requested FBX settings");
    expect(r.content[0].text).toContain("were NOT applied");
  });

  it("says a subdivided export needs sub_d_level for the budget check", async () => {
    exported({ export_level: 2 });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", sub_d_level: 2 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("about 16x the base mesh's triangles");
    expect(r.content[0].text).toContain("give check_quest_budget sub_d_level 2");
  });

  it("adds no subdivision note at the base level", async () => {
    exported({ export_level: 0 });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", sub_d_level: 0 });
    expect(r.content[0].text).not.toContain("sub_d_level");
  });

  it("says a posed export carries the pose as a one-frame animation clip", async () => {
    // Live CC5 5.13 (Task 18): the pose is in a 1-frame take. Live Unity 6000.2.10f1 (Task 20): the imported model
    // already shows that pose (head 0.69 m vs 1.61 m), so there is no clip to apply by hand. Task 20 fix round 1
    // re-imported both exports as Humanoid (avatar created from the model, as the Trauma Sim patient body is): the
    // posed model still shows the pose (0.000 m from the Generic import), and the avatar is not built from the sitting pose,
    // but it differs from the unposed export's avatar by up to 0.14 m (feet), hence the Copy From Other Avatar advice.
    exported({});
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", include_current_pose: true });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("one-frame animation clip");
    expect(r.content[0].text).toContain("Unity shows the imported model in that pose with a Generic or Humanoid rig");
    expect(r.content[0].text).toContain("copy the avatar from an unposed export of the same character");
    expect(r.content[0].text).toContain("Copy From Other Avatar");
    expect(r.content[0].text).not.toContain("bind pose");
    exported({});
    const plain = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(plain.content[0].text).not.toContain("animation clip");
  });

  it("describes include_current_pose without the bind-pose claim Unity disproved", () => {
    expect(shape().include_current_pose.description).toContain("Unity shows the imported model in that pose with a Generic or Humanoid rig");
    expect(shape().include_current_pose.description).toContain("Copy From Other Avatar");
    expect(shape().include_current_pose.description).not.toContain("bind pose");
  });

  // F-75: an FBX carries neither a Diffuse Blend overlay nor the skin shader's pallor; the user picks per export.
  const report = (fields: Partial<InjuryReport>): InjuryReport => ({
    choice: null, not_carried: [], unverified: [], done: [], failed: [], notes: [], calibrated: null, ...fields,
  });
  const ARM = "overlay.png on Std_Skin_Arm (Diffuse Blend overlay at 60%)";
  const PALE = "pale skin on Std_Skin_Head, Std_Skin_Body (Digital Human skin shader: Brightness +0.036, Saturation -0.150)";
  const TINT = "skin colour (0.80, 0.86, 0.98) on Std_Skin_Body: CC5 writes it as the FBX material colour, not yet checked in Unity";

  it("says there is no default and that the project needs ProjectVersion.txt, and waits up to 120 s by default", () => {
    expect(description()).toContain("there is no default");
    expect(description()).toContain("ProjectVersion.txt");
    expect(description()).toContain("the reply always lists what the FBX does not carry");
    expect(shape().unity_dir.description).toContain("ProjectSettings\\ProjectVersion.txt");
    expect(shape().injuries.description).toContain("there is no default");
    expect(shape().injuries.parse("bake")).toBe("bake");
    expect(() => shape().injuries.parse("paint")).toThrow();
    expect(shape().remove_tearline_occlusion.description).toContain("Pass the same value to check_quest_budget");
    expect(shape().wait_seconds.parse(undefined)).toBe(120);
  });

  it("asks the user to choose when the plugin would not export injuries without a choice", async () => {
    const injuries = report({ not_carried: [ARM, PALE], unverified: [TINT] });
    finished({ success: false, needs_choice: true, injuries,
      error: "Not exported: this character has skin overlays or a skin condition that an FBX cannot carry." }, "failed");
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toBe(injuryQuestion(injuries));
    expect(text).toMatch(/^Not exported: this character has skin overlays or a skin condition that an FBX cannot carry:\n/);
    for (const line of [ARM, PALE, TINT]) expect(text).toContain(`\n- ${line}\n`);
    expect(text).toContain("Ask the user how they should reach Unity for this character (there is no default)");
    expect(text).toContain("- 'bake': burned into this export's diffuse textures; Unity shows them with no extra setup, "
      + "and they cannot be turned off there (the bake formula is not yet checked against CC5's look)");
    expect(text).toContain("- 'separate': the textures stay unchanged; the overlay images and <character_name>_injuries.json");
    expect(text).toContain("- 'omit': exported without them; the Unity patient has no injuries or skin condition");
    expect(text).not.toContain("Unity export failed");
  });

  it("drops the 'not yet checked' note once the bake is calibrated, and copes with a report-less refusal", () => {
    expect(injuryQuestion(report({ not_carried: [ARM], calibrated: "2026-10-12" }))).not.toContain("not yet checked");
    const bare = injuryQuestion();
    expect(bare).toContain("\n- (the CC5 plugin did not list them)\n");
    expect(bare).toContain("not yet checked against CC5's look");
  });

  // TS-4: a batch stores the question in its manifest, and there the way on is the batch, not export_for_unity.
  it("ends the question with the caller's way on, export_for_unity's by default", () => {
    const injuries = report({ not_carried: [ARM] });
    expect(EXPORT_AGAIN_WITH_INJURIES).toBe("then call export_for_unity again with injuries");
    expect(injuryQuestion(injuries)).toContain("Ask the user how they should reach Unity for this character (there is no " +
      "default), then call export_for_unity again with injuries:\n- 'bake'");
    const batch = injuryQuestion(injuries, "then run batch_generate_patients again with injuries");
    expect(batch).toContain("(there is no default), then run batch_generate_patients again with injuries:\n- 'bake'");
    expect(batch).not.toContain("export_for_unity");
    expect(batch).toContain(`\n- ${ARM}\n`);
  });

  it("forwards injuries and remove_tearline_occlusion only when they are given", async () => {
    exported({});
    await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    const plain = bridge.startJob.mock.calls[0][1] as Record<string, unknown>;
    expect(plain).not.toHaveProperty("injuries");
    expect(plain).not.toHaveProperty("remove_tearline_occlusion");
    exported({});
    await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "separate", remove_tearline_occlusion: true });
    expect(bridge.startJob).toHaveBeenLastCalledWith("export_for_unity",
      expect.objectContaining({ injuries: "separate", remove_tearline_occlusion: true }));
  });

  it("lists what was left out of an 'omit' export", async () => {
    exported({ injuries: report({ choice: "omit", not_carried: [ARM, PALE], unverified: [TINT] }) });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "omit" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Switch to Unity to import it.\n"
      + `Left out of this export, as asked (an FBX cannot carry them):\n- ${ARM}\n- ${PALE}\n`
      + `Not verified to reach Unity: ${TINT}`);
  });

  it("lists what a bake painted, and says the bake formula is not checked yet", async () => {
    const done = ["C/P1.fbm/Std_Skin_Arm_Diffuse.jpg: overlay 60%, pale"];
    exported({ injuries: report({ choice: "bake", not_carried: [ARM], done }) });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "bake" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain(`Baked into this export's diffuse textures:\n- ${done[0]}\n`
      + "The bake formula has not been checked against CC5 yet: compare the Unity result with a CC5 capture.");
    expect(injuryLines(report({ choice: "bake", done, calibrated: "2026-10-12" })).join("\n")).not.toContain("not been checked");
  });

  it("lists what 'separate' wrote beside the FBX, and the sidecar", async () => {
    const done = ["Injuries/Std_Skin_Arm_DiffuseBlend.png (Std_Skin_Arm, 60%)",
      "P1_injuries.json: skin-condition values for Std_Skin_Head, Std_Skin_Body"];
    const sidecar = path.join(UNITY_DIR, "P1", "P1_injuries.json");
    exported({ injuries: report({ choice: "separate", not_carried: [ARM, PALE], done, sidecar,
      notes: ["Removed the injuries files of an earlier export: P1_injuries.json"] }) });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "separate" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Written beside the FBX for a Unity material to blend (the FBX itself carries none):\n"
      + `- ${done[0]}\n- ${done[1]}\nSidecar: ${sidecar}\n`
      + "Note: Removed the injuries files of an earlier export: P1_injuries.json");
  });

  it("says when the character has no skin overlays or skin condition", async () => {
    exported({ injuries: report({ notes: ["Std_Skin_Arm: CC5 read the overlay strength as 0"] }) });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Switch to Unity to import it.\nSkin overlays and skin condition: none on this character.\n"
      + "Note: Std_Skin_Arm: CC5 read the overlay strength as 0");
  });

  it("asks for a plugin reinstall when an older plugin reports nothing about injuries", async () => {
    exported({});
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("The CC5 plugin did not report skin overlays or skin conditions (reinstall it): "
      + "an FBX does not carry them.");
  });

  it("lists a not-carried line even without a choice, and only unverified lines when that is all there is", () => {
    expect(injuryLines(report({ not_carried: [ARM] }))).toEqual(["Not in this FBX (an FBX cannot carry them):", `- ${ARM}`]);
    expect(injuryLines(report({ unverified: [TINT] }))).toEqual([`Not verified to reach Unity: ${TINT}`]);
  });

  it("is an error naming each injury that did not reach the export, apart from the settings warnings", async () => {
    const failed = "Std_Skin_Arm: this export wrote no Std_Skin_Arm_Diffuse image, so nothing was baked into it";
    exported({ notes: ["target_tool=Unity preset applied", `${INJURY_WARNING_PREFIX}${failed}`],
      injuries: report({ choice: "bake", not_carried: [ARM], failed: [failed] }) });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "bake" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`The injuries did not all reach this export, so the Unity patient is missing:\n- ${failed}`);
    expect(r.content[0].text).not.toContain("did not apply every export setting");
    expect(r.content[0].text).not.toContain("Switch to Unity");
  });

  it("shows both blocks when injuries failed and a setting was not applied", async () => {
    const failed = "Std_Skin_Arm: the overlay image could not be read from CC5 and was not loaded by this bridge";
    exported({ notes: ["WARNING: SetTextureSize failed: bad enum", `${INJURY_WARNING_PREFIX}${failed}`],
      injuries: report({ choice: "separate", not_carried: [ARM], failed: [failed] }) });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "separate" });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toContain(`The injuries did not all reach this export, so the Unity patient is missing:\n- ${failed}`);
    expect(text).toContain("CC5 did not apply every export setting, so do not use this FBX until that is fixed:\n"
      + "WARNING: SetTextureSize failed: bad enum");
    expect(text).not.toContain(`CC5 did not apply every export setting, so do not use this FBX until that is fixed:\n${INJURY_WARNING_PREFIX}`);
  });

  it("takes the failed injuries from the WARNING notes when the report has none", async () => {
    exported({ notes: [`${INJURY_WARNING_PREFIX}injuries step failed: boom`] });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", injuries: "bake" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("so the Unity patient is missing:\n- injuries step failed: boom");
  });

  it("says to pass remove_tearline_occlusion to check_quest_budget after an export without them", async () => {
    exported({ remove_tearline_occlusion: true });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", remove_tearline_occlusion: true });
    expect(r.content[0].text).toContain("Tear line and eye occlusion left out: pass remove_tearline_occlusion: true to check_quest_budget.");
    exported({});
    const plain = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(plain.content[0].text).not.toContain("Tear line and eye occlusion left out");
  });

  it("uses the plugin's injuries choices and warning prefix (cc5_pipeline.py)", () => {
    const plugin = fs.readFileSync(new URL("../../cc5-plugin/cc5_pipeline.py", import.meta.url), "utf-8");
    const choices = /^INJURY_CHOICES = \(([^)]*)\)/m.exec(plugin)?.[1] ?? "";
    expect([...choices.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...INJURY_CHOICES]);
    expect(/^INJURY_WARNING_PREFIX = "([^"]*)"/m.exec(plugin)?.[1]).toBe(INJURY_WARNING_PREFIX);
  });

  // F-86 (live CC5 5.13): an FBX export clears CC5's undo history, and undo still reports success afterwards.
  it("ends the reply with the undo-history line when the export cleared CC5's undo history", async () => {
    exported({ undo_history_cleared: true });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBeUndefined();
    const text = r.content[0].text;
    expect(text.split("\n").at(-1)).toBe("CC5 cleared its undo history with this export: changes made before it can no " +
      "longer be undone (save_character first to keep a way back).");
    expect(text).toContain("Switch to Unity to import it.");  // the other lines stay
    expect(text).toContain("The CC5 plugin did not report skin overlays or skin conditions");
    exported({});
    const plain = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(plain.content[0].text).not.toContain(UNDO_HISTORY_CLEARED);
  });

  it("says so after an export with warnings, and after one that ran and then failed its checks", async () => {
    exported({ notes: ["WARNING: SetTextureSize failed: bad enum"], undo_history_cleared: true });
    const warned = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", texture_size: 2048 });
    expect(warned.isError).toBe(true);
    expect(warned.content[0].text).toContain("CC5 did not apply every export setting");
    expect(warned.content[0].text.endsWith(`\n${UNDO_HISTORY_CLEARED}`)).toBe(true);
    finished({ success: false, error: `CC5 reported success but did not write ${FBX}`, notes: [], undo_history_cleared: true },
      "failed");
    const failed = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(`Unity export failed: CC5 reported success but did not write ${FBX}\n${UNDO_HISTORY_CLEARED}`);
  });

  it("adds the line only when the result says so", () => {
    expect(withUndoHistoryLine("Exported.", { undo_history_cleared: true })).toBe(`Exported.\n${UNDO_HISTORY_CLEARED}`);
    expect(withUndoHistoryLine("Exported.", { undo_history_cleared: false })).toBe("Exported.");
    expect(withUndoHistoryLine("Exported.")).toBe("Exported.");
  });

  // X-2: CC5's timeline, set to one frame for the export (F-82), could not be set back: the FBX itself is right.
  const TIMELINE = `${TIMELINE_NOT_RESTORED_PREFIX}CC5's timeline was set to one frame for this export and could not be ` +
    "set back (SetEndTime: x)";

  it("keeps an export whose timeline CC5 could not set back usable, and says so on its own line", async () => {
    expect(TIMELINE_NOT_RESTORED_PREFIX).toBe("WARNING: CC5 timeline not restored: ");
    expect(TIMELINE_LEFT_LINE).toBe("CC5's timeline was left at one frame: set its length in Character Creator 5.");
    expect(TIMELINE_USABLE_LINE).toBe(`The FBX is usable; ${TIMELINE_LEFT_LINE}`);
    exported({ notes: [TIMELINE], undo_history_cleared: true });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBeUndefined();
    const lines = r.content[0].text.split("\n");
    expect(lines[0]).toContain("Switch to Unity to import it.");
    expect(lines.slice(-2)).toEqual([TIMELINE_USABLE_LINE, UNDO_HISTORY_CLEARED]);
    expect(r.content[0].text).not.toContain("did not apply every export setting");
    expect(r.content[0].text).not.toContain(TIMELINE_NOT_RESTORED_PREFIX);
  });

  it("keeps the timeline out of the settings CC5 did not apply, next to a setting it did not apply", async () => {
    exported({ notes: [TIMELINE, "WARNING: SetTextureSize failed: bad enum"] });
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1", texture_size: 2048 });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toContain("CC5 did not apply every export setting, so do not use this FBX until that is fixed:\n" +
      "WARNING: SetTextureSize failed: bad enum\n");
    expect(text).not.toContain(TIMELINE_NOT_RESTORED_PREFIX);
    expect(text.split("\n").at(-1)).toBe(TIMELINE_LEFT_LINE);
    expect(text).not.toContain(TIMELINE_USABLE_LINE);
  });

  it("shows the plugin's timeline note as it is when the export failed", async () => {
    finished({ success: false, error: "ExportFbxFile reported an error status", notes: [TIMELINE] }, "failed");
    const r = await handler()({ unity_dir: UNITY_DIR, character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Unity export failed: ExportFbxFile reported an error status\n${TIMELINE}`);
  });
});

describe("evaluateBudget", () => {
  const stats = { success: true, meshes: [], totals: { vertices: 1, faces: 20_000, triangles: 40_000, materials: 10 } };

  it("passes within limits", () => {
    const r = evaluateBudget(stats, [{ path: "a.png", bytes: 1_000_000, width: 2048, height: 2048 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(true);
    expect(r.lines[0]).toBe("OK   Triangles: 40,000 / 65,000");
  });

  it("fails on triangles and oversize textures, naming the offenders", () => {
    const r = evaluateBudget({ ...stats, totals: { vertices: 1, faces: 40_000, triangles: 80_000, materials: 10 } },
      [{ path: "Body_Diffuse.png", bytes: 1, width: 4096, height: 4096 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("80,000");
    expect(r.lines.join("\n")).toContain("Body_Diffuse.png");
  });

  it("budgets triangles, not CC5's polygon (quad) count", () => {
    // Live CC5: 35,000 quads are 70,000 triangles, over a 65,000-triangle budget.
    const r = evaluateBudget({ ...stats, totals: { vertices: 1, faces: 35_000, triangles: 70_000, materials: 10 } }, [], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines[0]).toBe("OVER Triangles: 70,000 / 65,000");
  });

  it("estimates 2 triangles per polygon, and says so, when the plugin sends no triangle count", () => {
    const r = evaluateBudget({ ...stats, totals: { vertices: 1, faces: 35_000, materials: 10 } }, [], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines[0]).toBe("OVER Triangles: 70,000 / 65,000 (estimated as 2 per polygon)");
  });

  it("marks the count as estimated when a mesh's faces could not be read", () => {
    const r = evaluateBudget({ ...stats, meshes: [{ object: "P", kind: "body" as const, mesh: "CC_Base_Body",
      vertices: 1, faces: 100, triangles: 200, approximate: true, materials: 1 }] }, [], QUEST_DEFAULTS);
    expect(r.lines[0]).toContain("(estimated as 2 per polygon)");
  });

  it("fails when a texture's size cannot be read, naming it", () => {
    const r = evaluateBudget(stats, [{ path: "Body_Diffuse.tif", bytes: 1, width: 0, height: 0 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("Body_Diffuse.tif");
  });

  it("reads a TIFF or BMP texture's size from the export folder and counts it toward GPU memory", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "budget-tif-"));
    fs.writeFileSync(path.join(folder, "Body_Diffuse.tif"), tiff(true, [[256, 3, 2048], [257, 3, 2048]], 1000));
    fs.writeFileSync(path.join(folder, "Body_Normal.bmp"), bmp(1024, -1024));
    const textures = scanTextures(folder);
    fs.rmSync(folder, { recursive: true, force: true });
    expect(textures.map((t) => [path.basename(t.path), t.width, t.height]).sort())
      .toEqual([["Body_Diffuse.tif", 2048, 2048], ["Body_Normal.bmp", 1024, 1024]]);
    const r = evaluateBudget(stats, textures, QUEST_DEFAULTS);
    const text = r.lines.join("\n");
    expect(text).toContain("OK   Textures with unreadable size: 0");
    expect(text).not.toContain("size unreadable");
    const expected = estimateTextureGpuMb([{ path: "a", bytes: 1, width: 2048, height: 2048 },
      { path: "b", bytes: 1, width: 1024, height: 1024 }], 2048);
    expect(expected).toBeGreaterThan(0);
    expect(text).toContain(`Texture GPU memory (est., ASTC 6x6 + mips): ${expected.toFixed(1)} MiB`);
    expect(r.pass).toBe(true);
  });

  it("fails when estimated texture GPU memory is over budget, and reports file size as information", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `t${i}.png`, bytes: 1_048_576, width: 2048, height: 2048 }));
    const r = evaluateBudget(stats, many, QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("Texture GPU memory");
    expect(r.lines.join("\n")).toContain("Texture files on disk: 40.0 MiB");
  });
});

// F-73: a uniform whose meshes each got a copy of one material counts that material several times.
describe("identicalMaterialCopies and the merge hint (F-73)", () => {
  /** Writes the files (name -> content) into a new folder and returns them as scanned textures. */
  const writeTextures = (files: Record<string, string>): TextureInfo[] => {
    const folder = tempDir("cc5-copies-");
    return Object.entries(files).map(([name, content]) => {
      const file = path.join(folder, name);
      fs.writeFileSync(file, content);
      return { path: file, bytes: content.length, width: 1024, height: 1024 };
    });
  };
  const uniform = (prefix = "M_BipPMilUniform_US") => ({
    [`${prefix}_Diffuse.png`]: "diffuse", [`${prefix}_Diffuse_0001.png`]: "diffuse", [`${prefix}_Diffuse_0002.png`]: "diffuse",
    [`${prefix}_Normal.png`]: "normal", [`${prefix}_Normal_0001.png`]: "normal", [`${prefix}_Normal_0002.png`]: "normal",
  });
  const over = { success: true, meshes: [], totals: { vertices: 1, faces: 20_000, triangles: 40_000, materials: 22 } };

  it("finds a material exported 3 times with byte-identical textures", () => {
    const textures = writeTextures({ ...uniform(), "Std_Skin_Head_Diffuse.png": "skin" });
    expect(identicalMaterialCopies(textures)).toEqual([{ folder: path.dirname(textures[0].path),
      material: "M_BipPMilUniform_US", copies: 3, channels: ["Diffuse", "Normal"] }]);
  });

  it("does not count copies whose files differ, whose channel counts differ, or that cannot be read", () => {
    expect(identicalMaterialCopies(writeTextures({ ...uniform(), "M_BipPMilUniform_US_Normal_0002.png": "other" }))).toEqual([]);
    const fewer: Record<string, string> = uniform();
    delete fewer["M_BipPMilUniform_US_Normal_0002.png"];
    expect(identicalMaterialCopies(writeTextures(fewer))).toEqual([]);
    const textures = writeTextures(uniform());
    fs.rmSync(textures[1].path);
    expect(identicalMaterialCopies(textures)).toEqual([]);
  });

  it("hints at merging the copies when Materials is over budget: 22/20 would become 20", () => {
    const r = evaluateBudget(over, writeTextures(uniform()), QUEST_DEFAULTS);
    const at = r.lines.indexOf("OVER Materials: 22 / 20");
    expect(at).toBeGreaterThan(-1);
    expect(r.lines[at + 1]).toBe("     Hint: M_BipPMilUniform_US is exported 3 times with byte-identical textures (Diffuse, Normal): "
      + "merge these in Unity: the count would be 20. Their CC5 settings can differ (e.g. glossiness), so check the look after the merge.");
    expect(r.lines.join("\n")).not.toContain("All merged");
  });

  it("adds the count with every group merged when several materials are copied", () => {
    const r = evaluateBudget(over, writeTextures({ ...uniform(), ...uniform("M_Boots") }), QUEST_DEFAULTS);
    expect(r.lines.filter((l) => l.startsWith("     Hint:"))).toHaveLength(2);
    expect(r.lines).toContain("     All merged: 18");
  });

  it("gives no hint when Materials is within budget", () => {
    const r = evaluateBudget({ ...over, totals: { ...over.totals, materials: 10 } }, writeTextures(uniform()), QUEST_DEFAULTS);
    expect(r.lines.join("\n")).not.toContain("Hint:");
  });
});

describe("estimateTextureGpuMb", () => {
  it("prices a 2048px texture as ASTC 6x6 with mips", () => {
    expect(estimateTextureGpuMb([{ path: "a.png", bytes: 1, width: 2048, height: 2048 }], 2048)).toBeCloseTo(2.373, 3);
  });

  it("clamps the longer edge to maxPx, keeping the aspect ratio", () => {
    const clamped = estimateTextureGpuMb([{ path: "a.png", bytes: 1, width: 4096, height: 2048 }], 2048);
    const direct = estimateTextureGpuMb([{ path: "b.png", bytes: 1, width: 2048, height: 1024 }], 2048);
    expect(clamped).toBeCloseTo(direct, 6);
  });

  it("ignores textures whose size is unreadable", () => {
    expect(estimateTextureGpuMb([{ path: "a.tif", bytes: 1, width: 0, height: 0 }], 2048)).toBe(0);
  });
});

describe("check_quest_budget", () => {
  it("rejects an export_folder that is a file, without calling CC5", async () => {
    const r = await server.getRegisteredTool("check_quest_budget")({ export_folder: `${process.cwd()}/package.json` });
    expect(r.isError).toBe(true);
    expect(bridge.getMeshStats).not.toHaveBeenCalled();
  });

  it("says when no textures were scanned", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, triangles: 200, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({});
    expect(r.content[0].text).toContain("no texture images scanned");
  });

  it("reports mesh totals without an export folder", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, triangles: 200, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({});
    expect(r.content[0].text).toContain("PASS");
  });

  it("does not pass a subdivided export on base-mesh triangles", async () => {
    // export_for_unity's sub_d_level subdivides only the FBX; the scene stats still count the base mesh.
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 20_000, triangles: 40_000, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({ sub_d_level: 2 });
    expect(r.content[0].text).toMatch(/^NOT CHECKED — Quest budget/);
    expect(r.content[0].text).toContain("NOT CHECKED Triangles: the FBX was exported at sub_d_level 2 (about 16x the triangles, roughly 640,000)");
    expect(r.content[0].text).not.toContain("PASS");
    expect(r.isError).toBeUndefined();
  });

  it("still fails a subdivided export that is over budget on the base mesh", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, triangles: 200, materials: 40 } });
    const r = await server.getRegisteredTool("check_quest_budget")({ sub_d_level: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^FAIL — Quest budget/);
  });
});

// F-73: export_for_unity's remove_tearline_occlusion leaves 4 materials out of the FBX; the budget check must know.
describe("the tear line and eye occlusion in the Quest budget (F-73)", () => {
  const mesh = (name: string, materials: number, triangles: number) =>
    ({ object: "Kevin", kind: "body" as const, mesh: name, vertices: triangles, faces: triangles / 2, triangles, materials });
  const kevin: MeshStatsResult = {
    success: true,
    meshes: [mesh("CC_Base_Body", 14, 40_000), mesh("CC_Base_TearLine", 2, 200), mesh("CC_Base_EyeOcclusion", 2, 300),
      mesh("CC_Base_Eye", 4, 2_000)],
    totals: { vertices: 42_500, faces: 21_250, triangles: 42_500, materials: 22 },
  };
  const budget = () => server.getRegisteredTool("check_quest_budget");

  it("leaves the tear line and eye occlusion meshes out of the counts: 22 -> 18 materials", () => {
    const trimmed = withoutTearlineOcclusion(kevin);
    expect(trimmed.materials).toBe(4);
    expect(trimmed.triangles).toBe(500);
    expect(trimmed.stats.totals).toEqual({ vertices: 42_000, faces: 21_000, triangles: 42_000, materials: 18 });
    expect(trimmed.stats.meshes.map((m) => m.mesh)).toEqual(["CC_Base_Body", "CC_Base_Eye"]);
    expect(withoutTearlineOcclusion({ ...kevin, totals: { vertices: 42_500, faces: 21_250, materials: 22 } }).stats.totals)
      .not.toHaveProperty("triangles");
  });

  it("counts without them when the export left them out, and says so", async () => {
    bridge.getMeshStats.mockResolvedValue(kevin);
    const r = await budget()({ remove_tearline_occlusion: true });
    expect(r.isError).toBeUndefined();
    const lines = r.content[0].text.split("\n");
    const at = lines.indexOf("OK   Materials: 18 / 20");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("     Tear line and eye occlusion left out of the export (remove_tearline_occlusion): "
      + "4 materials and 500 triangles not counted");
  });

  it("hints at remove_tearline_occlusion when Materials is over budget without it", async () => {
    bridge.getMeshStats.mockResolvedValue(kevin);
    const r = await budget()({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("OVER Materials: 22 / 20\n     Hint: export_for_unity with remove_tearline_occlusion: true "
      + "leaves out the tear line and eye occlusion (4 materials); the eyes lose their wet edge and soft shadow. Pass the same flag here.");
  });

  it("says when there are no such meshes to leave out, and gives no hint within budget", async () => {
    bridge.getMeshStats.mockResolvedValue({ ...kevin, meshes: [mesh("CC_Base_Body", 14, 40_000)],
      totals: { vertices: 40_000, faces: 20_000, triangles: 40_000, materials: 14 } });
    const r = await budget()({ remove_tearline_occlusion: true });
    expect(r.content[0].text).toContain("     remove_tearline_occlusion: no tear line or eye occlusion meshes in the scene stats, "
      + "so nothing was subtracted");
    bridge.getMeshStats.mockResolvedValue({ ...kevin, totals: { ...kevin.totals, materials: 18 } });
    const within = await budget()({});
    expect(within.content[0].text).not.toContain("Hint:");
  });

  it("describes the flag as the value the export used", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "check_quest_budget")?.[2] as Record<string, { description?: string }>;
    expect(shape.remove_tearline_occlusion.description).toBe(
      "Pass the value the export used: the tear line and eye occlusion are then left out of the counts");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  answeredCancel, applyRecipe, checkRecipeFiles, formatReport, isSelectionRefusal, planRecipe, recipeStepCount,
  remainingRecipe, stepFromJob, supersedeChecks, waitKind, RecipeSchema, HEADSHOT_DISABLED, BASE_LOAD_WAIT_MS,
  CANCELLED_BASE, CANCELLED_CHANGED, CANCELLED_NOTHING, CANCELLED_UNSURE, PRESET_EXTENSIONS, STEP_JOB_WAIT_MS,
  WEARABLE_EXTENSIONS, type StepResult,
} from "../src/recipe.js";
import type { CC5Dialog } from "../src/types.js";
import { BridgeHttpError, BridgeTimeoutError } from "../src/cc5-bridge.js";
import { LAYER_EXPECT } from "../src/build-session.js";
import { STILL_ASKING_NOTE } from "../src/jobs.js";
import { SKINGEN_SESSION_NOTE } from "../src/change-report.js";
import {
  CANCEL_NOT_CARRIED, LAYER_STOP_ADVICE, SKINGEN_QUESTION, SKINGEN_QUESTION_RULE,
} from "../src/prompts/content-rules.js";
import { createMockBridge, mockJobs } from "./helpers/mock-bridge.js";
import type { MockBridge } from "./helpers/mock-bridge.js";

let bridge: MockBridge;
let started: ReturnType<typeof mockJobs>;
const ok = { success: true };

const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["Replace", "Material Only", "Cancel"],
};
const APPLY = { title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] };
const LAYER_QUESTION = "The target object layer already exists. Do you want to replace the object, or the material only?";
const LAYER_BUTTONS = "Replace, Material Only, Cancel";
/** server.py _waiting_dialog_error: a 409's text and a waiting job's dialog_message. */
const waiting = (id: string, question = LAYER_QUESTION, buttons = LAYER_BUTTONS) =>
  `CC5 is waiting for an answer to "${question}" (the "Character Creator 5" window). Buttons: ${buttons}. The command is ` +
  `still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a real choice), then check ` +
  `its result with job_status("${id}").`;
/** The same text in a report's WAIT line (batch F review #29): continue_after, not job_status, reads the job's result. */
const waitingLine = (id: string, question = LAYER_QUESTION, buttons = LAYER_BUTTONS) =>
  `CC5 is waiting for an answer to "${question}" (the "Character Creator 5" window). Buttons: ${buttons}. The command is ` +
  `still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a real choice), then ` +
  "continue_after reads its result.";
const GUARD = 'CC5 is waiting for an answer to "Replace?" - no MCP command is waiting on it, so it is probably the ' +
  "user's own or CC5's: ask the user to answer or close it in CC5, then try again.";
const NOT_STARTED = "CC5 timed out (cancelled): Timed out before CC5 started the command; it was cancelled and will not run.";

beforeEach(() => {
  bridge = createMockBridge();
  for (const m of ["setMultipleMorphs", "setSkinColor", "setSkinCondition", "applySkinOverlay", "setExpression"] as const) {
    bridge[m].mockResolvedValue(ok);
  }
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
  started = mockJobs(bridge);
});

describe("applyRecipe", () => {
  it("runs steps in order and reports each", async () => {
    const recipe = RecipeSchema.parse({
      base: "default",
      body_preset: { preset: "heavy", intensity: 0.5 },
      skin_rgb: [0.8, 0.6, 0.5],
      skin_condition: { condition: "pale", amount: 0.7 },
      assets: ["C:/c/Jacket.iClothes", "C:/h/Short.ccHair"],
      overlays: [{ image_path: "C:/o/bruise.png", region: "head", strength: 60 }],
      pose_file: "C:/p/Supine.rlMotion",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results.map((r) => r.step)).toEqual([
      "base", "body_preset", "asset Short.ccHair", "skin_rgb", "skin_condition", "overlay bruise.png",
      "asset Jacket.iClothes", "pose_file"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(bridge.setMultipleMorphs.mock.calls[0][0][0].value).toBeCloseTo(0.35);
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(bridge.deleteAvatar.mock.invocationCallOrder[0]).toBeLessThan(bridge.startJob.mock.invocationCallOrder[0]);
    expect(bridge.setSkinCondition).toHaveBeenCalledWith("pale", 0.7, "all", [0.8, 0.6, 0.5]);
  });

  it("tints skin_condition's own base_rgb: a remaining recipe carries the colour without running skin_rgb again", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyRecipe(bridge as any, RecipeSchema.parse({ skin_condition: { condition: "pale", amount: 0.5, base_rgb: [0.7, 0.5, 0.4] } }));
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(bridge.setSkinCondition).toHaveBeenCalledWith("pale", 0.5, "all", [0.7, 0.5, 0.4]);
  });

  it("loads the base, assets and pose as bridge jobs, not 30 s direct calls", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyRecipe(bridge as any, RecipeSchema.parse({
      base: "C:/Bases/Male.ccAvatar", assets: ["C:/c/Jacket.iClothes"], pose_file: "C:/p/Supine.rlMotion" }),
    { fileExists: () => true });
    expect(started).toEqual([
      { action: "load_asset", params: { file_path: "C:/Bases/Male.ccAvatar" } },
      { action: "load_asset", params: { file_path: "C:/c/Jacket.iClothes" } },
      { action: "apply_pose", params: { file_path: "C:/p/Supine.rlMotion" } },
    ]);
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.applyPose).not.toHaveBeenCalled();
  });

  it("reports a step whose job outlasts the wait as failed, naming the job", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_9", action: "apply_pose", status: "running" });
    const recipe = RecipeSchema.parse({ pose_file: "C:/p/Supine.rlMotion" });
    vi.useFakeTimers();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = applyRecipe(bridge as any, recipe);
      await vi.advanceTimersByTimeAsync(200_000);
      const results = await pending;
      expect(results[0]).toMatchObject({ step: "pose_file", ok: false });
      expect(results[0].detail).toContain("cmd_ab12cd34_9");
    } finally {
      vi.useRealTimers();
    }
  });

  // Chad's ruling (2026-10-03): live, Headshot crashed CC5 5.13. The step fails with the do-it-in-CC5 message
  // and CC5 is never asked; the steps after it still run.
  it("fails the headshot_photo step without calling CC5, and runs the rest", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({
      headshot_photo: "C:/p/face.jpg", skin_condition: { condition: "pale", amount: 0.5 } }));
    expect(results).toEqual([
      { step: "headshot_photo", ok: false, detail: HEADSHOT_DISABLED },
      { step: "skin_condition", ok: true, detail: "" },
    ]);
    expect(started).toEqual([]);
    expect(RecipeSchema.shape.headshot_photo.description).toContain("Switched off");
  });

  it("keeps going after a failed step", async () => {
    mockJobs(bridge, { load_asset: { success: false, error: "File not found" } });
    const recipe = RecipeSchema.parse({ assets: ["C:/x/Missing.iClothes"], pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results[0]).toMatchObject({ ok: false, detail: "File not found" });
    expect(results[1]).toMatchObject({ step: "pose_file", ok: true });
  });

  it("records thrown errors as failed steps", async () => {
    bridge.startJob.mockRejectedValue(new Error("bridge down"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ pose_file: "C:/p/a.rlMotion" }));
    expect(results[0]).toMatchObject({ ok: false, detail: "bridge down" });
  });

  it("fails the base step and does not create when an old avatar cannot be deleted", async () => {
    bridge.deleteAvatar.mockResolvedValueOnce({ success: false, error: "locked" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ base: "default", pose_file: "C:/p/a.rlMotion" }),
      { fileExists: () => true });
    expect(results[0]).toMatchObject({ step: "base", ok: false });
    expect(results[0].detail).toContain("Old");
    expect(results[0].detail).toContain("locked");
    expect(started.map((j) => j.action)).not.toContain("create_default_avatar");
    expect(results[1]).toMatchObject({ step: "pose_file", ok: true });
  });

  it("starts no further step, and sends CC5 nothing more, once cancelled", async () => {
    const ac = new AbortController();
    bridge.setSkinColor.mockImplementation(async () => { ac.abort(); return ok; });
    const recipe = RecipeSchema.parse({
      skin_rgb: [0.8, 0.6, 0.5], skin_condition: { condition: "pale", amount: 1 },
      assets: ["C:/c/Jacket.iClothes"], pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe, { signal: ac.signal });
    expect(results).toEqual([{ step: "skin_rgb", ok: true, detail: "" }]);
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it("stops removing old avatars when cancelled part-way through the base step", async () => {
    const ac = new AbortController();
    bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }, { name: "Older", id: "2", type: "avatar" }]);
    bridge.deleteAvatar.mockImplementation(async () => { ac.abort(); return ok; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ base: "C:/Bases/Male.ccAvatar" }),
      { signal: ac.signal, fileExists: () => true });
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);
    expect(started).toEqual([]);
    expect(results[0]).toMatchObject({ step: "base", ok: false });
  });

  it("reports each step as it finishes", async () => {
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyRecipe(bridge as any, RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], pose_file: "C:/p/a.rlMotion" }),
      { onStep: (s) => seen.push(`${s.step}:${s.ok}`) });
    expect(seen).toEqual(["skin_rgb:true", "pose_file:true"]);
  });
});

describe("step order (D2)", () => {
  it("runs the face, then presets, then the skin colour, then overlays, then wearables", async () => {
    bridge.loadFacialProfile.mockResolvedValue(ok);
    const recipe = RecipeSchema.parse({
      facial_profile: "C:/f/Profile.ccFacialProfile", skin_rgb: [0.8, 0.6, 0.5],
      assets: ["C:/u/Shirt.ccUpper", "C:/m/Red Velvet.ccSkinGenPreset"],
      overlays: [{ image_path: "C:/o/bruise.png" }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results.map((r) => r.step)).toEqual([
      "facial_profile", "asset Red Velvet.ccSkinGenPreset", "skin_rgb", "overlay bruise.png", "asset Shirt.ccUpper"]);
    expect(started.map((j) => j.params.file_path)).toEqual(["C:/m/Red Velvet.ccSkinGenPreset", "C:/u/Shirt.ccUpper"]);
    const [presetJob, shirtJob] = bridge.startJob.mock.invocationCallOrder;
    expect(bridge.loadFacialProfile.mock.invocationCallOrder[0]).toBeLessThan(presetJob);
    expect(presetJob).toBeLessThan(bridge.setSkinColor.mock.invocationCallOrder[0]);
    expect(bridge.applySkinOverlay.mock.invocationCallOrder[0]).toBeLessThan(shirtJob);
  });

  it("plans every kind of step in one order, keeping the asset order within presets and within wearables", () => {
    const recipe = RecipeSchema.parse({
      pose_file: "C:/p/Supine.rlMotion", expression: [{ name: "Smile", weight: 0.5 }], wrinkle_strength: 0.4,
      assets: ["C:/c/Shirt.ccCloth", "C:/e/Eyes.ccEye", "C:/p/Box.iProp", "C:/h/Buzz.rlHair"],
      overlays: [{ image_path: "C:/o/cut.png" }],
      textures: [{ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Arm", channel: "diffuse_blend", image_path: "C:/t/b.png" }],
      skin_condition: { condition: "pale" }, skin_rgb: [0.8, 0.6, 0.5], facial_profile: "C:/f/P.ccFacialProfile",
      morphs: [{ morph_id: "m", value: 0.5 }], body_preset: { preset: "slim" }, headshot_photo: "C:/p/face.jpg", base: "default",
    });
    expect(planRecipe(recipe).map((s) => s.name)).toEqual([
      "base", "headshot_photo", "body_preset", "morphs", "facial_profile", "asset Eyes.ccEye", "asset Buzz.rlHair",
      "skin_rgb", "skin_condition", "texture Std_Skin_Arm/diffuse_blend", "overlay cut.png", "asset Shirt.ccCloth",
      "asset Box.iProp", "wrinkle_strength", "expression", "pose_file"]);
    expect(planRecipe(recipe).filter((s) => s.asset).map((s) => [s.kind, s.asset])).toEqual([
      ["preset", "C:/e/Eyes.ccEye"], ["preset", "C:/h/Buzz.rlHair"], ["wearable", "C:/c/Shirt.ccCloth"], ["wearable", "C:/p/Box.iProp"]]);
    expect(recipeStepCount(recipe)).toBe(16);
  });

  it("counts no steps for an empty recipe, also with an empty asset list", () => {
    expect(recipeStepCount({})).toBe(0);
    expect(recipeStepCount({ assets: [] })).toBe(0);
    expect(recipeStepCount({ morphs: [], expression: [] })).toBe(0);
  });

  it("says when assets load, and what wrinkle strength does (F-70)", () => {
    expect(RecipeSchema.shape.assets.description).toContain("before skin_rgb");
    expect(RecipeSchema.shape.wrinkle_strength.description).toContain("creases that show while an expression is active");
    expect(RecipeSchema.shape.wrinkle_strength.description).toContain("it does not age a resting face");
    expect(RecipeSchema.shape.skin_condition.unwrap().shape.base_rgb.description).toContain("skin_rgb");
  });

  it("splits CC5's character content into presets and wearables (cc5_api._CHARACTER_CONTENT_EXTENSIONS)", () => {
    const py = fs.readFileSync(new URL("../cc5-plugin/cc5_api.py", import.meta.url), "utf-8");
    const block = /_CHARACTER_CONTENT_EXTENSIONS = \{([\s\S]*?)\n\}/.exec(py)?.[1] ?? "";
    const plugin = [...block.matchAll(/"(\.[a-z]+)"/g)].map((m) => m[1]).sort();
    expect(plugin.length).toBeGreaterThan(10);
    expect([...PRESET_EXTENSIONS, ...WEARABLE_EXTENSIONS].sort()).toEqual(plugin);
    expect(new Set([...PRESET_EXTENSIONS, ...WEARABLE_EXTENSIONS]).size).toBe(PRESET_EXTENSIONS.length + WEARABLE_EXTENSIONS.length);
  });
});

describe("a CC5 question nobody has answered stops the recipe (D1)", () => {
  it("stops at an asset job that waits on a question, and sends nothing after it", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_3" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_3", action: "load_asset", status: "running", dialog: LAYER,
      dialog_message: waiting("cmd_ab12cd34_3") });
    const recipe = RecipeSchema.parse({
      assets: ["C:/e/Eyes_02.ccEye", "C:/c/Shirt.ccCloth"], skin_rgb: [0.8, 0.6, 0.5], pose_file: "C:/p/Supine.rlMotion" });
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe, { onStep: (s) => seen.push(s.step) });
    expect(results).toEqual([{ step: "asset Eyes_02.ccEye", ok: false, detail: waiting("cmd_ab12cd34_3"),
      stopped: { ran: true, job_id: "cmd_ab12cd34_3", question: LAYER, wait_ms: STEP_JOB_WAIT_MS, asset: "C:/e/Eyes_02.ccEye" } }]);
    expect(seen).toEqual(["asset Eyes_02.ccEye"]);
    expect(bridge.startJob).toHaveBeenCalledTimes(1);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(remainingRecipe(recipe, results)).toEqual({
      skin_rgb: [0.8, 0.6, 0.5], assets: ["C:/c/Shirt.ccCloth"], pose_file: "C:/p/Supine.rlMotion" });
  });

  it("stops on a direct call's 409 with the job CC5 runs it as (the job is read once)", async () => {
    const text = waiting("cmd_9", "Apply the preset?", "OK, Cancel");
    bridge.setSkinCondition.mockRejectedValue(new BridgeHttpError(text, 409));
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "set_skin_condition", status: "running", dialog: APPLY });
    const recipe = RecipeSchema.parse({ skin_condition: { condition: "pale", amount: 0.5 }, pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results).toEqual([{ step: "skin_condition", ok: false, detail: text,
      stopped: { ran: true, job_id: "cmd_9", question: APPLY, wait_ms: STEP_JOB_WAIT_MS } }]);
    expect(bridge.getJob).toHaveBeenCalledTimes(1);
    expect(started).toEqual([]);
    expect(remainingRecipe(recipe, results)).toEqual({ pose_file: "C:/p/Supine.rlMotion" });
  });

  it("stops at a step the open-dialog guard refused or failed: it never ran, so it runs again after the answer", async () => {
    bridge.setSkinColor.mockRejectedValue(new BridgeHttpError(GUARD, 400));
    const recipe = RecipeSchema.parse({
      skin_rgb: [0.8, 0.6, 0.5], skin_condition: { condition: "pale", amount: 1 }, pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results).toEqual([{ step: "skin_rgb", ok: false, detail: GUARD, stopped: { ran: false, wait_ms: STEP_JOB_WAIT_MS } }]);
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();
    expect(remainingRecipe(recipe, results)).toEqual({
      skin_rgb: [0.8, 0.6, 0.5], skin_condition: { condition: "pale", amount: 1, base_rgb: [0.8, 0.6, 0.5] },
      pose_file: "C:/p/Supine.rlMotion" });

    mockJobs(bridge, { load_asset: { success: false, error: GUARD } });
    const shirt = RecipeSchema.parse({ assets: ["C:/c/Shirt.ccCloth"], pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocked = await applyRecipe(bridge as any, shirt);
    expect(blocked).toEqual([{ step: "asset Shirt.ccCloth", ok: false, detail: GUARD,
      stopped: { ran: false, wait_ms: STEP_JOB_WAIT_MS, asset: "C:/c/Shirt.ccCloth" } }]);
    expect(remainingRecipe(shirt, blocked)).toEqual(shirt);
  });

  it("stops at a call that never started while CC5 shows a window; without a window it fails as before", async () => {
    bridge.setSkinColor.mockRejectedValue(new BridgeHttpError(NOT_STARTED, 504));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_2" });
    const recipe = RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], skin_condition: { condition: "pale", amount: 1 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ step: "skin_rgb", ok: false, stopped: { ran: false, wait_ms: STEP_JOB_WAIT_MS } });
    expect(results[0].stopped).not.toHaveProperty("question");  // that window is not this step's own question
    expect(results[0].stopped).not.toHaveProperty("job_id");
    expect(results[0].detail).toContain("Timed out before CC5 started the command");
    expect(results[0].detail).toContain("CC5 dialog");
    expect(bridge.setSkinCondition).not.toHaveBeenCalled();

    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failed = await applyRecipe(bridge as any, recipe);
    expect(failed[0]).toEqual({ step: "skin_rgb", ok: false, detail: NOT_STARTED });
    expect(failed[1]).toMatchObject({ step: "skin_condition", ok: true });
  });

  it("stops the base step on a 409 while deleting the old character: the whole base runs again after the answer", async () => {
    const text = waiting("cmd_7", "Delete Old?", "OK, Cancel");
    bridge.deleteAvatar.mockRejectedValue(new BridgeHttpError(text, 409));
    bridge.getJob.mockResolvedValue({ job_id: "cmd_7", action: "delete_avatar", status: "running", dialog: APPLY });
    const recipe = RecipeSchema.parse({ base: "C:/Bases/Male.ccAvatar", skin_rgb: [0.8, 0.6, 0.5] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe, { fileExists: () => true });
    expect(results).toEqual([{ step: "base", ok: false, detail: text,
      stopped: { ran: false, job_id: "cmd_7", question: APPLY, wait_ms: BASE_LOAD_WAIT_MS } }]);
    expect(started).toEqual([]);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(remainingRecipe(recipe, results)).toEqual(recipe);
  });

  it("answers the identical question with the run's layer answer (D3), and says so in the step", async () => {
    let polls = 0;
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4" });
    bridge.getJob.mockImplementation(async () => (++polls === 1
      ? { job_id: "cmd_ab12cd34_4", action: "load_asset", status: "running", dialog: LAYER, dialog_message: waiting("cmd_ab12cd34_4") }
      : { job_id: "cmd_ab12cd34_4", action: "load_asset", status: "done", result: { success: true, path: "C:/e/Eyes_02.ccEye", target: "Kevin" } }));
    bridge.answerDialog.mockResolvedValue({ success: true, clicked: "Material Only" });
    vi.useFakeTimers();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/e/Eyes_02.ccEye"] }), { layerAnswer: "Material Only" });
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await pending;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ step: "asset Eyes_02.ccEye", ok: true,
        detail: "CC5 asked 'Replace / Material Only'; answered 'Material Only' (the user's answer earlier in this run)" });
      expect(results[0].stopped).toBeUndefined();
      expect(bridge.answerDialog).toHaveBeenCalledWith("Material Only", LAYER_EXPECT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at the same question without a layer answer", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4", action: "load_asset", status: "running", dialog: LAYER,
      dialog_message: waiting("cmd_ab12cd34_4") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/e/Eyes_02.ccEye"], skin_rgb: [0.8, 0.6, 0.5] }));
    expect(results).toHaveLength(1);
    expect(results[0].stopped).toMatchObject({ ran: true, job_id: "cmd_ab12cd34_4", question: LAYER });
    expect(bridge.answerDialog).not.toHaveBeenCalled();
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  // RB-1: the run's click failed and the dialog check failed too (CC5's dialog lane blocked): it used to wait and go on.
  it("stops when the run's click failed and CC5 did not answer the dialog check, and sends nothing after it", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4", action: "load_asset", status: "running", dialog: LAYER,
      dialog_message: waiting("cmd_ab12cd34_4") });
    bridge.answerDialog.mockRejectedValue(new BridgeHttpError("CC5 timed out (still running): CC5 is still working on this command.", 504));
    bridge.getDialog.mockRejectedValue(new BridgeTimeoutError("No reply from CC5 within 3s."));
    const recipe = RecipeSchema.parse({ assets: ["C:/e/Eyes_02.ccEye", "C:/c/Shirt.ccCloth"], skin_rgb: [0.8, 0.6, 0.5] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe, { layerAnswer: "Replace" });
    expect(results).toEqual([{ step: "asset Eyes_02.ccEye", ok: false,
      detail: `${waiting("cmd_ab12cd34_4")} (this run's answer 'Replace' may not have been clicked, and CC5 did not answer a ` +
        "check for open dialogs; look at CC5 (get_cc5_dialog) before going on)",
      stopped: { ran: true, job_id: "cmd_ab12cd34_4", question: LAYER, wait_ms: STEP_JOB_WAIT_MS, asset: "C:/e/Eyes_02.ccEye" } }]);
    expect(bridge.startJob).toHaveBeenCalledTimes(1);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(remainingRecipe(recipe, results)).toEqual({ skin_rgb: [0.8, 0.6, 0.5], assets: ["C:/c/Shirt.ccCloth"] });
  });

  // RB-1 and RB-3: the step's wait ran out while the job still reported the question it had answered.
  it("stops when CC5 still reports the question when the step's wait runs out, naming the run's click", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4", action: "load_asset", status: "running", dialog: LAYER,
      dialog_message: waiting("cmd_ab12cd34_4") });
    bridge.answerDialog.mockResolvedValue({ success: true, clicked: "Material Only" });
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });  // nothing open live: no repeat click
    vi.useFakeTimers();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/e/Eyes_02.ccEye"], skin_rgb: [0.8, 0.6, 0.5] }),
        { layerAnswer: "Material Only" });
      await vi.advanceTimersByTimeAsync(STEP_JOB_WAIT_MS + 5_000);
      const results = await pending;
      expect(results).toHaveLength(1);
      expect(results[0].stopped).toEqual({ ran: true, job_id: "cmd_ab12cd34_4", question: LAYER, wait_ms: STEP_JOB_WAIT_MS,
        asset: "C:/e/Eyes_02.ccEye", answered: "Material Only" });
      expect(results[0].detail).toBe(`${waiting("cmd_ab12cd34_4")} (${STILL_ASKING_NOTE}; this run already answered ` +
        "'Replace / Material Only' in this job with 'Material Only')");
      expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
      expect(bridge.setSkinColor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a missing base is refused before anything changes (F-81)", () => {
  it("fails the base step and sends CC5 nothing", async () => {
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ base: "C:/missing/Kevin.ccAvatar", skin_rgb: [0.8, 0.6, 0.5] }),
      { fileExists: () => false, onStep: (s) => seen.push(s.step) });
    expect(results).toEqual([{ step: "base", ok: false, detail: "base not found: C:/missing/Kevin.ccAvatar. Nothing was " +
      "changed in CC5: the characters in the scene were left as they were." }]);
    expect(seen).toEqual(["base"]);
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(bridge.deleteAvatar).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  it("checks the base on disk by default, and only the base", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-recipe-"));
    try {
      const real = path.join(dir, "Kevin.ccAvatar");
      fs.writeFileSync(real, "");
      expect(checkRecipeFiles({ base: real })).toBeNull();
      expect(checkRecipeFiles({ base: path.join(dir, "Gone.ccAvatar") })).toContain("base not found");
      expect(checkRecipeFiles({ base: "default" })).toBeNull();
      expect(checkRecipeFiles({ assets: [path.join(dir, "Gone.ccCloth")] })).toBeNull();
      expect(checkRecipeFiles({ base: "C:/b/x.iProp" }, () => true))
        .toBe("base must be a .ccAvatar or .iAvatar file: C:/b/x.iProp. Nothing was changed in CC5.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the schema takes only a character file (or 'default') as the base", () => {
    expect(RecipeSchema.safeParse({ base: "C:/b/x.iProp" }).success).toBe(false);
    expect(RecipeSchema.safeParse({ base: "C:/b/Kevin.ccAvatar" }).success).toBe(true);
    expect(RecipeSchema.safeParse({ base: "C:/b/Kevin.iAvatar" }).success).toBe(true);
    expect(RecipeSchema.safeParse({ base: "default" }).success).toBe(true);
    expect(RecipeSchema.shape.base.description).toContain("A base file that does not exist is refused before anything changes.");
  });
});

const RED_VELVET = "C:/Templates/Makeup/Lip Makeup/Makeup & SFX/Red Velvet.ccSkinGenPreset";
const SKIN_FACT = { kind: "material", mesh: "CC_Base_Body", material: "Std_Skin_Head", field: "diffuse",
  before: [204, 153, 128], after: [255, 255, 255] };
const PALLOR_FACT = { kind: "material", mesh: "CC_Base_Body", material: "Std_Skin_Head", field: "param",
  name: "_BaseColorMap Brightness", before: [0], after: [0.2] };
const changes = (facts: unknown[]) => ({ complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 420,
  compared: { worn: 3, morphs: 12, materials: 30 }, skipped: 0, truncated: false, facts });
const SKIN_LINE = "skin colour on Std_Skin_Head: (0.8, 0.6, 0.502) -> (1, 1, 1)";
const PALLOR_LINE = "pallor (_BaseColorMap Brightness) on Std_Skin_Head: 0 -> 0.2";

describe("what a load changed besides what it was for (F-34)", () => {
  it("puts the load's CHECK lines under its step, counts the steps in the head, and ends with the footer", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: "C:/c/Pants.ccCloth", target: "Kevin", changes: changes([
      { kind: "worn_added", group: "clothing", id: "13", name: "Pants" },
      { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" }]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/c/Pants.ccCloth"], pose_file: "C:/p/Supine.rlMotion" }));
    expect(results[0]).toEqual({ step: "asset Pants.ccCloth", ok: true, detail: "",
      checks: ["removed Boxers (clothing): CC5 may have swapped it out for this item"],
      notChecked: ["how it sits on the character (skin or scalp showing through, floating items): run check_fit"] });
    expect(results[1]).toEqual({ step: "pose_file", ok: true, detail: "" });
    const text = formatReport(results);
    const lines = text.split("\n");
    expect(lines[0]).toBe("All 2 steps succeeded. 1 step(s) changed more than they are for (CHECK lines below).");
    expect(lines.slice(1, 4)).toEqual(["OK   asset Pants.ccCloth",
      "     CHECK removed Boxers (clothing): CC5 may have swapped it out for this item", "OK   pose_file"]);
    expect(text).toContain("NOT CHECKED: how it sits on the character (skin or scalp showing through, floating items): " +
      "run check_fit (asset Pants.ccCloth)");
    expect(text).not.toContain("Applied:");  // load_asset's own reply shows those; the recipe report does not
    expect(lines.at(-1)).toBe("These steps ran: do not run them again because of the CHECK lines; show those lines to the user.");
  });

  it("lists each NOT CHECKED line once, with every step it applies to", () => {
    const text = formatReport([
      { step: "asset Shirt.ccCloth", ok: true, detail: "", notChecked: ["fit"] },
      { step: "asset Pants.ccCloth", ok: true, detail: "", notChecked: ["fit", "WARNING: x"] },
    ]);
    expect(text).toContain("NOT CHECKED: fit (asset Shirt.ccCloth, asset Pants.ccCloth)");
    expect(text).toContain("NOT CHECKED: WARNING: x (asset Pants.ccCloth)");
    expect(text.match(/NOT CHECKED: fit/g)).toHaveLength(1);
    expect(text).not.toContain("These steps ran");
  });

  it("stepFromJob reports a job that finished after the answer like a step of the recipe", () => {
    const done = stepFromJob("asset Eyes_02.ccEye (after the answer)",
      { done: true, failed: false, result: { success: true, path: "C:/e/Eyes_02.ccEye", target: "Kevin", changes: changes([]) } },
      "C:/e/Eyes_02.ccEye");
    expect(done).toMatchObject({ step: "asset Eyes_02.ccEye (after the answer)", ok: true, detail: "" });
    expect(done.checks).toBeUndefined();
    expect(done.notChecked?.[0]).toContain("frame_camera face");
    expect(stepFromJob("x", { done: true, failed: true, result: { error: "LoadFile failed" }, answered: "Replace" }))
      .toEqual({ step: "x", ok: false, detail: "LoadFile failed (after CC5 asked 'Replace / Material Only', answered 'Replace')" });
    expect(stepFromJob("y", { done: true, failed: true, result: null })).toEqual({ step: "y", ok: false, detail: "failed" });
  });

  // RB-3: the run clicked its answer in the job before it stopped; the wait after the answer clicked nothing.
  it("stepFromJob names the button the run clicked before the stop when the last wait clicked none", () => {
    expect(stepFromJob("z (after the answer)", { done: true, failed: false, result: { success: true } }, undefined, "Replace"))
      .toEqual({ step: "z (after the answer)", ok: true,
        detail: "CC5 asked 'Replace / Material Only'; answered 'Replace' (the user's answer earlier in this run)" });
    expect(stepFromJob("z", { done: true, failed: false, result: { success: true }, answered: "Material Only" }, undefined, "Replace")
      .detail).toBe("CC5 asked 'Replace / Material Only'; answered 'Material Only' (the user's answer earlier in this run)");
    expect(stepFromJob("z", { done: true, failed: false, result: { success: true } }).detail).toBe("");
  });
});

describe("a skin setting the recipe sets again later is not a surprise (D2 vs F-34)", () => {
  it("a preset's skin colour followed by skin_rgb is a NOTE, not a CHECK", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Kevin", changes: changes([SKIN_FACT]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], assets: [RED_VELVET] }));
    expect(results.map((r) => r.step)).toEqual(["asset Red Velvet.ccSkinGenPreset", "skin_rgb"]);
    expect(results[0].checks).toBeUndefined();
    expect(results[0].superseded).toEqual([`${SKIN_LINE}: set again by skin_rgb later in this recipe`]);
    const text = formatReport(results);
    expect(text.split("\n")[0]).toBe("All 2 steps succeeded.");
    expect(text).toContain(`     NOTE ${SKIN_LINE}: set again by skin_rgb later in this recipe`);
    expect(text).not.toContain("     CHECK ");
    expect(text).not.toContain("These steps ran");
  });

  it("without a later skin_rgb the preset's skin colour stays a CHECK", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Kevin", changes: changes([SKIN_FACT]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [RED_VELVET] }));
    expect(results[0].checks).toEqual([SKIN_LINE]);
    expect(results[0].superseded).toBeUndefined();
  });

  it("a pallor change stays a CHECK after skin_rgb alone, and becomes a NOTE after skin_condition", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Kevin", changes: changes([PALLOR_FACT]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rgbOnly = await applyRecipe(bridge as any, RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], assets: [RED_VELVET] }));
    expect(rgbOnly[0].checks).toEqual([PALLOR_LINE]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withCondition = await applyRecipe(bridge as any, RecipeSchema.parse({
      skin_condition: { condition: "pale", amount: 0.5 }, assets: [RED_VELVET] }));
    expect(withCondition[0].checks).toBeUndefined();
    expect(withCondition[0].superseded).toEqual([`${PALLOR_LINE}: set again by skin_condition later in this recipe`]);
  });

  it("supersedeChecks is idempotent, and a failed or stopped skin step supersedes nothing", () => {
    const results: StepResult[] = [
      { step: "asset Red Velvet.ccSkinGenPreset", ok: true, detail: "", checks: [SKIN_LINE, "removed Boxers (clothing)"] },
      { step: "skin_rgb (after the answer)", ok: true, detail: "" },
    ];
    supersedeChecks(results);
    const once = structuredClone(results);
    expect(supersedeChecks(results)).toEqual(once);
    expect(results[0].checks).toEqual(["removed Boxers (clothing)"]);
    expect(results[0].superseded).toEqual([`${SKIN_LINE}: set again by skin_rgb (after the answer) later in this recipe`]);
    const notRun: StepResult[] = [
      { step: "asset X.ccSkinGenPreset", ok: true, detail: "", checks: [SKIN_LINE] },
      { step: "skin_rgb", ok: false, detail: "No avatar in scene" },
      { step: "skin_condition", ok: false, detail: GUARD, stopped: { ran: false, wait_ms: 1 } },
    ];
    expect(supersedeChecks(notRun)[0]).toEqual({ step: "asset X.ccSkinGenPreset", ok: true, detail: "", checks: [SKIN_LINE] });
  });

  // RB-2: the load's CHECK lines were capped at 12 before superseding, so '... and 1 more' hid the opacity change.
  it("supersedes every skin line of a load before the report caps its CHECK lines", async () => {
    const skin = ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"];
    const facts = skin.flatMap((material) => [
      { kind: "material", mesh: "CC_Base_Body", material, field: "diffuse", before: [204, 153, 128], after: [255, 255, 255] },
      { kind: "material", mesh: "CC_Base_Body", material, field: "param", name: "_BaseColorMap Brightness", before: [0], after: [0.2] },
      { kind: "material", mesh: "CC_Base_Body", material, field: "param", name: "_BaseColorMap Saturation", before: [0], after: [-0.1] },
    ]);
    const opacity = { kind: "material", mesh: "CC_Base_Eyebrow", material: "Std_Eyebrow", field: "opacity", before: 1, after: 0 };
    const OPACITY_LINE = "opacity on CC_Base_Eyebrow/Std_Eyebrow: 1 -> 0";
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Kevin", changes: changes([...facts, opacity]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({
      skin_condition: { condition: "pale", amount: 0.5 }, assets: [RED_VELVET] }));
    expect(results[0].checks).toEqual([OPACITY_LINE]);
    expect(results[0].superseded).toHaveLength(12);
    const text = formatReport(results);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "All 2 steps succeeded. 1 step(s) changed more than they are for (CHECK lines below).",
      "OK   asset Red Velvet.ccSkinGenPreset", `     CHECK ${OPACITY_LINE}`]);
    expect(text).not.toContain("... and");
  });

  it("caps a step's CHECK lines only when the report shows them", () => {
    const morphs = Array.from({ length: 14 }, (_, i) => `shaping morph m${i}: 0 -> 0.1`);
    const text = formatReport([{ step: "asset Pants.ccCloth", ok: true, detail: "", checks: morphs }]);
    expect(text).toContain(`     CHECK shaping morph m11: 0 -> 0.1\n     CHECK ... and 2 more\n`);
    expect(text).not.toContain("shaping morph m12:");
  });

  // X-1: the preset went to the selected character, skin_rgb to the first one: its skin colour was never set again.
  it("keeps a load's skin lines as CHECK lines when it went to another character than the first", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Camila",
      changes: { ...changes([SKIN_FACT]), target: "Camila", target_is_first: false } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], assets: [RED_VELVET] }));
    const where = "applied to Camila, not confirmed to be the first character (skin_rgb and skin_condition change the first)";
    expect(results[0]).toMatchObject({ step: "asset Red Velvet.ccSkinGenPreset", ok: true, detail: where, otherTarget: "Camila",
      checks: [SKIN_LINE] });
    expect(results[0].superseded).toBeUndefined();
    expect(formatReport(results).split("\n").slice(0, 5)).toEqual([
      "All 2 steps succeeded. 1 step(s) changed more than they are for (CHECK lines below).",
      `OK   asset Red Velvet.ccSkinGenPreset: ${where}`, `     CHECK ${SKIN_LINE}`, `     NOTE ${SKINGEN_SESSION_NOTE}`,
      "OK   skin_rgb"]);
    // The first character's own load carries no target note.
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Kevin", changes: changes([SKIN_FACT]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [RED_VELVET] }));
    expect(first[0]).not.toHaveProperty("otherTarget");
    expect(first[0].detail).toBe("");
    // With the comparison off the plugin cannot tell (target_is_first false, no facts): nothing to supersede, no note.
    mockJobs(bridge, { load_asset: { success: true, path: RED_VELVET, target: "Kevin",
      changes: { ...changes([]), complete: false, target: "Kevin", target_is_first: false } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unchecked = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [RED_VELVET] }));
    expect(unchecked[0]).not.toHaveProperty("otherTarget");
    expect(unchecked[0].detail).not.toContain("first character");
  });

  it("supersedeChecks leaves the lines of a load on another character", () => {
    const results: StepResult[] = [
      { step: "asset Red Velvet.ccSkinGenPreset", ok: true, detail: "", checks: [SKIN_LINE], otherTarget: "Camila" },
      { step: "skin_condition", ok: true, detail: "" },
    ];
    expect(supersedeChecks(results)[0]).toEqual({ step: "asset Red Velvet.ccSkinGenPreset", ok: true, detail: "",
      checks: [SKIN_LINE], otherTarget: "Camila" });
  });
});

// TS-3: a failed load that changed things said so in its error, but the report never said what it changed.
describe("what a failed load still changed", () => {
  it("keeps the load's Applied and Changed lines as NOTE lines under its FAIL line", async () => {
    mockJobs(bridge, { load_asset: { success: false, error: "LoadFile failed (CC5 reported an error, but it changed 1 thing)",
      changes: changes([{ kind: "worn_added", group: "clothing", id: "13", name: "Pants" }]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/c/Pants.ccCloth"], pose_file: "C:/p/Supine.rlMotion" }));
    expect(results[0]).toMatchObject({ step: "asset Pants.ccCloth", ok: false, changed: ["Applied: added Pants (clothing)"] });
    expect(results[0].checks).toBeUndefined();
    expect(formatReport(results)).toContain("FAIL asset Pants.ccCloth: LoadFile failed (CC5 reported an error, but it changed " +
      "1 thing)\n     NOTE Applied: added Pants (clothing)\nOK   pose_file");
  });

  it("shows no such lines for a load that worked", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: "C:/c/Pants.ccCloth", target: "Kevin",
      changes: changes([{ kind: "worn_added", group: "clothing", id: "13", name: "Pants" }]) } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/c/Pants.ccCloth"] }));
    expect(results[0]).toEqual({ step: "asset Pants.ccCloth", ok: true, detail: "",
      notChecked: ["how it sits on the character (skin or scalp showing through, floating items): run check_fit"] });
  });
});

describe("remainingRecipe", () => {
  const tex = (material_name: string) => ({ mesh_name: "CC_Base_Body", material_name, channel: "diffuse" as const,
    image_path: `C:/t/${material_name}.png` });
  const cut = { image_path: "C:/o/cut.png", region: "arms" as const, strength: 80 };
  const recipe = RecipeSchema.parse({
    skin_rgb: [0.8, 0.6, 0.5], skin_condition: { condition: "pale", amount: 0.5 },
    assets: ["C:/e/Eyes.ccEye", "C:/c/Shirt.ccCloth", "C:/s/Boots.ccShoes"],
    textures: [tex("Std_Skin_Arm"), tex("Std_Skin_Leg")], overlays: [cut],
    expression: [{ name: "Smile", weight: 0.5 }], pose_file: "C:/p/Supine.rlMotion",
  });
  const done = (step: string): StepResult => ({ step, ok: true, detail: "" });
  const stopped = (step: string, ran: boolean): StepResult => ({ step, ok: false, detail: "asked", stopped: { ran, wait_ms: 1 } });

  it("after a step CC5 ran: from the next step, and skin_condition keeps the colour it tints", () => {
    const remaining = remainingRecipe(recipe, [done("asset Eyes.ccEye"), stopped("skin_rgb", true)]);
    expect(remaining).toEqual({
      skin_condition: { condition: "pale", amount: 0.5, base_rgb: [0.8, 0.6, 0.5] },
      textures: [tex("Std_Skin_Arm"), tex("Std_Skin_Leg")], overlays: [cut],
      assets: ["C:/c/Shirt.ccCloth", "C:/s/Boots.ccShoes"],
      expression: [{ name: "Smile", weight: 0.5 }], pose_file: "C:/p/Supine.rlMotion",
    });
    expect(planRecipe(remaining).map((s) => s.name)).toEqual(["skin_condition", "texture Std_Skin_Arm/diffuse",
      "texture Std_Skin_Leg/diffuse", "overlay cut.png", "asset Shirt.ccCloth", "asset Boots.ccShoes", "expression", "pose_file"]);
    // The remaining recipe goes back through the tool schema unchanged.
    expect(RecipeSchema.parse(JSON.parse(JSON.stringify(remaining)))).toEqual(remaining);
  });

  it("after a step that never ran: from that step", () => {
    const results = [done("asset Eyes.ccEye"), done("skin_rgb"), done("skin_condition"), done("texture Std_Skin_Arm/diffuse"),
      stopped("texture Std_Skin_Leg/diffuse", false)];
    expect(remainingRecipe(recipe, results)).toEqual({
      textures: [tex("Std_Skin_Leg")], overlays: [cut], assets: ["C:/c/Shirt.ccCloth", "C:/s/Boots.ccShoes"],
      expression: [{ name: "Smile", weight: 0.5 }], pose_file: "C:/p/Supine.rlMotion",
    });
  });

  it("without a stop: from the first step without a result; nothing left gives {}", () => {
    expect(remainingRecipe(recipe, [done("asset Eyes.ccEye"), done("skin_rgb"), done("skin_condition"),
      done("texture Std_Skin_Arm/diffuse"), done("texture Std_Skin_Leg/diffuse"), done("overlay cut.png"),
      done("asset Shirt.ccCloth"), done("asset Boots.ccShoes")]))
      .toEqual({ expression: [{ name: "Smile", weight: 0.5 }], pose_file: "C:/p/Supine.rlMotion" });
    expect(remainingRecipe(recipe, Array.from({ length: 10 }, (_, i) => done(`step ${i}`)))).toEqual({});
    expect(remainingRecipe(RecipeSchema.parse({}), [])).toEqual({});
  });
});

describe("formatReport", () => {
  it("summarises failures", () => {
    const text = formatReport([{ step: "base", ok: true, detail: "" }, { step: "pose_file", ok: false, detail: "nope" }]);
    expect(text).toContain("1 of 2 steps failed");
    expect(text).toContain("FAIL pose_file: nope");
  });

  it("says where a recipe stopped, what is left and how to go on, with a recipe the schema takes back", () => {
    const remaining = RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], assets: ["C:/c/Shirt.ccCloth"],
      skin_condition: { condition: "pale", amount: 0.5, base_rgb: [0.8, 0.6, 0.5] } });
    const results: StepResult[] = [
      { step: "body_preset", ok: true, detail: "" },
      { step: "asset Eyes_02.ccEye", ok: false, detail: waiting("cmd_ab12cd34_3"), stopped: { ran: true, job_id: "cmd_ab12cd34_3",
        question: LAYER, wait_ms: STEP_JOB_WAIT_MS, asset: "C:/e/Eyes_02.ccEye" } },
    ];
    const text = formatReport(results, { id: "cmd_ab12cd34_3", remaining, layer: true });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Stopped at asset Eyes_02.ccEye: CC5 is waiting for an answer nobody has given yet, so nothing " +
      "after it was sent to CC5.");
    expect(lines[1]).toBe("OK   body_preset");
    // Batch F review #29: the plugin's "then check its result with job_status(...)" names continue_after in the report.
    expect(lines[2]).toBe(`WAIT asset Eyes_02.ccEye: ${waitingLine("cmd_ab12cd34_3")}`);
    expect(text).not.toContain("job_status(");
    expect(lines).toContain("Still to run after the answer: skin_rgb, skin_condition, asset Shirt.ccCloth.");
    const prefix = 'To go on after the answer: apply_character_recipe with continue_after "cmd_ab12cd34_3" and this recipe: ';
    const go = lines.find((l) => l.startsWith(prefix)) ?? "";
    const reparsed = RecipeSchema.safeParse(JSON.parse(go.slice(prefix.length)));
    expect(reparsed.success).toBe(true);
    expect(reparsed.data).toEqual(remaining);
    expect(lines.at(-1)).toBe(`${LAYER_STOP_ADVICE} layer_answer answers the same question for the rest of this recipe only.`);
    // RB-6: layer_answer takes no Cancel, so the advice says how to go on after one.
    expect(lines.at(-1)).toContain(CANCEL_NOT_CARRIED);
    expect(text).not.toContain("Do not call job_status");
  });

  it("says how to go on after another question, and after a window that kept a step from running", () => {
    const ran = formatReport([{ step: "skin_rgb", ok: false, detail: "asked", stopped: { ran: true, job_id: "cmd_9", wait_ms: 1 } }],
      { id: "cmd_9", remaining: {}, layer: false });
    expect(ran).toContain("Nothing else was left to run.");
    expect(ran).toContain("Do not call job_status or run the step again: continue_after waits for it and reports it.");
    expect(ran).not.toContain(LAYER_STOP_ADVICE);
    const notRan = formatReport([{ step: "skin_rgb", ok: false, detail: GUARD, stopped: { ran: false, wait_ms: 1 } }],
      { id: "stop_4", remaining: { skin_rgb: [0.8, 0.6, 0.5] }, layer: false });
    // The queue guard holds a command behind a window to close in CC5 too (F-85, F-99), not only behind a question.
    expect(notRan.split("\n")[0]).toBe("Stopped at skin_rgb: it could not run while CC5 had a window open (a question " +
      "nobody has answered, a window to close in CC5 because it has no buttons or this bridge cannot read its buttons, " +
      "or a progress window), so nothing after it was sent to CC5.");
    // Batch F review #10: the step never ran, so it waits for whichever window kept it from running.
    expect(notRan).toContain("Still to run once the window is answered or closed in CC5: skin_rgb.");
    expect(notRan).toContain('To go on once the window is answered or closed in CC5: apply_character_recipe with ' +
      'continue_after "stop_4" and this recipe: {"skin_rgb":[0.8,0.6,0.5]}');
    expect(notRan).toContain("continue_after runs it once the window is closed.");
    expect(notRan).not.toContain("after the answer");
  });

  // Batch F review #10: SkinGen's About box (left open by bake_skin_textures, F-84) or a progress window kept a step from
  // running, and the report said "Still to run after the answer" / "To go on after the answer", with nothing to answer.
  it("says a step any window kept from running goes on once the window is answered or closed in CC5, as a batch does", () => {
    // The queue guard's texts (server.py _modal_dialog_error), as the bridge sends them with HTTP 400.
    const guards = [
      'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool can close it), ' +
        "then try again.",
      'CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or close it in Character ' +
        "Creator 5 (no MCP tool can click its buttons), then try again.",
      'CC5 is busy with "Exporting" (the progress window of a command it is running) - try again when it closes. Do not ' +
        "cancel it unless the user asks; they cancel it in CC5.",
      GUARD,
    ];
    for (const guard of guards) {
      const text = formatReport([{ step: "skin_rgb", ok: false, detail: guard, stopped: { ran: false, wait_ms: 1 } }],
        { id: "stop_5", remaining: RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5], pose_file: "C:/p/Supine.rlMotion" }),
          layer: false });
      expect(text.split("\n")).toEqual([
        "Stopped at skin_rgb: it could not run while CC5 had a window open (a question nobody has answered, a window to " +
          "close in CC5 because it has no buttons or this bridge cannot read its buttons, or a progress window), so " +
          "nothing after it was sent to CC5.",
        `WAIT skin_rgb: ${guard}`,
        "Still to run once the window is answered or closed in CC5: skin_rgb, pose_file.",
        'To go on once the window is answered or closed in CC5: apply_character_recipe with continue_after "stop_5" ' +
          'and this recipe: {"skin_rgb":[0.8,0.6,0.5],"pose_file":"C:/p/Supine.rlMotion"}',
        "Show the user the window above; they answer or close it in CC5 unless it is a plain confirmation of what they " +
          "asked for. Do not run the step again yourself: continue_after runs it once the window is closed.",
      ]);
    }
  });
});

// Review #19 and #3: a step waiting in a window answer_cc5_dialog cannot click was reported as "CC5 is waiting for an
// answer nobody has given yet", with the advice to answer a plain confirmation.
describe("a stop in a window that is answered or closed in CC5 itself (F-94, F-99)", () => {
  const ABOUT = { title: "CCSkinGen", text: "SkinGen 2.0\nS/N : (serial)", buttons: [] };
  const FBX = { title: "Export FBX", text: "", buttons: [], buttons_unreadable: true };
  const waitIn = (question: CC5Dialog): StepResult[] => [{ step: "asset Eyes_02.ccEye", ok: false, detail: "asked",
    stopped: { ran: true, job_id: "cmd_ab12cd34_3", question, wait_ms: STEP_JOB_WAIT_MS, asset: "C:/e/Eyes_02.ccEye" } }];
  const stop = { id: "cmd_ab12cd34_3", remaining: RecipeSchema.parse({ skin_rgb: [0.8, 0.6, 0.5] }), layer: false };

  it("tells a question from a window to close and from one whose buttons the bridge cannot read", () => {
    expect(waitKind(undefined)).toBe("question");
    expect(waitKind(LAYER)).toBe("question");
    expect(waitKind(ABOUT)).toBe("close");
    expect(waitKind(FBX)).toBe("unreadable");
    expect(waitKind({ title: "Character Creator 5", text: "Unsaved project data found", buttons: [] })).toBe("question");
  });

  // Review #8, in dialog.ts's order (formatDialog, isWindowToClose): text that could not be read comes first, then the
  // untitled Welcome page and windows with no buttons, then buttons the bridge cannot read.
  it("takes a dialog whose text could not be read for a question the user answers in CC5, never a window to close", () => {
    expect(waitKind({ ...FBX, text_read: false })).toBe("unread");
    expect(waitKind({ ...ABOUT, text_read: false })).toBe("unread");
    expect(waitKind({ title: "", text: "", buttons: [], text_read: false })).toBe("unread");  // not the Welcome page
    // server.py answer_dialog refuses unread text before it looks for the crash-recovery prompt.
    expect(waitKind({ title: "Unsaved project data found", text: "", buttons: [], text_read: false })).toBe("unread");
    expect(waitKind({ ...LAYER, text_read: true })).toBe("question");
    // An untitled window without text is CC5's Welcome page even when its buttons cannot be read (dialog.ts).
    expect(waitKind({ title: "", text: "", buttons: [], buttons_unreadable: true })).toBe("close");
    // The crash-recovery prompt stays a question even when its buttons cannot be read (dialog.ts, server.py).
    expect(waitKind({ title: "Character Creator 5", text: "Unsaved project data found. Restore it?", buttons: [],
      buttons_unreadable: true })).toBe("question");
  });

  // Review #8: the report said to answer a plain confirmation yourself, and answer_cc5_dialog refuses such a dialog.
  it("asks the user to answer a question whose text could not be read in CC5, never to answer it yourself", () => {
    const text = formatReport(waitIn({ title: "Character Creator 5", text: "", buttons: [], text_read: false }), stop);
    expect(text.split("\n")).toEqual([
      "Stopped at asset Eyes_02.ccEye: CC5 is waiting for an answer nobody has given yet, so nothing after it was " +
        "sent to CC5.",
      "WAIT asset Eyes_02.ccEye: asked",
      "Still to run after the answer: skin_rgb.",
      'To go on after the answer: apply_character_recipe with continue_after "cmd_ab12cd34_3" and this recipe: ' +
        '{"skin_rgb":[0.8,0.6,0.5]}',
      "Ask the user to answer that question in Character Creator 5: its text could not be read, so answer_cc5_dialog " +
        "refuses it (it may be CC5's crash-recovery prompt). Do not call job_status or run the step again: " +
        "continue_after waits for it and reports it.",
    ]);
    expect(text).not.toContain("Answer a plain confirmation");
  });

  it("says to close a window with no buttons in CC5, never to answer it", () => {
    const text = formatReport(waitIn(ABOUT), stop);
    expect(text.split("\n")).toEqual([
      "Stopped at asset Eyes_02.ccEye: CC5 has a window open with no buttons that nobody has closed yet, so nothing " +
        "after it was sent to CC5.",
      "WAIT asset Eyes_02.ccEye: asked",
      "Still to run once the window is closed: skin_rgb.",
      'To go on once the window is closed: apply_character_recipe with continue_after "cmd_ab12cd34_3" and this ' +
        'recipe: {"skin_rgb":[0.8,0.6,0.5]}',
      "Ask the user to close that window in Character Creator 5: it has no buttons, so no MCP tool can close it. Do " +
        "not call job_status or run the step again: continue_after waits for it and reports it once the window is closed.",
    ]);
    expect(text).not.toContain("Answer a plain confirmation");
  });

  it("says to answer or close a window whose buttons the bridge cannot read in CC5", () => {
    const lines = formatReport(waitIn(FBX), stop).split("\n");
    expect(lines[0]).toBe("Stopped at asset Eyes_02.ccEye: CC5 has a window open whose buttons this bridge cannot " +
      "read, and nobody has answered or closed it yet, so nothing after it was sent to CC5.");
    expect(lines.slice(2)).toEqual([
      "Still to run once the window is answered or closed: skin_rgb.",
      'To go on once the window is answered or closed: apply_character_recipe with continue_after "cmd_ab12cd34_3" ' +
        'and this recipe: {"skin_rgb":[0.8,0.6,0.5]}',
      "Ask the user to answer or close that window in Character Creator 5: this bridge cannot read or click its " +
        "buttons. Do not call job_status or run the step again: continue_after waits for it and reports it once the " +
        "window is closed.",
    ]);
  });
});

// Batch F review #29: the plugin's texts for a job waiting in a window end by telling the agent to read its result with
// job_status, while the report's advice says not to call job_status: continue_after waits for that job and reports it.
describe("a WAIT line names continue_after, not job_status, for the stopped step's own job (review #29)", () => {
  // server.py _dialog_view of SkinGen's About box (tests/py/test_dialogs.py ABOUT_TEXT), and its name in the texts.
  const ABOUT = { title: "CCSkinGen", text: "S/N : (serial)\nProduct Version : 1.0.0824.1\nwww.reallusion.com",
    buttons: [], text_read: true };
  const CLOSE = 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool can ' +
    "close it)";
  /** The lines of the report of a recipe stopped at a step CC5 started as job cmd_ab12cd34_3 and that waits with `detail`. */
  const report = (detail: string, question: CC5Dialog, blocked?: string) => formatReport([{ step: "asset Eyes_02.ccEye",
    ok: false, detail, stopped: { ran: true, job_id: "cmd_ab12cd34_3", question, wait_ms: STEP_JOB_WAIT_MS,
      ...(blocked ? { blocked_by: blocked } : {}) } }], { id: "cmd_ab12cd34_3", remaining: {}, layer: false }).split("\n");

  it("after a question, as server.py _waiting_dialog_error words it", () => {
    const lines = report(waiting("cmd_ab12cd34_3", "Apply the preset?", "OK, Cancel"), APPLY);
    expect(lines[1]).toBe('WAIT asset Eyes_02.ccEye: CC5 is waiting for an answer to "Apply the preset?" (the ' +
      '"Character Creator 5" window). Buttons: OK, Cancel. The command is still running as job cmd_ab12cd34_3: answer it ' +
      "with answer_cc5_dialog (ask the user when it is a real choice), then continue_after reads its result.");
    expect(lines.at(-1)).toContain("Do not call job_status or run the step again: continue_after waits for it and reports it.");
    expect(lines.join("\n")).not.toContain("job_status(");
  });

  it("in a window to close, as batch F's plugin words it and as jobDialogMessage words an older plugin's", () => {
    const batchF = `${CLOSE}. The command is still running as job cmd_ab12cd34_3: read its result with ` +
      'job_status("cmd_ab12cd34_3") once it is closed.';
    const lines = report(batchF, ABOUT);
    expect(lines[1]).toBe(`WAIT asset Eyes_02.ccEye: ${CLOSE}. The command is still running as job cmd_ab12cd34_3: ` +
      "continue_after reads its result once it is closed.");
    expect(lines.at(-1)).toContain("Do not call job_status or run the step again");
    // jobs.ts jobDialogMessage: an older plugin's "answer it with answer_cc5_dialog" text, worded as formatDialog does.
    const older = `${CLOSE}.\nJob cmd_ab12cd34_3 is waiting on this window; read its result with job_status once it is ` +
      "closed.";
    expect(report(older, ABOUT).slice(1, 3)).toEqual([`WAIT asset Eyes_02.ccEye: ${CLOSE}.`,
      "Job cmd_ab12cd34_3 is waiting on this window; continue_after reads its result once it is closed."]);
  });

  it("keeps another job's words: the job the step is queued behind, and the one a step that never ran waits for", () => {
    // server.py _job_status for a job queued behind another job's window (tests/py/test_dialogs.py).
    const queued = "Job cmd_ab12cd34_3 has not started: it is queued behind job cmd_ab12cd34_2. " +
      `${CLOSE}. The command is still running as job cmd_ab12cd34_2: read its result with job_status("cmd_ab12cd34_2") ` +
      "once it is closed. Job cmd_ab12cd34_3 runs once that window is closed; read its result with " +
      'job_status("cmd_ab12cd34_3").';
    expect(report(queued, ABOUT, "cmd_ab12cd34_2")[1]).toBe("WAIT asset Eyes_02.ccEye: Job cmd_ab12cd34_3 has not " +
      `started: it is queued behind job cmd_ab12cd34_2. ${CLOSE}. The command is still running as job cmd_ab12cd34_2: ` +
      'read its result with job_status("cmd_ab12cd34_2") once it is closed. Job cmd_ab12cd34_3 runs once that window is ' +
      "closed; continue_after reads its result.");
    // A base step stopped in the delete it runs first never ran: continue_after waits for that delete and runs the
    // whole step again, without reporting the delete.
    const text = waiting("cmd_7", "Delete Old?", "OK, Cancel");
    const notRan = formatReport([{ step: "base", ok: false, detail: text,
      stopped: { ran: false, job_id: "cmd_7", question: APPLY, wait_ms: BASE_LOAD_WAIT_MS } }],
    { id: "cmd_7", remaining: { base: "default" }, layer: false });
    expect(notRan.split("\n")[1]).toBe(`WAIT base: ${text}`);
  });
});

// F-98 (live): after Chad's Cancel on _Hazel1 Eyes' Replace / Material Only question, the continued recipe reported
// "OK   asset _Hazel1 Eyes.ccEye (after the answer)" and "All 2 steps succeeded", though CC5 applied nothing.
describe("a step answered Cancel in CC5 is CANCELLED, never OK (F-98)", () => {
  const EYES = "C:/e/Eyes_02.ccEye";
  const CANCEL = [{ button: "Cancel", title: "Character Creator 5" }];
  /** Every job finishes at once with `result`; its status names the buttons clicked while it waited in a CC5 dialog. */
  const finishWith = (result: unknown, answers: unknown[]) => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5", action: "load_asset", status: "done", result, answers });
  };

  it("reports a load answered Cancel as CANCELLED, counts it apart from the rest, and runs the rest", async () => {
    finishWith({ success: true, path: EYES, target: "Kevin", changes: changes([]) }, CANCEL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [EYES], skin_rgb: [0.8, 0.6, 0.5] }));
    expect(results[0]).toMatchObject({ step: "asset Eyes_02.ccEye", ok: false, cancelled: true, detail: CANCELLED_NOTHING });
    expect(results[0].checks).toBeUndefined();
    expect(results[1]).toEqual({ step: "skin_rgb", ok: true, detail: "" });
    const text = formatReport(results);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "1 of 2 steps was cancelled in CC5; 1 succeeded.",
      "CANCELLED asset Eyes_02.ccEye (answered Cancel in CC5, so CC5 applied nothing)",
      "OK   skin_rgb",
    ]);
    expect(text).not.toContain("All 2 steps succeeded");
  });

  it("drops the 'nothing changed' CHECK line of a cancelled load: that is what the Cancel did", async () => {
    const recipe = RecipeSchema.parse({ assets: ["C:/c/Shirt.ccCloth"] });
    const shirt = { success: true, path: "C:/c/Shirt.ccCloth", target: "Kevin", changes: changes([]) };
    finishWith(shirt, [{ button: "&Cancel", title: "Character Creator 5" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results[0]).toMatchObject({ step: "asset Shirt.ccCloth", ok: false, cancelled: true, detail: CANCELLED_NOTHING });
    expect(results[0].checks).toBeUndefined();
    const text = formatReport(results);
    expect(text.split("\n")[0]).toBe("1 of 1 steps was cancelled in CC5; 0 succeeded.");
    expect(text).not.toContain("     CHECK ");
    // Without the Cancel, the same load keeps its CHECK line: CC5 reported it done, but nothing changed.
    finishWith(shirt, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plain = await applyRecipe(bridge as any, recipe);
    expect(plain[0]).toMatchObject({ step: "asset Shirt.ccCloth", ok: true });
    expect(plain[0].checks).toHaveLength(1);
  });

  it("says what a cancelled load still changed, under its CANCELLED line", async () => {
    finishWith({ success: true, path: "C:/c/Pants.ccCloth", target: "Kevin", changes: changes([
      { kind: "worn_added", group: "clothing", id: "13", name: "Pants" },
      { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" }]) }, [{ button: "cancel", title: "Character Creator 5" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: ["C:/c/Pants.ccCloth"] }));
    expect(results[0]).toMatchObject({ step: "asset Pants.ccCloth", ok: false, cancelled: true, detail: CANCELLED_CHANGED,
      checks: ["removed Boxers (clothing): CC5 may have swapped it out for this item"],
      changed: ["Applied: added Pants (clothing)"] });
    expect(formatReport(results)).toContain("\nCANCELLED asset Pants.ccCloth (answered Cancel in CC5, but CC5 still " +
      "changed what the lines below say)\n     CHECK removed Boxers (clothing): CC5 may have swapped it out for this " +
      "item\n     NOTE Applied: added Pants (clothing)\n");
  });

  it("takes only a Cancel among a job's answers, whatever their shape", async () => {
    finishWith({ success: true, path: EYES, target: "Kevin", changes: changes([]) }, [
      { button: "Material Only", title: "Character Creator 5" }, { button: "OK", title: "Character Creator 5" }, "Cancel",
      { title: "Cancel" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [EYES] }));
    expect(results[0]).toMatchObject({ step: "asset Eyes_02.ccEye", ok: true, detail: "" });
    expect(results[0]).not.toHaveProperty("cancelled");
    expect(answeredCancel([{ button: " &Cancel " }])).toBe(true);
    expect(answeredCancel([{ button: "Cancel All" }])).toBe(false);
    expect(answeredCancel({ button: "Cancel" })).toBe(false);
    expect(answeredCancel(undefined)).toBe(false);
  });

  it("stepFromJob reports a job that finished after a Cancel as cancelled, after its error when it failed", () => {
    // Batch F review #11: nothing compared either step, so neither is said to have applied nothing.
    expect(stepFromJob("skin_rgb (after the answer)", { done: true, failed: false, result: { success: true }, answers: CANCEL }))
      .toEqual({ step: "skin_rgb (after the answer)", ok: false, cancelled: true, detail: CANCELLED_UNSURE });
    expect(stepFromJob("x", { done: true, failed: true, result: { error: "LoadFile failed" }, answers: CANCEL }))
      .toEqual({ step: "x", ok: false, cancelled: true, detail: `${CANCELLED_UNSURE}; LoadFile failed` });
    // A content load whose own comparison ran in full and found nothing.
    expect(stepFromJob("asset Eyes_02.ccEye (after the answer)", { done: true, failed: false,
      result: { success: true, path: EYES, target: "Kevin", changes: changes([]) }, answers: CANCEL }, EYES).detail)
      .toBe(CANCELLED_NOTHING);
    expect(stepFromJob("y", { done: true, failed: false, result: { success: true } })).toEqual({ step: "y", ok: true, detail: "" });
  });

  // Batch F review #11: "CC5 applied nothing" was said of every cancelled step without a change line, also when nothing
  // had compared it: a pose, or a load with the comparison switched off or from an older plugin.
  it("says CC5 applied nothing only when the load's own comparison ran in full and found nothing", async () => {
    const cancelledLoad = async (result: unknown): Promise<StepResult> => {
      finishWith(result, CANCEL);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [EYES] })))[0];
    };
    expect((await cancelledLoad({ success: true, path: EYES, target: "Kevin", changes: changes([]) })).detail)
      .toBe(CANCELLED_NOTHING);
    // CC5_CHANGE_CHECK=0: the plugin sends an empty comparison marked incomplete (cc5_changes._stub), and a WARNING note.
    const off = "WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared";
    const unchecked = await cancelledLoad({ success: true, path: EYES, target: "Kevin",
      changes: { ...changes([]), complete: false }, notes: [off] });
    expect(unchecked).toMatchObject({ step: "asset Eyes_02.ccEye", ok: false, cancelled: true, detail: CANCELLED_UNSURE });
    expect(formatReport([unchecked]).split("\n").slice(0, 3)).toEqual([
      "1 of 1 steps was cancelled in CC5; 0 succeeded.",
      "CANCELLED asset Eyes_02.ccEye (answered Cancel in CC5, so CC5 may not have done it)",
      `NOT CHECKED: ${off} (asset Eyes_02.ccEye)`,
    ]);
    // A plugin older than the change report, materials the comparison ran out of time for, and colours CC5 reports late.
    const late = "WARNING: CC5 may report material colours late after an undo, a redo or a load that left a colour " +
      "unsettled (seen for a colour set without an undo, F-90; not checked live after an undo), so whether this load " +
      "changed the colour on CC_Base_Eye/Std_Cornea_R was not checked: capture, then compare";
    for (const result of [{ success: true, path: EYES, target: "Kevin" },
      { success: true, path: EYES, target: "Kevin", changes: { ...changes([]), skipped: 2 } },
      { success: true, path: EYES, target: "Kevin", changes: changes([]), notes: [late] }]) {
      expect((await cancelledLoad(result)).detail).toBe(CANCELLED_UNSURE);
    }
    // A pose is no content load: nothing compares it.
    finishWith({ success: true }, CANCEL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await applyRecipe(bridge as any, RecipeSchema.parse({ pose_file: "C:/p/Supine.rlMotion" })))
      .toEqual([{ step: "pose_file", ok: false, cancelled: true, detail: CANCELLED_UNSURE }]);
  });

  it("counts cancelled steps apart from failures, and supersedes nothing with a cancelled skin step", () => {
    const cancelled = (step: string): StepResult => ({ step, ok: false, cancelled: true, detail: CANCELLED_NOTHING });
    expect(formatReport([cancelled("asset A.ccEye"), { step: "skin_rgb", ok: false, detail: "No avatar in scene" },
      { step: "pose_file", ok: true, detail: "" }]).split("\n")).toEqual([
      "1 of 3 steps was cancelled in CC5; 1 failed; 1 succeeded.",
      "CANCELLED asset A.ccEye (answered Cancel in CC5, so CC5 applied nothing)",
      "FAIL skin_rgb: No avatar in scene",
      "OK   pose_file",
    ]);
    expect(formatReport([cancelled("asset A.ccEye"), cancelled("asset B.ccEye")]).split("\n")[0])
      .toBe("2 of 2 steps were cancelled in CC5; 0 succeeded.");
    const preset: StepResult = { step: "asset X.ccSkinGenPreset", ok: true, detail: "", checks: [SKIN_LINE] };
    expect(supersedeChecks([preset, cancelled("skin_rgb (after the answer)")])[0].checks).toEqual([SKIN_LINE]);
  });
});

// F-91 (live 2026-10-07): a .ccSkinGenPreset load starts a SkinGen session, which hides hair, brows and clothing until a
// content load ends it, and that load first asks SKINGEN_QUESTION. load_asset said so; a recipe report said neither.
describe("a SkinGen preset's session and the question that ends it (F-91)", () => {
  const SKINGEN = { title: "Character Creator 5", text: SKINGEN_QUESTION, buttons: ["OK", "Cancel"] };
  const SHIRT = "C:/c/Shirt.ccCloth";
  const LOADED = { success: true, path: RED_VELVET, target: "Kevin", changes: changes([]) };

  it("shows the session a SkinGen preset started under its line", async () => {
    mockJobs(bridge, { load_asset: LOADED });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [RED_VELVET], skin_rgb: [0.8, 0.6, 0.5] }));
    expect(results[0]).toMatchObject({ step: "asset Red Velvet.ccSkinGenPreset", ok: true, detail: "",
      loadNotes: [SKINGEN_SESSION_NOTE] });
    expect(formatReport(results).split("\n").slice(0, 4)).toEqual([
      "All 2 steps succeeded.", "OK   asset Red Velvet.ccSkinGenPreset", `     NOTE ${SKINGEN_SESSION_NOTE}`, "OK   skin_rgb"]);
    // The same load finishing after an answer (continue_after) says it too.
    expect(stepFromJob("asset Red Velvet.ccSkinGenPreset (after the answer)", { done: true, failed: false, result: LOADED },
      RED_VELVET).loadNotes).toEqual([SKINGEN_SESSION_NOTE]);
  });

  it("claims no session for a SkinGen preset answered Cancel in CC5", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5", action: "load_asset", status: "done", result: LOADED,
      answers: [{ button: "Cancel", title: "Character Creator 5" }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ assets: [RED_VELVET] }));
    expect(results[0]).toMatchObject({ step: "asset Red Velvet.ccSkinGenPreset", ok: false, cancelled: true,
      detail: CANCELLED_NOTHING });
    expect(results[0]).not.toHaveProperty("loadNotes");
    expect(formatReport(results)).not.toContain(SKINGEN_SESSION_NOTE);
  });

  it("gives the rule for CC5's SkinGen question when the recipe stopped on it", async () => {
    bridge.startJob.mockImplementation(async (_action: string, params: Record<string, unknown>) =>
      ({ job_id: params.file_path === RED_VELVET ? "cmd_ab12cd34_1" : "cmd_ab12cd34_2" }));
    bridge.getJob.mockImplementation(async (id: string) => (id === "cmd_ab12cd34_1"
      ? { job_id: id, action: "load_asset", status: "done", result: LOADED }
      : { job_id: id, action: "load_asset", status: "running", dialog: SKINGEN,
        dialog_message: waiting(id, SKINGEN_QUESTION, "OK, Cancel") }));
    const recipe = RecipeSchema.parse({ assets: [RED_VELVET, SHIRT] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    const report = formatReport(results, { id: "cmd_ab12cd34_2", remaining: remainingRecipe(recipe, results), layer: false });
    expect(report.split("\n")).toEqual([
      "Stopped at asset Shirt.ccCloth: CC5 is waiting for an answer nobody has given yet, so nothing after it was sent " +
        "to CC5.",
      "OK   asset Red Velvet.ccSkinGenPreset",
      `     NOTE ${SKINGEN_SESSION_NOTE}`,
      `WAIT asset Shirt.ccCloth: ${waitingLine("cmd_ab12cd34_2", SKINGEN_QUESTION, "OK, Cancel")}`,
      `NOT CHECKED: ${results[0].notChecked?.[0]} (asset Red Velvet.ccSkinGenPreset)`,
      "Nothing else was left to run.",
      'To go on after the answer: apply_character_recipe with continue_after "cmd_ab12cd34_2" and this recipe: {}',
      "Show the user the question. Answer a plain confirmation of exactly what they asked for yourself and say so; for " +
        "a real choice let them pick (a window no MCP command waits on may be the user's own: ask them). Do not call " +
        "job_status or run the step again: continue_after waits for it and reports it.",
      SKINGEN_QUESTION_RULE,
    ]);
  });

  it("knows the question by its words in the title or text, and gives the rule only for a question Claude can answer", () => {
    const report = (question: CC5Dialog) => formatReport([{ step: "asset Shirt.ccCloth", ok: false, detail: "asked",
      stopped: { ran: true, job_id: "cmd_ab12cd34_2", question, wait_ms: STEP_JOB_WAIT_MS } }],
    { id: "cmd_ab12cd34_2", remaining: {}, layer: false });
    const split = { ...SKINGEN, text: "Applying this content will DEACTIVATE the current\nSkinGen  session.\nContinue?" };
    expect(report(split).split("\n").at(-1)).toBe(SKINGEN_QUESTION_RULE);
    expect(report({ ...SKINGEN, title: "Deactivate the current SkinGen session", text: "Continue?" }).split("\n").at(-1))
      .toBe(SKINGEN_QUESTION_RULE);
    expect(report(LAYER)).not.toContain(SKINGEN_QUESTION_RULE);
    expect(report(APPLY)).not.toContain(SKINGEN_QUESTION_RULE);
    // A window the user answers or closes in CC5 (no buttons found, or text not read): no MCP tool can click its OK.
    expect(report({ ...SKINGEN, buttons: [] })).not.toContain(SKINGEN_QUESTION_RULE);
    expect(report({ ...SKINGEN, text_read: false })).not.toContain(SKINGEN_QUESTION_RULE);
  });
});

// Review #12: the recipe's base step deletes through delete_avatar, which clears CC5's selection first (F-92: deleting
// a character while one of its worn items is selected can crash CC5), but the report dropped what delete_avatar noted.
// Review #2: delete_avatar fails closed, so a delete that went ahead notes at most the selection it cleared.
describe("the base step deletes through delete_avatar and shows what it noted (F-92)", () => {
  const CLEARED = "CC5's selection (Pants) was cleared before the delete: deleting a character while one of its worn " +
    "items is selected can crash CC5 (F-92).";
  const REFUSED = "CC5's selection (Pants) could not be cleared, so nothing was deleted: deleting a character while " +
    "one of its worn items is selected can crash CC5 (F-92). Run clear_selection (or deselect everything in Character Creator 5), then delete again.";

  it("shows delete_avatar's notes in the base step's line", async () => {
    bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }, { name: "Older", id: "2", type: "avatar" }]);
    // The first delete cleared the selection (Pants); the second found nothing selected, so it noted nothing.
    bridge.deleteAvatar.mockResolvedValueOnce({ success: true, removed: ["Old"], notes: [CLEARED] })
      .mockResolvedValueOnce({ success: true, removed: ["Older"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ base: "default", skin_rgb: [0.8, 0.6, 0.5] }));
    expect(results).toEqual([{ step: "base", ok: true, detail: "", notes: [CLEARED] },
      { step: "skin_rgb", ok: true, detail: "" }]);
    expect(formatReport(results).split("\n")).toEqual([
      "All 2 steps succeeded.", `OK   base: ${CLEARED}`, "OK   skin_rgb"]);
    // The result is JSON from the plugin: a note that is not text is left out.
    bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }]);
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Old"], notes: [7, "", CLEARED] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await applyRecipe(bridge as any, RecipeSchema.parse({ base: "default" })))[0].notes).toEqual([CLEARED]);
  });

  it("keeps the notes after the error of a base load that failed", async () => {
    mockJobs(bridge, { create_default_avatar: { success: false, error: "LoadFile failed" } });
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Old"], notes: [CLEARED] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ base: "default" }));
    expect(results).toEqual([{ step: "base", ok: false, detail: "LoadFile failed", notes: [CLEARED] }]);
    expect(formatReport(results).split("\n")).toEqual(["1 of 1 steps failed.", `FAIL base: LoadFile failed. ${CLEARED}`]);
  });

  // Batch F review #11: the base load was answered Cancel after the base step had deleted the characters in the scene,
  // and the report said "CC5 applied nothing" next to the delete's own note.
  it("says a base load answered Cancel may not have loaded, after the characters in the scene were deleted", async () => {
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Old"], notes: [CLEARED] });
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_6" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_6", action: "create_default_avatar", status: "done",
      result: { success: true, name: "Default Character" }, answers: [{ button: "Cancel", title: "Character Creator 5" }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ base: "default" }));
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(results).toEqual([{ step: "base", ok: false, cancelled: true, detail: CANCELLED_BASE, notes: [CLEARED] }]);
    expect(formatReport(results).split("\n")).toEqual(["1 of 1 steps was cancelled in CC5; 0 succeeded.",
      "CANCELLED base (answered Cancel in CC5, so CC5 may not have done it; any characters that were in the scene had " +
        `already been deleted) ${CLEARED}`]);
    // The same step once it finished after the answer (continue_after names it "base (after the answer)").
    expect(stepFromJob("base (after the answer)", { done: true, failed: false, result: { success: true },
      answers: [{ button: "Cancel" }] })).toEqual({ step: "base (after the answer)", ok: false, cancelled: true,
      detail: CANCELLED_BASE });
  });

  it("ends the recipe at the base step when delete_avatar refused because the selection could not be cleared", async () => {
    // The bridge answers a failed command with HTTP 400 and the command's error (cc5-bridge.ts describeHttpError).
    bridge.deleteAvatar.mockRejectedValue(new BridgeHttpError(REFUSED, 400));
    const recipe = RecipeSchema.parse({ base: "C:/Bases/Male.ccAvatar", skin_rgb: [0.8, 0.6, 0.5], pose_file: "C:/p/Supine.rlMotion" });
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe, { fileExists: () => true, onStep: (s) => seen.push(s.step) });
    const failed: StepResult = { step: "base", ok: false, detail: `could not remove existing avatar Old: ${REFUSED}`,
      notRun: ["skin_rgb", "pose_file"] };
    expect(results).toEqual([failed]);
    expect(seen).toEqual(["base"]);
    expect(started).toEqual([]);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(formatReport(results).split("\n")).toEqual([
      "Ended at base: that step failed, so nothing after it was sent to CC5.",
      `FAIL base: could not remove existing avatar Old: ${REFUSED}`,
      "Not sent to CC5: skin_rgb, pose_file.",
      "Run clear_selection (or deselect everything in CC5), then run the whole recipe again: its base step deletes " +
        "the characters in the scene first.",
    ]);
    // The same refusal as the plugin's result, not as an HTTP error, ends the recipe the same way.
    bridge.deleteAvatar.mockResolvedValue({ success: false, error: REFUSED });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await applyRecipe(bridge as any, recipe, { fileExists: () => true })).toEqual([failed]);
    expect(started).toEqual([]);
  });

  it("still runs the rest after any other failed delete, and still stops at an open dialog", async () => {
    const recipe = RecipeSchema.parse({ base: "default", skin_rgb: [0.8, 0.6, 0.5] });
    bridge.deleteAvatar.mockRejectedValue(new BridgeHttpError("Avatar not found: Old (the scene has no characters)", 400));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await applyRecipe(bridge as any, recipe)).toEqual([
      { step: "base", ok: false, detail: "Avatar not found: Old (the scene has no characters)" },
      { step: "skin_rgb", ok: true, detail: "" }]);
    bridge.deleteAvatar.mockRejectedValue(new BridgeHttpError(GUARD, 400));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await applyRecipe(bridge as any, recipe)).toEqual([
      { step: "base", ok: false, detail: GUARD, stopped: { ran: false, wait_ms: BASE_LOAD_WAIT_MS } }]);
  });

  // Review #2: delete_avatar fails closed; both of its refusals are built with _SELECTED_ITEM_CRASH, which names F-92.
  it("knows delete_avatar's refusals by the F-92 they name (cc5_api.py)", () => {
    const py = fs.readFileSync(new URL("../cc5-plugin/cc5_api.py", import.meta.url), "utf-8");
    const crash = /_SELECTED_ITEM_CRASH = "([^"]+)"/.exec(py)?.[1] ?? "";
    expect(isSelectionRefusal(crash)).toBe(true);
    for (const name of ["DELETE_SELECTION_NOT_CLEARED", "DELETE_SELECTION_NOT_READ"]) {
      const text = new RegExp(`${name} = \\(([\\s\\S]*?)\\)\\r?\\n`).exec(py)?.[1] ?? "";
      expect(text).toContain("so nothing was deleted: ");
      expect(text).toContain("+ _SELECTED_ITEM_CRASH +");
    }
    expect(isSelectionRefusal(REFUSED)).toBe(true);
    expect(isSelectionRefusal("Avatar not found: Old. Characters in the scene: Kevin.")).toBe(false);
    expect(isSelectionRefusal(undefined)).toBe(false);
    // The fixtures above are the plugin's: a delete that goes ahead notes only the selection it cleared (CLEARED), and
    // its old WARNING note for a selection it could not clear, deleting all the same, is gone.
    expect(py).toContain('notes.append(f"CC5\'s selection ({cleared}) was cleared before the delete: {_SELECTED_ITEM_CRASH}.")');
    expect(crash).toBe("deleting a character while one of its worn items is selected can crash CC5 (F-92)");
    expect(py).not.toContain("could not be cleared before the delete");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { applyRecipe, formatReport, RecipeSchema } from "../src/recipe.js";
import { createMockBridge } from "./helpers/mock-bridge.js";
import type { MockBridge } from "./helpers/mock-bridge.js";

let bridge: MockBridge;
const ok = { success: true };

beforeEach(() => {
  bridge = createMockBridge();
  for (const m of ["createDefaultAvatar", "loadAsset", "setMultipleMorphs", "setSkinColor", "setSkinCondition",
    "applySkinOverlay", "applyPose", "setExpression"] as const) bridge[m].mockResolvedValue(ok);
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
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
      "base", "body_preset", "skin_rgb", "skin_condition", "asset Jacket.iClothes", "asset Short.ccHair",
      "overlay bruise.png", "pose_file"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(bridge.setMultipleMorphs.mock.calls[0][0][0].value).toBeCloseTo(0.35);
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(bridge.deleteAvatar.mock.invocationCallOrder[0]).toBeLessThan(bridge.createDefaultAvatar.mock.invocationCallOrder[0]);
    expect(bridge.setSkinCondition).toHaveBeenCalledWith("pale", 0.7, "all", [0.8, 0.6, 0.5]);
  });

  it("keeps going after a failed step", async () => {
    bridge.loadAsset.mockResolvedValueOnce({ success: false, error: "File not found" });
    const recipe = RecipeSchema.parse({ assets: ["C:/x/Missing.iClothes"], pose_file: "C:/p/Supine.rlMotion" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, recipe);
    expect(results[0]).toMatchObject({ ok: false, detail: "File not found" });
    expect(results[1]).toMatchObject({ step: "pose_file", ok: true });
  });

  it("records thrown errors as failed steps", async () => {
    bridge.applyPose.mockRejectedValue(new Error("bridge down"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await applyRecipe(bridge as any, RecipeSchema.parse({ pose_file: "C:/p/a.rlMotion" }));
    expect(results[0]).toMatchObject({ ok: false, detail: "bridge down" });
  });
});

describe("formatReport", () => {
  it("summarises failures", () => {
    const text = formatReport([{ step: "base", ok: true, detail: "" }, { step: "pose_file", ok: false, detail: "nope" }]);
    expect(text).toContain("1 of 2 steps failed");
    expect(text).toContain("FAIL pose_file: nope");
  });
});

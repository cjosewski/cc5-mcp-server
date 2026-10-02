import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { runBatch, registerBatchTools } from "../../src/tools/batch.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
const ok = { success: true };

beforeEach(() => {
  bridge = createMockBridge();
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: 1, type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue(ok);
  bridge.loadAsset.mockResolvedValue(ok);
  bridge.setSkinCondition.mockResolvedValue(ok);
  bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, triangles: 2000, materials: 4 } });
  bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
  bridge.getJob.mockResolvedValue({ job_id: "cmd_1", action: "export_for_unity", status: "done",
    result: { success: true, fbx: "D:/P/Assets/Pt/A/A.fbx", folder: "D:/P/Assets/Pt/A", files: [] } });
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
    expect(bridge.loadAsset).toHaveBeenCalledWith("D:/Base/Male.ccAvatar");
    expect(bridge.loadAsset).toHaveBeenCalledTimes(2);
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("Old");
    expect(m.variants.map((v) => v.ok)).toEqual([true, true]);
    expect(m.variants[0].budget_pass).toBe(true);
    expect(writes).toEqual([1, 2]);
  });

  it("records a failed export and continues", async () => {
    bridge.getJob.mockResolvedValueOnce({ job_id: "cmd_1", action: "export_for_unity", status: "failed",
      result: { success: false, error: "disk full" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await runBatch(bridge as any, input, () => undefined);
    expect(m.variants[0]).toMatchObject({ ok: false, error: "disk full" });
    expect(m.variants[1].ok).toBe(true);
  });

  it("exports a posed variant with include_current_pose", async () => {
    bridge.applyPose.mockResolvedValue(ok);
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
    expect(bridge.loadAsset).toHaveBeenCalledTimes(1);
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
    bridge.getJob.mockResolvedValueOnce({ job_id: "cmd_1", action: "export_for_unity", status: "done", result: {
      success: true, fbx: "D:/P/Assets/Pt/A/A.fbx", folder: "D:/P/Assets/Pt/A", files: [],
      notes: ["target_tool=Unity preset applied", "WARNING: SetTextureSize failed: x"] } });
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

  it("says in the tool summary that the face budget was not checked", async () => {
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

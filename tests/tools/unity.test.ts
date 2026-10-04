import { describe, it, expect, beforeEach } from "vitest";
import {
  registerUnityTools, isInUnityAssets, isLocalAbsolute, evaluateBudget, estimateTextureGpuMb, QUEST_DEFAULTS,
} from "../../src/tools/unity.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerUnityTools(server as any, bridge as any);
});

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

describe("export_for_unity", () => {
  const handler = () => server.getRegisteredTool("export_for_unity");

  // Live CC5 5.13 (Task 18): the first FBX export of a CC5 session crashed CC5 in about 3 of 4 sessions.
  it("tells the agent to save the character before the session's first FBX export", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "export_for_unity")?.[1] as string;
    expect(description).toContain("save_character");
    expect(description).toContain("first FBX export");
  });

  it("refuses a folder outside Assets without calling CC5", async () => {
    const r = await handler()({ unity_dir: "D:/Exports", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
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
      result: { success: true, fbx: "D:/P/Assets/C/P1/P1.fbx", folder: "D:/P/Assets/C/P1", files: [{ path: "x.png", bytes: 1048576 }], notes: [] },
    });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ character_name: "P1" }));
    expect(r.content[0].text).toContain("P1.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("returns the job id when the export outlasts the wait", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "export_for_unity", status: "running" });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", wait_seconds: 0 });
    expect(r.content[0].text).toContain("cmd_9");
  });

  const exported = (extra: Record<string, unknown>) => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_1", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "D:/P/Assets/C/P1/P1.fbx", folder: "D:/P/Assets/C/P1", files: [], notes: [], ...extra } });
  };

  it("flags an export CC5 made without some of its settings, and prints the warnings", async () => {
    exported({ notes: ["target_tool=Unity preset applied", "WARNING: SetTextureSize failed: bad enum"] });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", texture_size: 2048 });
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
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("without the requested FBX settings");
    expect(r.content[0].text).toContain("were NOT applied");
  });

  it("says a subdivided export needs sub_d_level for the budget check", async () => {
    exported({ export_level: 2 });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", sub_d_level: 2 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("about 16x the base mesh's triangles");
    expect(r.content[0].text).toContain("give check_quest_budget sub_d_level 2");
  });

  it("adds no subdivision note at the base level", async () => {
    exported({ export_level: 0 });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", sub_d_level: 0 });
    expect(r.content[0].text).not.toContain("sub_d_level");
  });

  it("says a posed export carries the pose as a one-frame animation clip", async () => {
    // Live CC5 5.13 (Task 18): the pose is in a 1-frame take. Live Unity 6000.2.10f1 (Task 20): the imported model
    // already shows that pose (head 0.69 m vs 1.61 m), so there is no clip to apply by hand. Task 20 fix round 1
    // re-imported both exports as Humanoid (avatar created from the model, as the Trauma Sim patient body is): the
    // posed model still shows the pose (0.000 m from the Generic import), and the avatar is not built from the sitting pose,
    // but it differs from the unposed export's avatar by up to 0.14 m (feet), hence the Copy From Other Avatar advice.
    exported({});
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", include_current_pose: true });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("one-frame animation clip");
    expect(r.content[0].text).toContain("Unity shows the imported model in that pose with a Generic or Humanoid rig");
    expect(r.content[0].text).toContain("copy the avatar from an unposed export of the same character");
    expect(r.content[0].text).toContain("Copy From Other Avatar");
    expect(r.content[0].text).not.toContain("bind pose");
    exported({});
    const plain = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1" });
    expect(plain.content[0].text).not.toContain("animation clip");
  });

  it("describes include_current_pose without the bind-pose claim Unity disproved", () => {
    const call = server.tool.mock.calls.find((c) => c[0] === "export_for_unity");
    const shape = call?.[2] as Record<string, { description?: string }>;
    expect(shape.include_current_pose.description).toContain("Unity shows the imported model in that pose with a Generic or Humanoid rig");
    expect(shape.include_current_pose.description).toContain("Copy From Other Avatar");
    expect(shape.include_current_pose.description).not.toContain("bind pose");
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

  it("fails when estimated texture GPU memory is over budget, and reports file size as information", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `t${i}.png`, bytes: 1_048_576, width: 2048, height: 2048 }));
    const r = evaluateBudget(stats, many, QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("Texture GPU memory");
    expect(r.lines.join("\n")).toContain("Texture files on disk: 40.0 MiB");
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

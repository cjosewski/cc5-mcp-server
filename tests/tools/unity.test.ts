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
});

describe("evaluateBudget", () => {
  const stats = { success: true, meshes: [], totals: { vertices: 1, faces: 40_000, materials: 10 } };

  it("passes within limits", () => {
    const r = evaluateBudget(stats, [{ path: "a.png", bytes: 1_000_000, width: 2048, height: 2048 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(true);
  });

  it("fails on faces and oversize textures, naming the offenders", () => {
    const r = evaluateBudget({ ...stats, totals: { vertices: 1, faces: 80_000, materials: 10 } },
      [{ path: "Body_Diffuse.png", bytes: 1, width: 4096, height: 4096 }], QUEST_DEFAULTS);
    expect(r.pass).toBe(false);
    expect(r.lines.join("\n")).toContain("80,000");
    expect(r.lines.join("\n")).toContain("Body_Diffuse.png");
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
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({});
    expect(r.content[0].text).toContain("no texture images scanned");
  });

  it("reports mesh totals without an export folder", async () => {
    bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 9, faces: 100, materials: 2 } });
    const r = await server.getRegisteredTool("check_quest_budget")({});
    expect(r.content[0].text).toContain("PASS");
  });
});

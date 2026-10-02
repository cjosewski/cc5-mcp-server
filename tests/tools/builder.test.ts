import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerBuilderTools, searchContent } from "../../src/tools/builder.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBuilderTools(server as any, bridge as any);
});

describe("searchContent", () => {
  it("matches every word in the file name across folders", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "cloth_upper" ? ["C:/c/Military Jacket Camo.iClothes", "C:/c/Hoodie.iClothes"] : ["C:/s/Combat Boots.ccShoes"]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "camo jacket", ["cloth_upper", "shoes"]);
    expect(hits).toEqual([{ folder: "cloth_upper", path: "C:/c/Military Jacket Camo.iClothes" }]);
  });

  it("skips folders that error", async () => {
    bridge.browseContent.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(["C:/s/Combat Boots.ccShoes"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "boots", ["cloth_upper", "shoes"]);
    expect(hits).toHaveLength(1);
  });

  it("ignores error strings browse_content returns inside its list", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "shoes" ? ["C:/s/Combat Boots.ccShoes"] : ["Unknown folder type: texture. Available: cloth, shoes, pose"]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await searchContent(bridge as any, "pose", ["shoes", "texture"])).toEqual([]);
  });

  it("throws when every folder fails (e.g. CC5 is down)", async () => {
    bridge.browseContent.mockRejectedValue(new Error("ECONNREFUSED"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(searchContent(bridge as any, "boots", ["cloth_upper", "shoes"])).rejects.toThrow();
  });
});

describe("search_content", () => {
  it("returns a bridge error when every folder fails", async () => {
    bridge.browseContent.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("CC5 bridge error");
  });

  it("notes skipped folders when only some fail", async () => {
    bridge.browseContent.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(["C:/s/Combat Boots.ccShoes"]);
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Combat Boots");
    expect(r.content[0].text).toContain("skipped folders");
  });
});

describe("headshot_from_photo", () => {
  it("rejects non-photos", async () => {
    const r = await server.getRegisteredTool("headshot_from_photo")({ photo_path: "C:/a/b.gif" });
    expect(r.isError).toBe(true);
  });
});

describe("apply_character_recipe", () => {
  it("flags partial failure as an error", async () => {
    mockJobs(bridge, { load_asset: { success: false, error: "File not found" } });
    const r = await server.getRegisteredTool("apply_character_recipe")({ recipe: { assets: ["C:/x/a.iClothes"] } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("FAIL asset a.iClothes: File not found");
  });

  it("stops at the next step when the client cancels, and says so", async () => {
    const started = mockJobs(bridge);
    const ac = new AbortController();
    bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return { success: true }; });
    const r = await server.getRegisteredTool("apply_character_recipe")(
      { recipe: { skin_condition: { condition: "pale", amount: 1 }, pose_file: "C:/p/Supine.rlMotion" } },
      { signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Cancelled: the remaining steps were not started\./);
    expect(started).toEqual([]);
  });

  it("sends a progress notification per step when the client asks for progress", async () => {
    mockJobs(bridge);
    bridge.setSkinCondition.mockResolvedValue({ success: true });
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await server.getRegisteredTool("apply_character_recipe")(
      { recipe: { skin_condition: { condition: "pale", amount: 1 }, pose_file: "C:/p/Supine.rlMotion" } },
      { signal: new AbortController().signal, _meta: { progressToken: 7 }, sendNotification });
    expect(sendNotification.mock.calls.map(([n]) => [n.params.progress, n.params.message]))
      .toEqual([[1, "OK skin_condition"], [2, "OK pose_file"]]);
  });
});

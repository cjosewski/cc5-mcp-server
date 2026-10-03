import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerSkinTools } from "../../src/tools/skin.js";
import { CC5Bridge } from "../../src/cc5-bridge.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSkinTools(server as any, bridge as any);
});

describe("apply_skin_overlay", () => {
  it("rejects non-image files without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/a/b.txt", region: "all", strength: 50 });
    expect(r.isError).toBe(true);
    expect(bridge.applySkinOverlay).not.toHaveBeenCalled();
  });

  it("says overlays are image files the user provides, not CC5 image_layer content", () => {
    // Live CC5: browse_content('image_layer') lists .iImgLayer stage items, never PNG/JPG/TGA overlays.
    const description = server.tool.mock.calls.find((c) => c[0] === "apply_skin_overlay")?.[1] as string;
    expect(description).toContain("PNG/JPG/TGA");
    expect(description).not.toContain("image_layer");
  });

  it("applies and lists materials", async () => {
    bridge.applySkinOverlay.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head"] });
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "head", strength: 70 });
    expect(bridge.applySkinOverlay).toHaveBeenCalledWith("C:/o/bruise.png", "head", 70);
    expect(r.content[0].text).toContain("Std_Skin_Head");
  });
});

describe("remove_skin_overlay", () => {
  it("lists the materials it cleared", async () => {
    bridge.removeSkinOverlay.mockResolvedValue({ success: true, removed_from: ["Std_Skin_Head"], no_overlay: ["Std_Skin_Body"] });
    const r = await server.getRegisteredTool("remove_skin_overlay")({ region: "all" });
    expect(r.content[0].text).toBe("Removed overlays from: Std_Skin_Head");
  });

  it("says when the region had no overlay to remove", async () => {
    bridge.removeSkinOverlay.mockResolvedValue({ success: true, removed_from: [], no_overlay: ["Std_Skin_Head"] });
    const r = await server.getRegisteredTool("remove_skin_overlay")({ region: "head" });
    expect(r.content[0].text).toBe("No skin overlay to remove in region 'head'");
  });
});

describe("set_skin_condition", () => {
  it("passes condition and amount", async () => {
    bridge.setSkinCondition.mockResolvedValue({ success: true, applied_to: [] });
    await server.getRegisteredTool("set_skin_condition")({ condition: "pale", amount: 0.8, region: "all" });
    expect(bridge.setSkinCondition).toHaveBeenCalledWith("pale", 0.8, "all", undefined);
  });

  it("says pale lightens and desaturates rather than tints", () => {
    // Live CC5 5.13 (Task 18): a tint can only darken, so pallor uses the Digital Human skin shader's offsets.
    const description = server.tool.mock.calls.find((c) => c[0] === "set_skin_condition")?.[1] as string;
    expect(description).toContain("lighter and less saturated");
  });

  it("prints CC5's warnings for skin it could not make pale", async () => {
    bridge.setSkinCondition.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head", "Std_Skin_Arm"],
      notes: ["WARNING: no pallor offsets on Std_Skin_Arm, so pale did not lighten them"] });
    const r = await server.getRegisteredTool("set_skin_condition")({ condition: "pale", amount: 0.8, region: "all" });
    expect(r.content[0].text).toContain("Skin set to pale (80%) on: Std_Skin_Head, Std_Skin_Arm");
    expect(r.content[0].text).toContain("WARNING: no pallor offsets on Std_Skin_Arm");
  });
});

describe("apply_skin_overlay through the real bridge client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports CC5's own failure text, not a connection problem, when the bridge answers 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: "No avatar in scene" }), { status: 400 })));
    const live = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSkinTools(live as any, new CC5Bridge("http://127.0.0.1:5101"));
    const r = await live.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "all", strength: 50 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("CC5 bridge error: No avatar in scene");
  });
});

describe("set_wrinkle_strength", () => {
  it("passes strength to the bridge", async () => {
    bridge.setWrinkleStrength.mockResolvedValue({ success: true, parts: ["EWrinkleFacePart_Blink"] });
    const r = await server.getRegisteredTool("set_wrinkle_strength")({ strength: 0.4 });
    expect(bridge.setWrinkleStrength).toHaveBeenCalledWith(0.4);
    expect(r.content[0].text).toContain("Wrinkle strength set to 0.4");
  });

  it("reports a missing wrinkle API as an error", async () => {
    bridge.setWrinkleStrength.mockResolvedValue({ success: false, error: "Wrinkle API (RLPy.EWrinkleFacePart_*) not available in this CC5 build" });
    const r = await server.getRegisteredTool("set_wrinkle_strength")({ strength: 0.4 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("EWrinkleFacePart");
  });
});

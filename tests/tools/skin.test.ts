import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerSkinTools } from "../../src/tools/skin.js";
import { IMAGE_TYPES_TEXT } from "../../src/tools/pipeline.js";
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
    const call = server.tool.mock.calls.find((c) => c[0] === "apply_skin_overlay");
    const description = call?.[1] as string;
    // F-68: every type the tools accept, with no caveat: live, BMP and TIFF overlays showed on the skin as a PNG does.
    expect(description).toContain(`image file the user provides (${IMAGE_TYPES_TEXT}), laid out on the CC skin UVs`);
    expect(description).not.toContain("not yet tested");
    expect(description).not.toContain("image_layer");
    const shape = call?.[2] as Record<string, { description?: string }>;
    expect(shape.image_path.description).toBe(`Absolute path to the overlay image (${IMAGE_TYPES_TEXT})`);
  });

  it("applies and lists materials", async () => {
    bridge.applySkinOverlay.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head"] });
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "head", strength: 70 });
    expect(bridge.applySkinOverlay).toHaveBeenCalledWith("C:/o/bruise.png", "head", 70);
    expect(r.content[0].text).toContain("Std_Skin_Head");
  });

  // F-65: CC5 reads a new strength back only after it renders.
  it("keeps today's reply when the plugin sends no read-back", async () => {
    bridge.applySkinOverlay.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head"], strengths: {}, stale: [] });
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "head", strength: 60 });
    expect(r.content[0].text).toBe("Applied bruise.png at 60% to: Std_Skin_Head");
  });

  it("says what CC5 reads back when it agrees", async () => {
    bridge.applySkinOverlay.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head", "Std_Skin_Body"],
      strengths: { Std_Skin_Head: 0.6, Std_Skin_Body: 0.6 }, stale: [] });
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "all", strength: 60 });
    expect(r.content[0].text).toBe("Applied bruise.png at 60% to: Std_Skin_Head, Std_Skin_Body (CC5 reads back 60%)");
    expect(r.isError).toBeUndefined();
  });

  it("names the materials CC5 still reads differently, without calling it a failure", async () => {
    bridge.applySkinOverlay.mockResolvedValue({ success: true, applied_to: ["Std_Skin_Head", "Std_Skin_Arm"],
      strengths: { Std_Skin_Head: 0, Std_Skin_Arm: 0.333 }, stale: ["Std_Skin_Head", "Std_Skin_Arm"] });
    const r = await server.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "all", strength: 60 });
    expect(r.content[0].text).toBe("Applied bruise.png at 60% to: Std_Skin_Head, Std_Skin_Arm. CC5 still reads a different "
      + "strength on Std_Skin_Head (0%), Std_Skin_Arm (33.3%) until it next renders: capture_viewport shows the overlay.");
    expect(r.isError).toBeUndefined();
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

  // X-5: the plugin sets the Diffuse Blend strength to 0 on materials without an image too (F-66), inside the
  // 'Remove Skin Overlay' action: a change and one CC5 undo step, which the reply names.
  it("says the strength was set to 0, as one CC5 undo step, when no image was removed but a strength was reset", async () => {
    bridge.removeSkinOverlay.mockResolvedValue({ success: true, removed_from: [], no_overlay: ["Std_Skin_Head", "Std_Skin_Body"],
      reset: ["Std_Skin_Head", "Std_Skin_Body"] });
    const r = await server.getRegisteredTool("remove_skin_overlay")({ region: "all" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("No overlay image in region 'all'; the Diffuse Blend strength was set to 0 on: " +
      "Std_Skin_Head, Std_Skin_Body (one CC5 undo step).");
    expect(r.content[0].text).not.toContain("No skin overlay to remove");
  });

  it("keeps the reset's warnings, and names the removed overlays as before when there were any", async () => {
    const warning = "WARNING: Std_Skin_Body: strength not reset to 0 (boom)";
    bridge.removeSkinOverlay.mockResolvedValue({ success: true, removed_from: [], no_overlay: ["Std_Skin_Head", "Std_Skin_Body"],
      reset: ["Std_Skin_Head"], notes: [warning] });  // the plugin lists a material in reset only when its reset worked
    const none = await server.getRegisteredTool("remove_skin_overlay")({ region: "all" });
    expect(none.content[0].text).toBe("No overlay image in region 'all'; the Diffuse Blend strength was set to 0 on: " +
      `Std_Skin_Head (one CC5 undo step).\n${warning}`);
    bridge.removeSkinOverlay.mockResolvedValue({ success: true, removed_from: ["Std_Skin_Head"], no_overlay: ["Std_Skin_Body"],
      reset: ["Std_Skin_Body"] });
    const some = await server.getRegisteredTool("remove_skin_overlay")({ region: "all" });
    expect(some.content[0].text).toBe("Removed overlays from: Std_Skin_Head");
  });

  // F-66: the strength goes back to 0, so a later image on the layer does not show at the old strength.
  it("appends CC5's warning when a strength was not reset to 0", async () => {
    const warning = "WARNING: Std_Skin_Head: strength not reset to 0 (AddTextureWeightKey reported an error status)";
    bridge.removeSkinOverlay.mockResolvedValue({ success: true, removed_from: ["Std_Skin_Head"], no_overlay: [],
      notes: [warning, "an ordinary note"] });
    const r = await server.getRegisteredTool("remove_skin_overlay")({ region: "head" });
    expect(r.content[0].text).toBe(`Removed overlays from: Std_Skin_Head\n${warning}`);
  });
});

// TS-2: a {success: false} result comes back as HTTP 400, and only its `error` survives that (cc5-bridge.ts
// describeHttpError). So the plugin writes what it did change and the WARNING lines into `error`, and the tool shows
// that text whole.
describe("remove_skin_overlay through the real bridge client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows what was removed and the warnings of a failure, carried in CC5's error text", async () => {
    const warning = "WARNING: Std_Skin_Body: strength not reset to 0 (boom)";
    const error = `Overlay not removed from: Std_Skin_Arm (x). Removed from: Std_Skin_Body.\n${warning}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error,
      removed_from: ["Std_Skin_Body"], no_overlay: [], notes: [warning] }), { status: 400 })));
    const live = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSkinTools(live as any, new CC5Bridge("http://127.0.0.1:5101"));
    const r = await live.getRegisteredTool("remove_skin_overlay")({ region: "all" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(error);
    expect(r.content[0].text).toContain("Removed from: Std_Skin_Body.");
    expect(r.content[0].text).toContain(warning);
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

  it("says every condition replaces a hand-made skin Brightness or Saturation change", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "set_skin_condition")?.[1] as string;
    expect(description).toContain("Every condition sets the Digital Human skin shader's base-colour Brightness and "
      + "Saturation (pale raises Brightness and lowers Saturation; the other conditions set both back to 0), so a "
      + "Brightness or Saturation change made by hand in CC5 is replaced.");
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
    // C2 (F-21): CC5's own refusal is shown as CC5 wrote it, without "CC5 bridge error".
    expect(r.content[0].text).toBe("No avatar in scene");
  });

  // TS-2: only `error` survives the 400, so the plugin names there the materials the overlay already changed.
  it("shows the materials a failed overlay had already changed, carried in CC5's error text", async () => {
    const error = "AddTextureWeightKey on Std_Skin_Arm reported an error status. Applied to: Std_Skin_Head, Std_Skin_Body.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false, error, applied_to: ["Std_Skin_Head", "Std_Skin_Body"] }), { status: 400 })));
    const live = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSkinTools(live as any, new CC5Bridge("http://127.0.0.1:5101"));
    const r = await live.getRegisteredTool("apply_skin_overlay")({ image_path: "C:/o/bruise.png", region: "all", strength: 50 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(error);
  });
});

describe("set_wrinkle_strength", () => {
  it("passes strength to the bridge", async () => {
    bridge.setWrinkleStrength.mockResolvedValue({ success: true, parts: ["EWrinkleFacePart_Blink"] });
    const r = await server.getRegisteredTool("set_wrinkle_strength")({ strength: 0.4 });
    expect(bridge.setWrinkleStrength).toHaveBeenCalledWith(0.4);
    expect(r.content[0].text).toBe("Expression wrinkle strength set to 0.4 (it shows only while an expression is active; "
      + "CC5 cannot read it back)");
  });

  // F-70: live, a neutral face did not change: the strength scales the creases of an active expression.
  it("says it sets expression wrinkles and does not age a resting face", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "set_wrinkle_strength")?.[1] as string;
    expect(description).toContain("expression wrinkles");
    expect(description).toContain("does not age a resting face");
    expect(description).toContain("search_morphs");
    expect(description).not.toContain("aging");
  });

  it("reports a missing wrinkle API as an error", async () => {
    bridge.setWrinkleStrength.mockResolvedValue({ success: false, error: "Wrinkle API (RLPy.EWrinkleFacePart_*) not available in this CC5 build" });
    const r = await server.getRegisteredTool("set_wrinkle_strength")({ strength: 0.4 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("EWrinkleFacePart");
  });
});

describe("set_skin_shader (F-38)", () => {
  it("sends the parameter and lists the skin materials that took it", async () => {
    bridge.setSkinShader.mockResolvedValue({ success: true, parameter: "Original Roughness Strength", values: [0.4],
      materials: ["Std_Skin_Head", "Std_Skin_Body", "Std_Skin_Arm", "Std_Skin_Leg"] });
    const r = await server.getRegisteredTool("set_skin_shader")({ parameter_name: "Original Roughness Strength", values: [0.4] });
    expect(bridge.setSkinShader).toHaveBeenCalledWith("Original Roughness Strength", [0.4]);
    expect(r.content[0].text).toBe(
      "Original Roughness Strength set to [0.4] on: Std_Skin_Head, Std_Skin_Body, Std_Skin_Arm, Std_Skin_Leg");
  });

  it("explains that skin shine is roughness, not glossiness", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "set_skin_shader")?.[1] as string;
    expect(description).toContain("lower = shinier");
    expect(description).toContain("seam");
  });

  // F-102 (live, set_shader_parameter): CC5 reads shader values back as float32 (RootColor 0.02 came back as
  // 0.019999999552965164); set_skin_shader echoed them as they came.
  it("echoes CC5's float32 read-back to at most 4 decimals, as set_shader_parameter does (F-102)", async () => {
    bridge.setSkinShader.mockResolvedValue({ success: true, parameter: "Original Roughness Strength",
      values: [0.4000000059604645], materials: ["Std_Skin_Head", "Std_Skin_Body"] });
    const r = await server.getRegisteredTool("set_skin_shader")({ parameter_name: "Original Roughness Strength", values: [0.4] });
    expect(r.content[0].text).toBe("Original Roughness Strength set to [0.4] on: Std_Skin_Head, Std_Skin_Body");
    bridge.setSkinShader.mockResolvedValue({ success: true, parameter: "RootColor", materials: ["Std_Skin_Head"],
      values: [0.019999999552965164, 0.017999999225139618, 0.01600000075995922] });
    const three = await server.getRegisteredTool("set_skin_shader")({ parameter_name: "RootColor", values: [0.02, 0.018, 0.016] });
    expect(three.content[0].text).toBe("RootColor set to [0.02, 0.018, 0.016] on: Std_Skin_Head");
  });

  it("rounds the values it was given the same way when CC5 sends none back", async () => {
    bridge.setSkinShader.mockResolvedValue({ success: true, materials: ["Std_Skin_Head"] });
    const r = await server.getRegisteredTool("set_skin_shader")({ parameter_name: "SSS Radius", values: [0.12345678, 2] });
    expect(r.content[0].text).toBe("SSS Radius set to [0.1235, 2] on: Std_Skin_Head");
  });
});

/**
 * Unit tests for registerAssetTools.
 * Asset tools include path validation (path traversal + extension checks)
 * before forwarding to the bridge. Bridge errors are caught by bridgeCall.
 */

import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAssetTools } from "../../src/tools/asset.js";
import { createMockBridge, SUCCESS, FAILURE } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";

import { createMockServer } from "../helpers/mock-server.js";

// ── setup ─────────────────────────────────────────────────────────────────────

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAssetTools(server as any, bridge as any);
});

// ── registration ──────────────────────────────────────────────────────────────

describe("registerAssetTools – registration", () => {
  it("registers exactly 2 tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(2);
  });

  it("registers load_asset", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "load_asset",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers export_fbx", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "export_fbx",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

// ── load_asset – happy paths ──────────────────────────────────────────────────

describe("load_asset handler – success cases", () => {
  it("returns success message with the file path on success", async () => {
    bridge.loadAsset.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/Assets/MyChar.iAvatar" });
    expect(result.content[0].text).toBe("Asset loaded: C:/Assets/MyChar.iAvatar");
  });

  it("returns failure message when bridge returns failure result", async () => {
    bridge.loadAsset.mockResolvedValue(FAILURE);
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/Assets/file.iAvatar" });
    expect(result.content[0].text).toBe("Failed to load asset: operation failed");
  });

  it("calls bridge.loadAsset with the file path", async () => {
    bridge.loadAsset.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("load_asset");
    await handler({ file_path: "C:/Assets/Clothing.iClothes" });
    expect(bridge.loadAsset).toHaveBeenCalledWith("C:/Assets/Clothing.iClothes");
  });

  it("passes target through and names the character the content was applied to", async () => {
    bridge.loadAsset.mockResolvedValue({ success: true, path: "C:/e/Green.ccEye", target: "Kevin" });
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/e/Green.ccEye", target: "Kevin" });
    expect(bridge.loadAsset).toHaveBeenCalledWith("C:/e/Green.ccEye", "Kevin");
    expect(result.content[0].text).toBe("Asset loaded: C:/e/Green.ccEye (applied to Kevin)");
  });

  it("returns content with type 'text'", async () => {
    bridge.loadAsset.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/some.ccm" });
    expect(result.content[0].type).toBe("text");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.loadAsset.mockRejectedValue(new Error("CC5 not connected"));
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/file.iAvatar" });
    expect(result.content[0].text).toContain("CC5 bridge error: CC5 not connected");
  });
});

// ── load_asset – allowed extensions ──────────────────────────────────────────

describe("load_asset handler – extension validation", () => {
  const allowedExtensions = [
    { ext: ".iAvatar", path: "C:/file.iAvatar" },
    { ext: ".ccm", path: "C:/file.ccm" },
    { ext: ".iClothes", path: "C:/file.iClothes" },
    { ext: ".iHair", path: "C:/file.iHair" },
    { ext: ".iProp", path: "C:/file.iProp" },
    { ext: ".ccFBX", path: "C:/file.ccFBX" },
    { ext: ".iClothing", path: "C:/file.iClothing" },
    { ext: ".iShoe", path: "C:/file.iShoe" },
    { ext: ".iAccessory", path: "C:/file.iAccessory" },
    { ext: ".iBody", path: "C:/file.iBody" },
    { ext: ".iSkin", path: "C:/file.iSkin" },
    { ext: ".ccavatar", path: "C:/file.ccavatar" },
    { ext: ".ccproject", path: "C:/file.ccproject" },
  ];

  for (const { ext, path } of allowedExtensions) {
    it(`accepts ${ext} extension`, async () => {
      bridge.loadAsset.mockResolvedValue(SUCCESS);
      const handler = server.getRegisteredTool("load_asset");
      const result = await handler({ file_path: path });
      expect(result.content[0].text).toContain("Asset loaded:");
      expect(bridge.loadAsset).toHaveBeenCalled();
    });
  }

  it("accepts .rlHair hairstyles and passes target through", async () => {
    bridge.loadAsset.mockResolvedValue({ success: true, path: "C:/h/Buzz Cut.rlHair", target: "Kevin" });
    const result = await server.getRegisteredTool("load_asset")({ file_path: "C:/h/Buzz Cut.rlHair", target: "Kevin" });
    expect(bridge.loadAsset).toHaveBeenCalledWith("C:/h/Buzz Cut.rlHair", "Kevin");
    expect(result.content[0].text).toBe("Asset loaded: C:/h/Buzz Cut.rlHair (applied to Kevin)");
  });

  it("rejects other .rl files (.rlHairElement)", async () => {
    const result = await server.getRegisteredTool("load_asset")({ file_path: "C:/h/Buzz Cut.rlHairElement" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension (.txt)", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/bad/file.txt" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension (.exe)", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/evil.exe" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension (.fbx) — FBX is export-only", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/model.fbx" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });
});

// ── load_asset – path traversal ───────────────────────────────────────────────

describe("load_asset handler – path traversal prevention", () => {
  it("rejects paths containing '..'", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/safe/../../../etc/passwd.iAvatar" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("rejects relative path traversal at the start", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "../../../secret.iAvatar" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });
});

// ── export_fbx – happy paths ──────────────────────────────────────────────────

describe("export_fbx handler – success cases", () => {
  it("returns success message with the output path on success", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/Export/character.fbx" });
    expect(result.content[0].text).toBe("FBX exported to: C:/Export/character.fbx (target=default)");
  });

  it("returns failure message when bridge returns failure result", async () => {
    bridge.exportFbx.mockResolvedValue(FAILURE);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/Export/character.fbx" });
    expect(result.content[0].text).toBe("Export failed: operation failed");
  });

  it("calls bridge.exportFbx with the output path", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({ output_path: "C:/out/model.fbx" });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/model.fbx", 0, {});
  });

  it("returns content with type 'text'", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out.fbx" });
    expect(result.content[0].type).toBe("text");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.exportFbx.mockRejectedValue(new Error("disk full"));
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out.fbx" });
    expect(result.content[0].text).toContain("CC5 bridge error: disk full");
  });
});

// ── export_fbx – CC5 dialog options pass-through ─────────────────────────────

describe("export_fbx handler – dialog options forwarding", () => {
  it("forwards the recommended Unreal options to the bridge", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({
      output_path: "C:/out/char.fbx",
      target_tool: "UE5",
      export_motion: true,
      embed_textures: true,
      fps: 30,
      sub_d_level: 0,
    });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/char.fbx", 0, {
      target_tool: "UE5",
      export_motion: true,
      embed_textures: true,
      fps: 30,
      sub_d_level: 0,
    });
  });

  it("forwards motion_range, texture_size and convert_image_format", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({
      output_path: "C:/out/char.fbx",
      motion_range: [0, 100],
      texture_size: 2048,
      convert_image_format: true,
    });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/char.fbx", 0, {
      motion_range: [0, 100],
      texture_size: 2048,
      convert_image_format: true,
    });
  });

  it("says a sub_d_level above the character's highest subdivision level is refused", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "export_fbx")?.[2] as Record<string, { description?: string }>;
    expect(shape.sub_d_level.description).toContain(
      "It must not exceed the character's highest subdivision level (0 without HD data); higher values are refused.");
  });

  it("tells the agent to save the character before the session's first FBX export", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "export_fbx")?.[1] as string;
    expect(description).toContain("save_character");
    expect(description).toContain("first FBX export");
  });

  it("says Convert Image Format is refused, because CC5 5.13 crashes after a scripted export with it", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "export_fbx")?.[2] as Record<string, { description?: string }>;
    expect(shape.convert_image_format.description).toContain("refuses");
    expect(shape.convert_image_format.description).toContain("crashes");
    expect(shape.include_current_pose.description).toContain("1-frame motion_range");
  });

  it("accepts a bare filename and forwards it unchanged (default dir resolved server-side)", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "character.fbx", embed_textures: true });
    expect(bridge.exportFbx).toHaveBeenCalledWith("character.fbx", 0, { embed_textures: true });
    expect(result.content[0].text).toContain("FBX exported to: character.fbx");
  });

  it("omits unset optional params from the forwarded extra object", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({ output_path: "C:/out/char.fbx", export_motion: false });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/char.fbx", 0, { export_motion: false });
  });
});

// ── export_fbx – extension validation ────────────────────────────────────────

describe("export_fbx handler – extension validation", () => {
  it("accepts .fbx extension (lowercase)", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/char.fbx" });
    expect(result.content[0].text).toBe("FBX exported to: C:/out/char.fbx (target=default)");
  });

  it("rejects non-.fbx extension (.obj)", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/char.obj" });
    expect(result.content[0].text).toContain("Export path must end with .fbx");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });

  it("rejects .gltf extension", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/char.gltf" });
    expect(result.content[0].text).toContain("Export path must end with .fbx");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });

  it("rejects no extension", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/character" });
    expect(result.content[0].text).toContain("Export path must end with .fbx");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});

// ── export_fbx – path traversal ───────────────────────────────────────────────

describe("export_fbx handler – path traversal prevention", () => {
  it("rejects paths containing '..'", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/safe/../../etc/out.fbx" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});

describe("asset validation failures carry isError", () => {
  it("load_asset rejects a bad path with isError", async () => {
    const r = await server.getRegisteredTool("load_asset")({ file_path: "C:/a/../b.iAvatar" });
    expect(r.isError).toBe(true);
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("export_fbx rejects a bad path with isError", async () => {
    const r = await server.getRegisteredTool("export_fbx")({ output_path: "C:/out/char.obj" });
    expect(r.isError).toBe(true);
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});

describe("export_fbx Blender target", () => {
  it("schema accepts target_tool Blender", () => {
    const call = server.tool.mock.calls.find((c) => c[0] === "export_fbx")!;
    const shape = call[2] as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(shape.target_tool.safeParse("Blender").success).toBe(true);
  });
});

describe("load_asset points to the right tool for files it refuses (F-21)", () => {
  it("names the tool for images, FBX and OBJ", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const text = async (file_path: string) => (await handler({ file_path })).content[0].text as string;
    expect(await text("C:/a/overlay.png")).toBe(
      "Disallowed file extension: .png (an image goes in with load_texture (a material map) or apply_skin_overlay (a skin overlay))");
    expect(await text("C:/a/box.fbx")).toBe("Disallowed file extension: .fbx (a prop or clothing FBX goes in with " +
      "import_fbx; save first, CC5 can crash on an FBX import early in a session)");
    expect(await text("C:/a/head.obj")).toContain("replace_mesh_from_obj");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("gives the same hints as the plugin (cc5_api._LOAD_ASSET_HINTS), which answers when TypeScript lets a file by", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const plugin = fs.readFileSync(new URL("../../cc5-plugin/cc5_api.py", import.meta.url), "utf-8");
    for (const file_path of ["C:/a/overlay.png", "C:/a/box.fbx", "C:/a/head.obj"]) {
      const text = (await handler({ file_path })).content[0].text as string;
      const hint = text.slice(text.indexOf(" (") + 2, -1);
      expect(plugin).toContain(`"${hint}"`);
    }
  });
});

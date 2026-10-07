/**
 * Unit tests for registerMaterialTools.
 * Tool handlers use bridgeCall, so bridge errors become content text responses
 * rather than thrown exceptions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { registerMaterialTools } from "../../src/tools/material.js";
import { createMockBridge, SUCCESS, FAILURE } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import type { MaterialInfo, DiffuseColor, SetDiffuseColorResult, ShaderParameters, SetShaderParameterResult } from "../../src/types.js";

import { createMockServer } from "../helpers/mock-server.js";

// ── setup ─────────────────────────────────────────────────────────────────────

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMaterialTools(server as any, bridge as any);
});

// ── tool registration ─────────────────────────────────────────────────────────

describe("registerMaterialTools – registration", () => {
  it("registers exactly 9 tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(9);
  });

  it("registers get_shader_parameters", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "get_shader_parameters",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers set_shader_parameter", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "set_shader_parameter",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers get_material_info", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "get_material_info",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers get_diffuse_color", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "get_diffuse_color",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers set_diffuse_color", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "set_diffuse_color",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

// ── get_material_info ─────────────────────────────────────────────────────────

describe("get_material_info handler", () => {
  const sampleInfo: MaterialInfo = {
    meshes: {
      CC_Base_Body: ["Std_Skin_Body", "Std_Skin_Arm"],
      CC_Base_Eye: ["Std_Eye_R", "Std_Eye_L"],
    },
  };

  it("returns mesh and material names on success", async () => {
    bridge.getMaterialInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_material_info");
    const result = await handler({ avatar_name: undefined });
    expect(result.content[0].text).toContain("Found 2 mesh(es)");
    expect(result.content[0].text).toContain("CC_Base_Body");
    expect(result.content[0].text).toContain("Std_Skin_Body");
  });

  it("formats materials as comma-separated list under each mesh", async () => {
    bridge.getMaterialInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_material_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC_Base_Body: Std_Skin_Body, Std_Skin_Arm");
  });

  it("reports '(no materials)' for a mesh with an empty materials array", async () => {
    const emptyMaterials: MaterialInfo = { meshes: { CC_Base_Body: [] } };
    bridge.getMaterialInfo.mockResolvedValue(emptyMaterials);
    const handler = server.getRegisteredTool("get_material_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("(no materials)");
  });

  it("returns the no-meshes message when result is an empty object", async () => {
    bridge.getMaterialInfo.mockResolvedValue({ meshes: {} });
    const handler = server.getRegisteredTool("get_material_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("No meshes found on the avatar");
  });

  it("passes avatar_name to bridge.getMaterialInfo", async () => {
    bridge.getMaterialInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_material_info");
    await handler({ avatar_name: "Hero" });
    expect(bridge.getMaterialInfo).toHaveBeenCalledWith("Hero");
  });

  it("passes undefined when avatar_name is omitted", async () => {
    bridge.getMaterialInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_material_info");
    await handler({});
    expect(bridge.getMaterialInfo).toHaveBeenCalledWith(undefined);
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.getMaterialInfo.mockRejectedValue(new BridgeUnreachableError("bridge down"));
    const handler = server.getRegisteredTool("get_material_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
    expect(result.content[0].text).toContain("Is CC5 running");
  });

  it("returns content with type 'text'", async () => {
    bridge.getMaterialInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_material_info");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });
});

// ── get_diffuse_color ─────────────────────────────────────────────────────────

describe("get_diffuse_color handler", () => {
  const sampleColor: DiffuseColor = { r: 0.8, g: 0.6, b: 0.4 };

  it("returns RGB values for the named mesh and material", async () => {
    bridge.getDiffuseColor.mockResolvedValue(sampleColor);
    const handler = server.getRegisteredTool("get_diffuse_color");
    const result = await handler({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Body" });
    expect(result.content[0].text).toContain("CC_Base_Body/Std_Skin_Body");
    expect(result.content[0].text).toContain("RGB(");
  });

  it("formats RGB values to 3 decimal places", async () => {
    bridge.getDiffuseColor.mockResolvedValue({ r: 0.1234, g: 0.5678, b: 0.9 });
    const handler = server.getRegisteredTool("get_diffuse_color");
    const result = await handler({ mesh_name: "Mesh", material_name: "Mat" });
    expect(result.content[0].text).toContain("0.123");
    expect(result.content[0].text).toContain("0.568");
    expect(result.content[0].text).toContain("0.900");
  });

  it("returns failure message when response contains an error field", async () => {
    const colorWithError: DiffuseColor = { r: 0, g: 0, b: 0, error: "mesh not found" };
    bridge.getDiffuseColor.mockResolvedValue(colorWithError);
    const handler = server.getRegisteredTool("get_diffuse_color");
    const result = await handler({ mesh_name: "Bad_Mesh", material_name: "Mat" });
    expect(result.content[0].text).toBe("Failed: mesh not found");
  });

  it("calls bridge.getDiffuseColor with mesh_name and material_name", async () => {
    bridge.getDiffuseColor.mockResolvedValue(sampleColor);
    const handler = server.getRegisteredTool("get_diffuse_color");
    await handler({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Body" });
    expect(bridge.getDiffuseColor).toHaveBeenCalledWith("CC_Base_Body", "Std_Skin_Body");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.getDiffuseColor.mockRejectedValue(new Error("timeout"));
    const handler = server.getRegisteredTool("get_diffuse_color");
    const result = await handler({ mesh_name: "Mesh", material_name: "Mat" });
    expect(result.content[0].text).toContain("CC5 bridge error: timeout");
  });

  it("handles RGB values of exactly 0 and 1 (boundary values)", async () => {
    bridge.getDiffuseColor.mockResolvedValue({ r: 0, g: 1, b: 0.5 });
    const handler = server.getRegisteredTool("get_diffuse_color");
    const result = await handler({ mesh_name: "Mesh", material_name: "Mat" });
    expect(result.content[0].text).toContain("RGB(0.000, 1.000, 0.500)");
  });
});

// F-90 (review #0): right after the bridge set a colour, CC5 still reads the colour from before until it next renders,
// so the plugin answers from the bridge's record and says so in a note (cc5_api.DIFFUSE_FROM_RECORD); the reply
// dropped it.
describe("get_diffuse_color shows the plugin's notes (F-90)", () => {
  const FROM_RECORD = "This is the colour the bridge set. CC5 reports a material's colour only after it next renders " +
    "(capture_viewport), so its own read may still give the colour from before (F-90).";

  it("puts each note on its own line after the RGB line", async () => {
    bridge.getDiffuseColor.mockResolvedValue(
      { success: true, r: 128 / 255, g: 128 / 255, b: 128 / 255, notes: [FROM_RECORD] } as DiffuseColor);
    const result = await server.getRegisteredTool("get_diffuse_color")({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Head" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text",
      text: `Diffuse color of CC_Base_Body/Std_Skin_Head: RGB(0.502, 0.502, 0.502)\n${FROM_RECORD}` }]);
  });

  it("keeps the one line without notes, and shows only the notes that are text", async () => {
    const handler = server.getRegisteredTool("get_diffuse_color");
    bridge.getDiffuseColor.mockResolvedValue({ r: 1, g: 0.5, b: 0 });
    expect((await handler({ mesh_name: "M", material_name: "Mat" })).content[0].text)
      .toBe("Diffuse color of M/Mat: RGB(1.000, 0.500, 0.000)");
    bridge.getDiffuseColor.mockResolvedValue({ r: 1, g: 0.5, b: 0, notes: [3, null, "a note"] } as unknown as DiffuseColor);
    expect((await handler({ mesh_name: "M", material_name: "Mat" })).content[0].text)
      .toBe("Diffuse color of M/Mat: RGB(1.000, 0.500, 0.000)\na note");
  });
});

// ── set_diffuse_color ─────────────────────────────────────────────────────────

describe("set_diffuse_color handler", () => {
  const successResult: SetDiffuseColorResult = {
    success: true,
    mesh: "CC_Base_Body",
    material: "Std_Skin_Body",
  };

  it("returns success message with mesh and material names from result", async () => {
    bridge.setDiffuseColor.mockResolvedValue(successResult);
    const handler = server.getRegisteredTool("set_diffuse_color");
    const result = await handler({
      mesh_name: "CC_Base_Body",
      material_name: "Std_Skin_Body",
      r: 0.9,
      g: 0.7,
      b: 0.5,
    });
    expect(result.content[0].text).toContain("CC_Base_Body/Std_Skin_Body");
    expect(result.content[0].text).toContain("RGB(0.9, 0.7, 0.5)");
  });

  it("falls back to input mesh_name when result.mesh is undefined", async () => {
    const noMeshResult: SetDiffuseColorResult = { success: true };
    bridge.setDiffuseColor.mockResolvedValue(noMeshResult);
    const handler = server.getRegisteredTool("set_diffuse_color");
    const result = await handler({
      mesh_name: "FallbackMesh",
      material_name: "FallbackMat",
      r: 0.1,
      g: 0.2,
      b: 0.3,
    });
    expect(result.content[0].text).toContain("FallbackMesh/FallbackMat");
  });

  it("returns failure message when result.success is false", async () => {
    bridge.setDiffuseColor.mockResolvedValue(FAILURE as SetDiffuseColorResult);
    const handler = server.getRegisteredTool("set_diffuse_color");
    const result = await handler({
      mesh_name: "Mesh",
      material_name: "Mat",
      r: 0.5,
      g: 0.5,
      b: 0.5,
    });
    expect(result.content[0].text).toBe("Failed: operation failed");
  });

  it("calls bridge.setDiffuseColor with correct arguments", async () => {
    bridge.setDiffuseColor.mockResolvedValue(successResult);
    const handler = server.getRegisteredTool("set_diffuse_color");
    await handler({
      mesh_name: "CC_Base_Body",
      material_name: "Std_Skin_Body",
      r: 0.9,
      g: 0.7,
      b: 0.5,
    });
    expect(bridge.setDiffuseColor).toHaveBeenCalledWith(
      "CC_Base_Body",
      "Std_Skin_Body",
      0.9,
      0.7,
      0.5
    );
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.setDiffuseColor.mockRejectedValue(new Error("CC5 not responding"));
    const handler = server.getRegisteredTool("set_diffuse_color");
    const result = await handler({
      mesh_name: "Mesh",
      material_name: "Mat",
      r: 0,
      g: 0,
      b: 0,
    });
    expect(result.content[0].text).toContain("CC5 bridge error: CC5 not responding");
  });

  it("handles RGB boundary values 0 and 1", async () => {
    bridge.setDiffuseColor.mockResolvedValue({ success: true });
    const handler = server.getRegisteredTool("set_diffuse_color");
    const result = await handler({
      mesh_name: "Mesh",
      material_name: "Mat",
      r: 0,
      g: 1,
      b: 0,
    });
    expect(result.content[0].text).toContain("RGB(0, 1, 0)");
  });

  it("returns content with type 'text'", async () => {
    bridge.setDiffuseColor.mockResolvedValue(successResult);
    const handler = server.getRegisteredTool("set_diffuse_color");
    const result = await handler({
      mesh_name: "Mesh",
      material_name: "Mat",
      r: 0.5,
      g: 0.5,
      b: 0.5,
    });
    expect(result.content[0].type).toBe("text");
  });
});

// ── get_shader_parameters ─────────────────────────────────────────────────────

describe("get_shader_parameters handler", () => {
  it("lists shader name and parameters on success", async () => {
    const r: ShaderParameters = {
      success: true,
      mesh: "CC_Base_Body",
      material: "Std_Skin_Head",
      shader: "Digital_Human Head",
      parameters: { "Micro Roughness Scale": [0.05], "SSS Radius": [1.5] },
    };
    bridge.getShaderParameters.mockResolvedValue(r);
    const handler = server.getRegisteredTool("get_shader_parameters");
    const result = await handler({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Head" });
    expect(result.content[0].text).toContain("Digital_Human Head");
    expect(result.content[0].text).toContain("Micro Roughness Scale = [0.05]");
    expect(result.content[0].text).toContain("SSS Radius = [1.5]");
  });

  it("reports when there are no shader parameters", async () => {
    const r: ShaderParameters = { success: true, material: "Std_Tongue", shader: "Pbr", parameters: {} };
    bridge.getShaderParameters.mockResolvedValue(r);
    const handler = server.getRegisteredTool("get_shader_parameters");
    const result = await handler({ mesh_name: "CC_Base_Body", material_name: "Std_Tongue" });
    expect(result.content[0].text).toContain("no shader parameters");
  });

  it("returns failure message when material not found", async () => {
    bridge.getShaderParameters.mockResolvedValue({ success: false, error: "Material not found: X" });
    const handler = server.getRegisteredTool("get_shader_parameters");
    const result = await handler({ mesh_name: "M", material_name: "X" });
    expect(result.content[0].text).toBe("Failed: Material not found: X");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.getShaderParameters.mockRejectedValue(new Error("bridge down"));
    const handler = server.getRegisteredTool("get_shader_parameters");
    const result = await handler({ mesh_name: "M", material_name: "Mat" });
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
  });
});

// F-69 (P6-6): CC4 Kevin's Std_Skin_Head listed 'SSS Metallic Threshold = []' and the padding entries as settings.
describe("get_shader_parameters: entries that are not settings are listed apart (F-69)", () => {
  const shown = async (r: ShaderParameters): Promise<string> => {
    bridge.getShaderParameters.mockResolvedValue(r);
    const handler = server.getRegisteredTool("get_shader_parameters");
    const result = await handler({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Head" });
    return result.content[0].text;
  };
  const lastLine = (text: string): string => {
    const lines = text.split("\n");
    return lines[lines.length - 1];
  };
  const head: ShaderParameters = {
    success: true, mesh: "CC_Base_Body", material: "Std_Skin_Head", shader: "Digital_Human Head",
    parameters: { "SSS Radius": [1.5] },
  };

  it("names CC5's no-value entries and the shader padding on a 'Left out' line", async () => {
    const text = await shown({
      ...head, no_value: ["SSS Metallic Threshold"], filler: ["padding1", "padding Last4"], unreadable: [],
    });
    expect(lastLine(text)).toBe("Left out (not settings): SSS Metallic Threshold (CC5 returns no value for it, " +
      "so it cannot be set); padding1, padding Last4 (shader padding)");
  });

  it("words several no-value entries in the plural", async () => {
    const text = await shown({ ...head, no_value: ["A", "B"], filler: [], unreadable: [] });
    expect(lastLine(text)).toBe("Left out (not settings): A, B (CC5 returns no value for them, so they cannot be set)");
  });

  it("names entries CC5 could not read", async () => {
    expect(lastLine(await shown({ ...head, no_value: [], filler: [], unreadable: ["Broken"] })))
      .toBe("Left out (not settings): Broken (CC5 could not read it)");
    expect(lastLine(await shown({ ...head, no_value: [], filler: [], unreadable: ["Bad", "Broken"] })))
      .toBe("Left out (not settings): Bad, Broken (CC5 could not read them)");
  });

  it("counts only the settable parameters", async () => {
    const text = await shown({ ...head, no_value: ["SSS Metallic Threshold"], filler: ["padding1"], unreadable: [] });
    expect(text).toContain("(1 params):");
    expect(text).toContain("  - SSS Radius = [1.5]");
    expect(text).not.toContain("- padding1");
  });

  it("adds the line after the zero-parameter text too", async () => {
    const text = await shown({
      success: true, material: "Std_Tongue", shader: "Pbr", parameters: {}, no_value: [], filler: ["padding1"],
      unreadable: [],
    });
    expect(text).toBe("Std_Tongue: no shader parameters (shader: Pbr).\nLeft out (not settings): padding1 (shader padding)");
  });

  it("prints no line for a result without the lists (an older plugin) or with empty lists", async () => {
    expect(await shown(head)).not.toContain("Left out");
    expect(await shown({ ...head, no_value: [], filler: [], unreadable: [] })).not.toContain("Left out");
  });

  it("both shader tools say the left-out entries are not settings", () => {
    for (const name of ["get_shader_parameters", "set_shader_parameter"]) {
      const description = server.tool.mock.calls.find((c) => c[0] === name)?.[1] as string;
      expect(description).toContain(
        "Parameters CC5 returns no value for and the shader's padding entries are listed apart: they are not settings.");
    }
  });
});

// ── set_shader_parameter ──────────────────────────────────────────────────────

describe("set_shader_parameter handler", () => {
  it("reports the applied value on success", async () => {
    const r: SetShaderParameterResult = {
      success: true,
      mesh: "CC_Base_Body",
      material: "Std_Skin_Head",
      parameter: "Micro Roughness Scale",
      values: [0.3],
    };
    bridge.setShaderParameter.mockResolvedValue(r);
    const handler = server.getRegisteredTool("set_shader_parameter");
    const result = await handler({
      mesh_name: "CC_Base_Body",
      material_name: "Std_Skin_Head",
      parameter_name: "Micro Roughness Scale",
      values: [0.3],
    });
    expect(result.content[0].text).toContain("'Micro Roughness Scale' set to [0.3]");
  });

  it("returns failure on unknown parameter / arity mismatch", async () => {
    bridge.setShaderParameter.mockResolvedValue({ success: false, error: "Shader parameter not found: Bogus" });
    const handler = server.getRegisteredTool("set_shader_parameter");
    const result = await handler({
      mesh_name: "CC_Base_Body",
      material_name: "Std_Skin_Head",
      parameter_name: "Bogus",
      values: [1],
    });
    expect(result.content[0].text).toBe("Failed: Shader parameter not found: Bogus");
  });

  it("calls bridge.setShaderParameter with correct arguments", async () => {
    bridge.setShaderParameter.mockResolvedValue({ success: true, values: [1.5] });
    const handler = server.getRegisteredTool("set_shader_parameter");
    await handler({
      mesh_name: "CC_Base_Body",
      material_name: "Std_Skin_Head",
      parameter_name: "SSS Radius",
      values: [1.5],
    });
    expect(bridge.setShaderParameter).toHaveBeenCalledWith("CC_Base_Body", "Std_Skin_Head", "SSS Radius", [1.5]);
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.setShaderParameter.mockRejectedValue(new Error("bridge down"));
    const handler = server.getRegisteredTool("set_shader_parameter");
    const result = await handler({
      mesh_name: "M",
      material_name: "Mat",
      parameter_name: "SSS Radius",
      values: [1.5],
    });
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
  });
});

// F-102 (live): RootColor set to [0.02, 0.018, 0.016] replied "set to [0.019999999552965164, 0.017999999225139618,
// 0.01600000075995922]": CC5 keeps float32, as F-13 and F-62 found for morph weights.
describe("shader values are shown rounded, as morph weights are (F-102)", () => {
  const FLOAT32 = [0.019999999552965164, 0.017999999225139618, 0.01600000075995922];

  it("set_shader_parameter echoes CC5's read-back to 4 decimals at most", async () => {
    bridge.setShaderParameter.mockResolvedValue({ success: true, mesh: "Hair", material: "Hair_Transparency",
      parameter: "RootColor", values: FLOAT32 });
    const result = await server.getRegisteredTool("set_shader_parameter")({
      mesh_name: "Hair", material_name: "Hair_Transparency", parameter_name: "RootColor", values: [0.02, 0.018, 0.016],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Hair/Hair_Transparency 'RootColor' set to [0.02, 0.018, 0.016]");
  });

  it("set_shader_parameter rounds the values it was given the same way when CC5 sends none back", async () => {
    bridge.setShaderParameter.mockResolvedValue({ success: true });
    const result = await server.getRegisteredTool("set_shader_parameter")({
      mesh_name: "CC_Base_Body", material_name: "Std_Skin_Head", parameter_name: "SSS Radius", values: [0.12345678, 2],
    });
    expect(result.content[0].text).toBe("CC_Base_Body/Std_Skin_Head 'SSS Radius' set to [0.1235, 2]");
  });

  it("get_shader_parameters shows the same digits, without trailing zeros or a lost fourth decimal", async () => {
    bridge.getShaderParameters.mockResolvedValue({ success: true, mesh: "Hair", material: "Hair_Transparency",
      shader: "Digital_Human Hair", parameters: { RootColor: FLOAT32, "Strand Width": [0.0005], Specular: [1] } });
    const result = await server.getRegisteredTool("get_shader_parameters")({ mesh_name: "Hair", material_name: "Hair_Transparency" });
    expect(result.content[0].text).toBe("Shader 'Digital_Human Hair' on Hair/Hair_Transparency (3 params):\n" +
      "  - RootColor = [0.02, 0.018, 0.016]\n  - Strand Width = [0.0005]\n  - Specular = [1]");
  });
});

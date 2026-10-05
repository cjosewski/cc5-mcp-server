import { describe, it, expect, beforeEach } from "vitest";
import { registerSelectionTools, formatSelection } from "../../src/tools/selection.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

const KEVIN = { name: "Kevin", id: 1, type: "Avatar" };
const KEY = { name: "Key", id: 21, type: "SpotLight" };

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSelectionTools(server as any, bridge as any);
});

describe("registerSelectionTools", () => {
  it("registers the selection, delete and transform tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(6);
    for (const name of ["select_objects", "get_selection", "clear_selection", "delete_object", "get_object_transform", "set_object_transform"]) {
      expect(server.getRegisteredTool(name)).toBeTypeOf("function");
    }
  });
});

describe("formatSelection", () => {
  it("says when nothing is selected", () => {
    expect(formatSelection([])).toBe("Nothing is selected.");
    expect(formatSelection(undefined)).toBe("Nothing is selected.");
  });

  it("lists each item with its type and ID", () => {
    expect(formatSelection([KEVIN, KEY])).toBe("Selected (2):\n- Kevin (Avatar, ID: 1)\n- Key (SpotLight, ID: 21)");
  });
});

describe("select_objects handler", () => {
  it("sends the names and add flag and lists the resulting selection", async () => {
    bridge.selectObjects.mockResolvedValue({ success: true, selected: [KEVIN] });
    const result = await server.getRegisteredTool("select_objects")({ names: ["Kevin"], add: true });
    expect(bridge.selectObjects).toHaveBeenCalledWith(["Kevin"], true);
    expect(result.content[0].text).toBe("Selected (1):\n- Kevin (Avatar, ID: 1)");
    expect(result.isError).toBeFalsy();
  });

  it("reports an unknown name as an error", async () => {
    bridge.selectObjects.mockResolvedValue({ success: false, error: "Object not found: NoSuchItem" });
    const result = await server.getRegisteredTool("select_objects")({ names: ["NoSuchItem"], add: false });
    expect(result.content[0].text).toBe("Failed: Object not found: NoSuchItem");
    expect(result.isError).toBe(true);
  });

  it("reports a bridge failure without throwing", async () => {
    bridge.selectObjects.mockRejectedValue(new Error("CC5 not connected"));
    const result = await server.getRegisteredTool("select_objects")({ names: ["Kevin"], add: false });
    expect(result.content[0].text).toContain("CC5 not connected");
    expect(result.isError).toBe(true);
  });
});

describe("get_selection and clear_selection handlers", () => {
  it("get_selection lists the selection", async () => {
    bridge.getSelection.mockResolvedValue({ success: true, selected: [KEY] });
    const result = await server.getRegisteredTool("get_selection")({});
    expect(result.content[0].text).toBe("Selected (1):\n- Key (SpotLight, ID: 21)");
  });

  it("clear_selection confirms", async () => {
    bridge.clearSelection.mockResolvedValue({ success: true, selected: [] });
    const result = await server.getRegisteredTool("clear_selection")({});
    expect(result.content[0].text).toBe("Selection cleared.");
  });

  it("clear_selection reports items CC5 kept", async () => {
    bridge.clearSelection.mockResolvedValue({ success: false, error: "CC5 kept items selected after clearing" });
    const result = await server.getRegisteredTool("clear_selection")({});
    expect(result.isError).toBe(true);
  });
});

describe("delete_object handler (F-49)", () => {
  it("sends the names and lists what CC5 removed", async () => {
    bridge.deleteObject.mockResolvedValue({ success: true, deleted: [{ name: "box_01", id: 7, type: "Prop" }] });
    const result = await server.getRegisteredTool("delete_object")({ names: ["box_01"] });
    expect(bridge.deleteObject).toHaveBeenCalledWith(["box_01"]);
    expect(result.content[0].text).toBe("Deleted (1):\n- box_01 (Prop, ID: 7)");
  });

  it("says that characters are deleted with delete_avatar", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "delete_object")?.[1] as string;
    expect(description).toContain("delete_avatar");
    expect(description).toContain("one CC5 undo step");
  });
});

describe("object transform handlers (F-48)", () => {
  const before = { position: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const after = { position: [150, 0, 0] as [number, number, number], scale: [1.5, 1.5, 1.5] as [number, number, number] };

  it("moves and scales, showing the read-back before and after", async () => {
    bridge.setObjectTransform.mockResolvedValue({ success: true, name: "box_01", before, after });
    const result = await server.getRegisteredTool("set_object_transform")({ name: "box_01", position: [150, 0, 0], scale: 1.5 });
    expect(bridge.setObjectTransform).toHaveBeenCalledWith("box_01", [150, 0, 0], 1.5);
    expect(result.content[0].text).toBe(
      "box_01 placed.\nBefore: position (0, 0, 0) cm, scale (1, 1, 1)\nAfter:  position (150, 0, 0) cm, scale (1.5, 1.5, 1.5)");
  });

  it("reads a transform", async () => {
    bridge.getObjectTransform.mockResolvedValue({ success: true, name: "Key", ...after });
    const result = await server.getRegisteredTool("get_object_transform")({ name: "Key" });
    expect(result.content[0].text).toBe("Key: position (150, 0, 0) cm, scale (1.5, 1.5, 1.5)");
  });
});

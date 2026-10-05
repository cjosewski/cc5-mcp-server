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
  it("registers select_objects, get_selection and clear_selection", () => {
    expect(server.tool).toHaveBeenCalledTimes(3);
    for (const name of ["select_objects", "get_selection", "clear_selection"]) {
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

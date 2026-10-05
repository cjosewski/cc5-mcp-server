import { describe, it, expect, beforeEach } from "vitest";
import { registerVisibilityTools } from "../../src/tools/visibility.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerVisibilityTools(server as any, bridge as any);
});

describe("set_item_visible read-back (F-24)", () => {
  it("says when CC5 confirmed the change", async () => {
    bridge.setItemVisible.mockResolvedValue({ success: true, item: "Box_001", visible: false, verified: true });
    const r = await server.getRegisteredTool("set_item_visible")({ item_name: "Box_001", visible: false });
    expect(r.content[0].text).toBe("Item 'Box_001' set to hidden (CC5 confirms).");
  });

  it("passes on that a worn item cannot be read back", async () => {
    bridge.setItemVisible.mockResolvedValue({ success: true, item: "Boxers", visible: false, verified: null,
      notes: ["CC5 cannot report this item's visibility: check it with capture_viewport."] });
    const r = await server.getRegisteredTool("set_item_visible")({ item_name: "Boxers", visible: false });
    expect(r.content[0].text).toBe(
      "Item 'Boxers' set to hidden.\nCC5 cannot report this item's visibility: check it with capture_viewport.");
  });
});

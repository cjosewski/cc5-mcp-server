import { describe, it, expect, beforeEach } from "vitest";
import { registerContentTools } from "../../src/tools/content.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerContentTools(server as any, bridge as any);
});

describe("browse_content", () => {
  it("does not promise overlay images from image_layer (live CC5 lists only .iImgLayer files there)", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "browse_content")?.[2] as { folder_type: { description?: string } };
    expect(shape.folder_type.description).toContain("image_layer holds CC5 .iImgLayer");
    expect(shape.folder_type.description).not.toMatch(/image_layer\/texture/);
  });

  it("says when CC5 cut the list off at its cap, without counting the marker as a file", async () => {
    const files = Array.from({ length: 200 }, (_, i) => `C:/c/Shirt ${i}.ccCloth`);
    bridge.browseContent.mockResolvedValue([...files, "(truncated: more than 200 files matched; only the first 200 are listed)"]);
    const r = await server.getRegisteredTool("browse_content")({ folder_type: "cloth_upper" });
    expect(r.content[0].text).toContain("Found 200+ content file(s)");
    expect(r.content[0].text).toContain("use search_content");
    expect(r.content[0].text).not.toContain("(truncated");
  });

  it("lists a complete folder as before", async () => {
    bridge.browseContent.mockResolvedValue(["C:/s/Boots.ccShoes"]);
    const r = await server.getRegisteredTool("browse_content")({ folder_type: "shoes" });
    expect(r.content[0].text).toBe("Found 1 content file(s) for 'shoes':\n- C:/s/Boots.ccShoes");
  });
});

describe("worn-item lists (F-40)", () => {
  it("say plainly when nothing is applied", async () => {
    bridge.listClothes.mockResolvedValue([]);
    bridge.listHair.mockResolvedValue([]);
    bridge.listAccessories.mockResolvedValue([]);
    expect((await server.getRegisteredTool("list_clothes")({})).content[0].text).toBe("No clothes are applied.");
    expect((await server.getRegisteredTool("list_hair")({})).content[0].text).toBe("No hair is applied.");
    expect((await server.getRegisteredTool("list_accessories")({})).content[0].text).toBe("No accessories are applied.");
  });

  it("list what is applied by name and ID, without CC5's numeric type", async () => {
    // Live: Boxers and Slim Jeans were both type 1, the T-shirt and the socks both 4: not a garment kind.
    bridge.listClothes.mockResolvedValue([{ name: "Boxers", id: 11, type: 1 }, { name: "Basic T-shirts", id: 12, type: 4 }]);
    bridge.listHair.mockResolvedValue([{ name: "Oval Afro", id: 21, type: 1 }]);
    const clothes = (await server.getRegisteredTool("list_clothes")({})).content[0].text;
    expect(clothes).toBe("Clothes applied (2):\n- Boxers (ID: 11)\n- Basic T-shirts (ID: 12)");
    expect((await server.getRegisteredTool("list_hair")({})).content[0].text).toBe("Hair applied (1):\n- Oval Afro (ID: 21)");
  });
});

describe("browse_content categories (F-41, F-42)", () => {
  it("offers the clothing and accessory categories CC5 really has", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "browse_content")?.[2] as {
      folder_type: { safeParse: (v: unknown) => { success: boolean } };
    };
    for (const category of ["underwear", "gloves", "cloth_other", "accessory_other", "accessory_body"]) {
      expect(shape.folder_type.safeParse(category).success).toBe(true);
    }
  });
});

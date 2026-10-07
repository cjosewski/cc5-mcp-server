import { describe, it, expect, beforeEach } from "vitest";
import { registerContentTools, NO_AVATAR } from "../../src/tools/content.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { PICK_RULE, STORE_HINT, STORE_RULE } from "../../src/prompts/content-rules.js";

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

  it("lists the user's Custom content first, and gives the pick-list and store rules (F-72, I-02, I-03)", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "browse_content")?.[1] as string;
    expect(description).toContain("the user's own content from CC5's Custom tab (paths under 'Reallusion Custom', plus " +
      "'Shared Custom' and 'Shared Templates' when they hold content), the user's own first.");
    expect(description).toContain(PICK_RULE);
    expect(description).toContain(`If nothing listed fits, try search_content. ${STORE_RULE}`);
    expect(description).toContain("(pose/motion may be empty on a base install without content packs).");
    expect(description.length).toBeLessThan(2000);
  });

  it("answers an empty category as a result, not an error, and points to search_content and the store (I-02)", async () => {
    bridge.browseContent.mockResolvedValue([]);
    const r = await server.getRegisteredTool("browse_content")({ folder_type: "gloves" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`No content files found for category 'gloves'. Try search_content. ${STORE_HINT}`);
  });

  // TS-10: the plugin answers a category CC5 resolves no folder for (or only the Custom root, which it leaves out) with
  // that one message in the list (cc5_api.browse_content). It is no file to load.
  it("answers 'No content folder resolved' like an empty category, never as a file found", async () => {
    bridge.browseContent.mockResolvedValue(["No content folder resolved for 'pose'"]);
    const r = await server.getRegisteredTool("browse_content")({ folder_type: "pose" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`No content files found for category 'pose'. Try search_content. ${STORE_HINT}`);
    expect(r.content[0].text).not.toContain("Found 1 content file(s)");
  });

  it("still shows the plugin's other in-list errors as they are", async () => {
    for (const message of ["Unknown folder type: gown. Available: cloth_upper", "Error browsing content: boom",
      "Content browsing not available for 'pose' in this CC5 version"]) {
      bridge.browseContent.mockResolvedValue([message]);
      const r = await server.getRegisteredTool("browse_content")({ folder_type: "pose" });
      expect(r.content[0].text).toBe(message);
    }
  });
});

describe("worn-item lists (F-40)", () => {
  it("say plainly when nothing is applied", async () => {
    bridge.listClothes.mockResolvedValue([]);
    bridge.listHair.mockResolvedValue([]);
    bridge.listAccessories.mockResolvedValue([]);
    bridge.getAvatars.mockResolvedValue([{ name: "Kevin", id: "1", type: "avatar" }]);
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

// F-61: CC5 answers an empty list both when nothing is worn and when there is no character at all.
describe("worn-item lists with no character in the scene (F-61)", () => {
  const LISTS = ["list_clothes", "list_hair", "list_accessories"];

  it("say that the scene has no avatar, as a result, not an error", async () => {
    bridge.listClothes.mockResolvedValue([]);
    bridge.listHair.mockResolvedValue([]);
    bridge.listAccessories.mockResolvedValue([]);
    bridge.getAvatars.mockResolvedValue([]);
    for (const name of LISTS) {
      const r = await server.getRegisteredTool(name)({});
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe(NO_AVATAR);
    }
    expect(NO_AVATAR).toBe("No avatar in the scene.");
  });

  it("read the avatars only when the list is empty", async () => {
    bridge.listClothes.mockResolvedValue([{ name: "Boxers", id: 11, type: 1 }]);
    bridge.listHair.mockResolvedValue([{ name: "Oval Afro", id: 21, type: 1 }]);
    bridge.listAccessories.mockResolvedValue([{ name: "Glasses", id: 31 }]);
    for (const name of LISTS) await server.getRegisteredTool(name)({});
    expect(bridge.getAvatars).not.toHaveBeenCalled();
  });

  it("report a failed avatar read, or a failed list, as a bridge error", async () => {
    bridge.listClothes.mockResolvedValue([]);
    bridge.getAvatars.mockRejectedValue(new Error("fetch failed"));
    const r = await server.getRegisteredTool("list_clothes")({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("CC5 bridge error: fetch failed");
    bridge.listHair.mockRejectedValue(new Error("fetch failed"));
    const hair = await server.getRegisteredTool("list_hair")({});
    expect(hair.isError).toBe(true);
    expect(hair.content[0].text).toContain("CC5 bridge error");
  });

  it("say so in their descriptions", () => {
    for (const name of LISTS) {
      const description = server.tool.mock.calls.find((c) => c[0] === name)?.[1] as string;
      expect(description.endsWith("or say that none are applied, or that the scene has no character.")).toBe(true);
    }
    for (const call of server.tool.mock.calls) expect((call[1] as string).length).toBeLessThan(2000);
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

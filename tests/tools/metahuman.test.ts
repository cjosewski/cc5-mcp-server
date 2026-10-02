import { describe, it, expect, beforeEach } from "vitest";
import { registerMetaHumanTools } from "../../src/tools/metahuman.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMetaHumanTools(server as any, bridge as any);
});

describe("export_head_metahuman validation failures carry isError", () => {
  it("rejects a relative output_dir", async () => {
    const r = await server.getRegisteredTool("export_head_metahuman")({ output_dir: "rel/dir", character_name: "P1", gender: "Female" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("absolute");
  });

  it("rejects a bad character_name", async () => {
    const r = await server.getRegisteredTool("export_head_metahuman")({ output_dir: "D:/out", character_name: "a/b", gender: "Female" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid characters");
  });
});

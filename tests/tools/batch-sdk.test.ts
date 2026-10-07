/**
 * batch_generate_patients through the real MCP SDK (McpServer + Client over an in-memory transport):
 * proves the handler gets the SDK's cancellation signal and the client's progress token.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerBatchTools } from "../../src/tools/batch.js";
import { finishBuild, startBuild } from "../../src/build-session.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { markUnityProject } from "../helpers/unity-project.js";

let bridge: MockBridge;
let started: ReturnType<typeof mockJobs>;
let client: Client;
let unityDir: string;
let project: string;
let base: string;

beforeEach(async () => {
  bridge = createMockBridge();
  bridge.getAvatars.mockResolvedValue([{ name: "Old", id: 1, type: "avatar" }]);
  bridge.deleteAvatar.mockResolvedValue({ success: true });
  bridge.setSkinCondition.mockResolvedValue({ success: true });
  bridge.getMeshStats.mockResolvedValue({ success: true, meshes: [], totals: { vertices: 1, faces: 1000, triangles: 2000, materials: 4 } });
  started = mockJobs(bridge, { export_for_unity: (p) => ({ success: true, fbx: `${p.unity_dir}/${p.character_name}.fbx`, files: [] }) });
  finishBuild(startBuild("batch"));  // no stop left over from another test
  // The batch refuses an Assets folder outside a Unity project (F-76) and a base that does not exist (F-81).
  project = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-batch-sdk-"));
  markUnityProject(project);
  base = path.join(project, "Male.ccAvatar");
  fs.writeFileSync(base, "saved base");
  unityDir = path.join(project, "Assets", "Patients");

  const server = new McpServer({ name: "cc5-test", version: "0.0.0" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBatchTools(server, bridge as any);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
  fs.rmSync(project, { recursive: true, force: true });
});

const args = () => ({
  base_character: base,
  unity_dir: unityDir,
  injuries: "omit",  // A is pale: an FBX cannot carry the pallor (F-75)
  variants: [
    { name: "A", recipe: { skin_condition: { condition: "pale", amount: 0.5 } } },
    { name: "B", recipe: {}, export_base_unchanged: true },
    { name: "C", recipe: {}, export_base_unchanged: true },
  ],
});

describe("batch_generate_patients over the MCP SDK", () => {
  it("stops driving CC5 when the client cancels the call", async () => {
    const ac = new AbortController();
    bridge.setSkinCondition.mockImplementation(async () => {
      ac.abort();  // the user presses Esc while CC5 applies variant A's skin condition
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { success: true };
    });
    const call = client.callTool({ name: "batch_generate_patients", arguments: args() }, CallToolResultSchema, { signal: ac.signal });
    await expect(call).rejects.toThrow();

    const manifestPath = path.join(unityDir, "patients_manifest.json");
    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).cancelled).toBe("Cancelled by the client. Not started: B, C.");
    });
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);
    expect(started.map((j) => j.action)).toEqual(["load_asset"]);
  });

  it("sends progress the client asked for, and refuses duplicate variant names", async () => {
    const messages: string[] = [];
    const r = await client.callTool({ name: "batch_generate_patients", arguments: args() }, CallToolResultSchema,
      { onprogress: (p) => messages.push(String(p.message)) });
    expect(r.isError).toBeFalsy();
    expect(messages).toEqual(["A (1/3): OK skin_condition", "A (1/3): done", "B (2/3): done", "C (3/3): done"]);

    const dup = await client.callTool({ name: "batch_generate_patients",
      arguments: { ...args(), variants: [
        { name: "Patient_A", recipe: {}, export_base_unchanged: true },
        { name: "PATIENT_A", recipe: {}, export_base_unchanged: true }] } });
    expect(dup.isError).toBe(true);
    expect(JSON.stringify(dup.content)).toContain("Variant names must be unique");
  });
});

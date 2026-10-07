import { describe, it, expect, beforeEach } from "vitest";
import { registerJobTools } from "../../src/tools/jobs.js";
import { BridgeHttpError, BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE } from "../../src/tools/unity.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerJobTools(server as any, bridge as any);
});

describe("job_status", () => {
  it("reports a running job", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "running" });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("Still running");
  });

  it("shows the question a running job waits on", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "load_asset", status: "running",
      dialog_message: 'CC5 is waiting for an answer to "Replace?". Buttons: Replace, Cancel.' });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Buttons: Replace, Cancel");
  });

  it("returns the finished result as JSON", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "x", status: "done", result: { success: true, fbx: "a.fbx" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("a.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("flags a failed job as an error", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "failed", result: { success: false, error: "disk full" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("disk full");
  });

  it("flags a finished export that ran without some of its settings", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["WARNING: SetOption2 failed, flags2 NOT applied: x"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\)/);
  });

  it("labels an import with warnings without making it an error (repeating it would import twice)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "import_fbx", status: "done",
      result: { success: true, notes: ["WARNING: 1 clothing mesh(es) did not import: Hood"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished with warnings \(import_fbx\)/);
  });

  it("says the job was lost in a CC5 restart when the bridge no longer knows it", async () => {
    bridge.getJob.mockRejectedValue(new BridgeHttpError("Unknown job: cmd_0f3a9b2c_12", 404));
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_0f3a9b2c_12" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      "Job cmd_0f3a9b2c_12 not found. CC5 was probably restarted and the job's result is lost. Check the output folder, then run the operation again.");
  });

  it("asks whether CC5 is running when it cannot be reached", async () => {
    bridge.getJob.mockRejectedValue(new BridgeUnreachableError("fetch failed"));
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_0f3a9b2c_12" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Is CC5 running");
  });

  // X-2: CC5's timeline left at one frame after the export is no export setting CC5 failed to apply.
  it("does not make an export an error for a timeline CC5 could not set back, and says so on its own line", async () => {
    const timeline = `${TIMELINE_NOT_RESTORED_PREFIX}CC5's timeline was set to one frame for this export and could not be set back (x)`;
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: [timeline] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\):\n/);
    expect(r.content[0].text.split("\n").at(-1)).toBe(TIMELINE_USABLE_LINE);
    expect(TIMELINE_USABLE_LINE).toBe("The FBX is usable; CC5's timeline was left at one frame: set its length in " +
      "Character Creator 5.");

    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_textures", status: "done",
      result: { success: true, notes: [timeline, "WARNING: SetTextureSize failed: x"] } });
    const both = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(both.isError).toBe(true);
    expect(both.content[0].text.split("\n").at(-1)).toBe(TIMELINE_LEFT_LINE);

    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["target_tool=Unity preset applied"] } });
    const plain = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(plain.content[0].text).not.toContain("timeline");
  });

  it("flags an export_for_unity that did not carry the injuries (WP-3 relies on this)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["WARNING: injuries not carried: Std_Skin_Arm: the bake failed"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\):\n/);
    expect(r.content[0].text).toContain("injuries not carried");
  });
});

// F-34: a load that waited on a CC5 question finishes here, so job_status shows load_asset's own reply.
describe("job_status for a finished load_asset", () => {
  const PANTS = "C:/c/US_Army_Uniform_Pants.ccCloth";
  const changes = (facts: unknown[]) => ({ complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 300,
    compared: { worn: 2, morphs: 10, materials: 30 }, skipped: 0, truncated: false, facts });
  const PANTS_ADDED = { kind: "worn_added", group: "clothing", id: "13", name: "Pants" };
  const BOXERS_REMOVED = { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" };

  it("shows the change report, labelled with warnings when it has CHECK lines (not an error)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "done",
      result: { success: true, path: PANTS, target: "Kevin", changes: changes([PANTS_ADDED, BOXERS_REMOVED]) } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe([
      "Finished with warnings (load_asset):",
      `Asset loaded: ${PANTS} (applied to Kevin)`,
      "Compared before and after: 2 worn items, 10 shaping morphs, 30 materials (0.3 s).",
      "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item",
      "Applied: added Pants (clothing)",
      "NOT CHECKED: how it sits on the character (skin or scalp showing through, floating items): run check_fit",
    ].join("\n"));
  });

  it("says Finished when nothing needs checking", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "done",
      result: { success: true, path: PANTS, target: "Kevin", changes: changes([PANTS_ADDED]) } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished \(load_asset\):\nAsset loaded: /);
    expect(r.content[0].text).not.toContain("CHECK ");
  });

  it("reports a failed load as an error", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "load_asset", status: "failed",
      result: { success: false, error: "File not found: C:/x.ccCloth" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_4" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Failed (load_asset):\nFailed to load asset: File not found: C:/x.ccCloth");
  });

  it("describes the change report", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "job_status")?.[1] as string;
    expect(description).toContain("(export, load, batch step)");
    expect(description).toContain("a finished load_asset also shows what the load changed (CHECK and NOT CHECKED lines)");
    expect(description.length).toBeLessThan(2000);
  });
});

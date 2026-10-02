/**
 * Job polling tool for long-running CC5 operations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult } from "../util.js";
import { formatPending } from "../jobs.js";

export function registerJobTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "job_status",
    "Check a long-running CC5 operation (export, batch) started earlier. Returns its result when finished.",
    { job_id: z.string().regex(/^cmd_\d+$/).describe("Job id returned by the earlier tool call") },
    async ({ job_id }) => {
      const res = await bridgeCall(
        () => bridge.getJob(job_id),
        (job) => {
          if (job.status === "queued" || job.status === "running") return formatPending(job_id);
          const label = job.status === "failed" ? "Failed" : "Finished";
          return `${label} (${job.action}):\n${JSON.stringify(job.result, null, 2)}`;
        },
      );
      return res.content[0].text.startsWith("Failed") ? errorResult(res.content[0].text) : res;
    }
  );
}

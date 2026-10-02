/**
 * Job polling tool for long-running CC5 operations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { JobStatus } from "../types.js";
import { bridgeErrorResult, errorResult, warningNotes } from "../util.js";
import { formatPending, isUnknownJob, JOB_ID_PATTERN, lostJobMessage } from "../jobs.js";

const EXPORTS_CHECKED_FOR_WARNINGS = new Set(["export_for_unity", "export_textures"]);

export function registerJobTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "job_status",
    "Check a long-running CC5 operation (export, batch) started earlier. Returns its result when finished.",
    { job_id: z.string().regex(JOB_ID_PATTERN).describe("Job id returned by the earlier tool call") },
    async ({ job_id }) => {
      let job: JobStatus;
      try {
        job = await bridge.getJob(job_id);
      } catch (err) {
        return isUnknownJob(err) ? errorResult(lostJobMessage(job_id)) : bridgeErrorResult(err);
      }
      if (job.status === "queued" || job.status === "running") {
        return { content: [{ type: "text" as const, text: formatPending(job_id) }] };
      }
      const failed = job.status === "failed";
      const warned = !failed && warningNotes(job.result).length > 0;
      const label = failed ? "Failed" : warned ? "Finished with warnings" : "Finished";
      const text = `${label} (${job.action}):\n${JSON.stringify(job.result, null, 2)}`;
      // Same rule as the tools that start these jobs: an export that ran without some of its settings is
      // an error; an import with warnings is not, because repeating it would add the content twice.
      const isError = failed || (warned && EXPORTS_CHECKED_FOR_WARNINGS.has(job.action));
      return isError ? errorResult(text) : { content: [{ type: "text" as const, text }] };
    }
  );
}

/**
 * Job polling tool for long-running CC5 operations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { JobStatus } from "../types.js";
import { bridgeErrorResult, errorResult, warningNotes } from "../util.js";
import { formatPending, isUnknownJob, JOB_ID_PATTERN, lostJobMessage } from "../jobs.js";
import { buildReport, formatLoadResult, type LoadJobResult } from "../change-report.js";
import { TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE } from "./unity.js";

const EXPORTS_CHECKED_FOR_WARNINGS = new Set(["export_for_unity", "export_textures"]);

export function registerJobTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "job_status",
    "Check a long-running CC5 operation (export, load, batch step) started earlier. Returns its result when finished; a finished load_asset also shows what the load changed (CHECK and NOT CHECKED lines).",
    { job_id: z.string().regex(JOB_ID_PATTERN).describe("Job id returned by the earlier tool call") },
    async ({ job_id }) => {
      let job: JobStatus;
      try {
        job = await bridge.getJob(job_id);
      } catch (err) {
        return isUnknownJob(err) ? errorResult(lostJobMessage(job_id)) : bridgeErrorResult(err);
      }
      if (job.status === "queued" || job.status === "running") {
        if (job.dialog_message) return errorResult(job.dialog_message);
        return { content: [{ type: "text" as const, text: formatPending(job_id) }] };
      }
      if (job.action === "load_asset") {
        // The same reply load_asset gives (F-34): a load that waited on a question finishes here.
        const raw = job.result;
        const r = (typeof raw === "object" && raw !== null ? raw : {}) as LoadJobResult;
        const loadFailed = job.status === "failed" || r.success === false;
        const label = loadFailed ? "Failed" : buildReport(r, r.path ?? "").checks.length ? "Finished with warnings" : "Finished";
        const formatted = formatLoadResult(loadFailed ? { ...r, success: false } : r, r.path ?? "(file)");
        const text = `${label} (load_asset):\n${formatted.content.map((c) => c.text).join("\n")}`;
        return loadFailed ? errorResult(text) : { content: [{ type: "text" as const, text }] };
      }
      const failed = job.status === "failed";
      const warnings = warningNotes(job.result);
      const warned = !failed && warnings.length > 0;
      const label = failed ? "Failed" : warned ? "Finished with warnings" : "Finished";
      // X-2: a CC5 timeline left at one frame after the export is no export setting CC5 failed to apply.
      const timelineLeft = warnings.some((n) => n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
      const settingWarned = !failed && warnings.some((n) => !n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
      // Same rule as the tools that start these jobs: an export that ran without some of its settings is
      // an error; an import with warnings is not, because repeating it would add the content twice.
      const isError = failed || (settingWarned && EXPORTS_CHECKED_FOR_WARNINGS.has(job.action));
      const timeline = timelineLeft ? `\n${isError ? TIMELINE_LEFT_LINE : TIMELINE_USABLE_LINE}` : "";
      const text = `${label} (${job.action}):\n${JSON.stringify(job.result, null, 2)}${timeline}`;
      return isError ? errorResult(text) : { content: [{ type: "text" as const, text }] };
    }
  );
}

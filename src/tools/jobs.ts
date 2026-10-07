/**
 * Job polling tool for long-running CC5 operations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { JobStatus } from "../types.js";
import { bridgeErrorResult, errorResult, warningNotes } from "../util.js";
import { formatPending, isUnknownJob, JOB_ID_PATTERN, jobDialogMessage, lostJobMessage, withSkinGenRule } from "../jobs.js";
import { buildReport, formatLoadResult, type LoadJobResult } from "../change-report.js";
import { answeredCancel } from "../recipe.js";
import { CANCELLED_LOAD } from "./asset.js";
import { TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE } from "./unity.js";

const EXPORTS_CHECKED_FOR_WARNINGS = new Set(["export_for_unity", "export_textures"]);
/** The jobs that write an FBX: export_for_unity, and export_textures (the FBX beside its texture images). */
const FBX_EXPORTS = new Set(["export_for_unity", "export_textures"]);

/**
 * F-98 (batch F review #8, #28): the line under a finished job, other than a load, whose CC5 question answer_cc5_dialog
 * answered Cancel. CC5 still reports such a command done, though it may not have done what was asked; an FBX export is
 * worded as the batch words its own (batch.ts): the FBX may not be as asked. The answers are JSON from the plugin: the
 * first Cancel among them names its window when it has a title.
 */
function cancelledLine(job: JobStatus): string {
  const answers: unknown[] = Array.isArray(job.answers) ? job.answers : [];
  const title = (answers.find((a) => answeredCancel([a])) as { title?: unknown } | undefined)?.title;
  const named = typeof title === "string" && title ? ` (the "${title}" window)` : "";
  const asked = `CC5's question${named} was answered 'Cancel'`;
  return FBX_EXPORTS.has(job.action)
    ? `${asked}, so CC5 may not have written the FBX as asked: check it before using it.`
    : `${asked}, so CC5 may not have done what was asked.`;
}

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
        // The same words as load_asset's reply: a plugin older than batch F tells the agent to answer with
        // answer_cc5_dialog a window that tool cannot answer, which jobDialogMessage words as get_cc5_dialog does
        // (reviews #3, #7, #19), and CC5's question before a content load ends a SkinGen session gets its rule (F-91).
        const message = jobDialogMessage(job_id, job);
        if (message) return errorResult(withSkinGenRule(message, job.dialog));
        return { content: [{ type: "text" as const, text: formatPending(job_id) }] };
      }
      // F-98 (batch F review #8, #28): answer_cc5_dialog clicked Cancel in a CC5 question while the job waited in it.
      // CC5 still reports the command done, so the reply is labelled cancelled in CC5, never finished, and is an error
      // (as a recipe step answered Cancel is no step done).
      const cancelled = answeredCancel(job.answers);
      if (job.action === "load_asset") {
        // The same reply load_asset gives (F-34): a load that waited on a question finishes here.
        const raw = job.result;
        const r = (typeof raw === "object" && raw !== null ? raw : {}) as LoadJobResult;
        const loadFailed = job.status === "failed" || r.success === false;
        const label = cancelled ? "Cancelled in CC5" : loadFailed ? "Failed"
          : buildReport(r, r.path ?? "").checks.length ? "Finished with warnings" : "Finished";
        const formatted = formatLoadResult(loadFailed ? { ...r, success: false } : r, r.path ?? "(file)",
          cancelled ? CANCELLED_LOAD : undefined);
        const text = `${label} (load_asset):\n${formatted.content.map((c) => c.text).join("\n")}`;
        return formatted.isError ? errorResult(text) : { content: [{ type: "text" as const, text }] };
      }
      const failed = job.status === "failed";
      const warnings = warningNotes(job.result);
      const warned = !failed && warnings.length > 0;
      const label = cancelled ? "Cancelled in CC5" : failed ? "Failed" : warned ? "Finished with warnings" : "Finished";
      // X-2: a CC5 timeline left at one frame after the export is no export setting CC5 failed to apply.
      const timelineLeft = warnings.some((n) => n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
      const settingWarned = !failed && warnings.some((n) => !n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
      // Same rule as the tools that start these jobs: an export that ran without some of its settings is
      // an error; an import with warnings is not, because repeating it would add the content twice.
      const isError = failed || cancelled || (settingWarned && EXPORTS_CHECKED_FOR_WARNINGS.has(job.action));
      // The FBX is called usable only when nothing else went wrong: a cancelled export gets TIMELINE_LEFT_LINE.
      const timeline = timelineLeft ? `\n${isError ? TIMELINE_LEFT_LINE : TIMELINE_USABLE_LINE}` : "";
      const cancel = cancelled ? `\n${cancelledLine(job)}` : "";
      const text = `${label} (${job.action}):\n${JSON.stringify(job.result, null, 2)}${cancel}${timeline}`;
      return isError ? errorResult(text) : { content: [{ type: "text" as const, text }] };
    }
  );
}

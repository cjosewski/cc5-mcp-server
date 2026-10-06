/**
 * Shared utilities for MCP tool callbacks.
 */

import { BridgeHttpError, BridgeTimeoutError, BridgeUnreachableError } from "./cc5-bridge.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function isFailure(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { success?: unknown }).success === false;
}

/**
 * The "WARNING ..." entries of a plugin result's `notes`: settings CC5 did not apply, or parts of an
 * operation that did not happen, on a call that otherwise succeeded.
 */
export function warningNotes(result: unknown): string[] {
  const notes = typeof result === "object" && result !== null ? (result as { notes?: unknown }).notes : undefined;
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string" && n.startsWith("WARNING")) : [];
}

/** The parts of the SDK's per-request `extra` that progress reporting uses. */
export type ProgressExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
};

/**
 * Reports progress with MCP notifications/progress when the client asked for it (a progressToken on the
 * request). Each notification also restarts Claude Code's idle timeout for a long tool call.
 */
export function progressReporter(extra?: ProgressExtra): (message: string) => void {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return () => undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    send({ method: "notifications/progress", params: { progressToken: token, progress, message } })
      .catch((err: unknown) => console.error("[CC5 MCP] progress notification failed:", err));
  };
}

/**
 * Error result for a failed bridge call. Only a CC5 that could not be reached gets the
 * "Is CC5 running" hint: when CC5 answered with an error, its own message says what went wrong.
 * Logs the full error (including stack) to stderr so MCP stdio is not corrupted.
 */
export function bridgeErrorResult(err: unknown): ToolResult {
  console.error("[CC5 Bridge] bridge call failed:", err);
  const message = err instanceof Error ? err.message : String(err);
  // CC5 answered: a command it refused or that failed (400), a command waiting on a CC5 dialog (409) or one that
  // timed out (504). Its own text says what happened; "CC5 bridge error" would read as a connection fault (F-21).
  if (err instanceof BridgeHttpError && [400, 409, 504].includes(err.status)) return errorResult(message);
  // A request that timed out: CC5 may still be working on it; its text says what to check, it is not a connection fault.
  if (err instanceof BridgeTimeoutError) return errorResult(message);
  if (err instanceof BridgeUnreachableError) {
    // One period before the question, whether or not the message ends with one.
    return errorResult(`CC5 bridge error: ${message.replace(/\.$/, "")}. Is CC5 running with the MCP Bridge plugin?`);
  }
  return errorResult(`CC5 bridge error: ${message}`);
}

/**
 * Wraps a bridge call with try/catch, returning a structured MCP content response.
 * Prevents unhandled errors from propagating to the MCP SDK.
 */
export async function bridgeCall<T>(
  fn: () => Promise<T>,
  formatSuccess: (result: T) => string,
): Promise<ToolResult> {
  try {
    const result = await fn();
    const text = formatSuccess(result);
    return isFailure(result) ? errorResult(text) : { content: [{ type: "text" as const, text }] };
  } catch (err: unknown) {
    return bridgeErrorResult(err);
  }
}

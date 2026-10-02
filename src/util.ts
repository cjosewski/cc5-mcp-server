/**
 * Shared utilities for MCP tool callbacks.
 */

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function isFailure(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { success?: unknown }).success === false;
}

/**
 * Wraps a bridge call with try/catch, returning a structured MCP content response.
 * Prevents unhandled errors from propagating to the MCP SDK.
 * Logs the full error (including stack) to stderr so MCP stdio is not corrupted.
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
    console.error("[CC5 Bridge] bridgeCall caught error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`CC5 bridge error: ${message}. Is CC5 running with the MCP Bridge plugin?`);
  }
}

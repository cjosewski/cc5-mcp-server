/**
 * Bridge token lookup. The CC5 plugin writes a random token to
 * %LOCALAPPDATA%\CC5_MCP_Bridge\token on first start; we send it on every request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: string | null = null;

export function tokenPath(): string {
  const base = process.env.LOCALAPPDATA ?? os.tmpdir();
  return path.join(base, "CC5_MCP_Bridge", "token");
}

export function getBridgeToken(): string | null {
  const fromEnv = process.env.CC5_BRIDGE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;
  try {
    const fromFile = fs.readFileSync(tokenPath(), "utf8").trim();
    if (fromFile) cached = fromFile;
  } catch {
    // CC5 has not started the plugin yet; try again on the next request.
  }
  return cached;
}

export function resetTokenCache(): void {
  cached = null;
}

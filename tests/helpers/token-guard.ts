/**
 * Guard for tests that write or delete the bridge token file.
 */

import os from "node:os";
import path from "node:path";
import { tokenPath } from "../../src/auth.js";

/**
 * Returns tokenPath() when it lies inside the OS temp folder, and throws otherwise. tests/setup-env.ts points
 * LOCALAPPDATA at a temp folder; if it is ever not loaded, tokenPath() is the developer's real CC5 bridge
 * token, which a test must never overwrite or delete.
 */
export function tempTokenPath(): string {
  const tmp = path.resolve(os.tmpdir());
  const token = path.resolve(tokenPath());
  const rel = path.relative(tmp, token);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch ${token}: it is outside the temp folder ${tmp}, so it may be the real CC5 bridge token. Is tests/setup-env.ts loaded?`);
  }
  return token;
}

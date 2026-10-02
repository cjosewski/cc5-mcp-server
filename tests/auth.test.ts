import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { getBridgeToken, resetTokenCache } from "../src/auth.js";
import { tempTokenPath } from "./helpers/token-guard.js";

beforeEach(() => {
  resetTokenCache();
  delete process.env.CC5_BRIDGE_TOKEN;
  // tempTokenPath() throws unless the token lives in the temp folder (tests/setup-env.ts), so this never
  // deletes the developer's real token.
  fs.rmSync(path.dirname(tempTokenPath()), { recursive: true, force: true });
});

describe("getBridgeToken", () => {
  it("returns null when no env and no file", () => {
    expect(getBridgeToken()).toBeNull();
  });

  it("prefers CC5_BRIDGE_TOKEN", () => {
    process.env.CC5_BRIDGE_TOKEN = "from-env";
    expect(getBridgeToken()).toBe("from-env");
  });

  it("picks up a token file written after startup", () => {
    expect(getBridgeToken()).toBeNull();
    const token = tempTokenPath();
    fs.mkdirSync(path.dirname(token), { recursive: true });
    fs.writeFileSync(token, "from-file\n");
    expect(getBridgeToken()).toBe("from-file");
  });
});

describe("tempTokenPath", () => {
  it("refuses a token path outside the temp folder, e.g. the real %LOCALAPPDATA%", () => {
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = process.cwd();  // the repo: not the temp folder
    try {
      expect(() => tempTokenPath()).toThrow(/Refusing to touch .* outside the temp folder/);
    } finally {
      process.env.LOCALAPPDATA = saved;
    }
  });

  it("allows the temp folder tests/setup-env.ts set up", () => {
    expect(tempTokenPath()).toContain("CC5_MCP_Bridge");
  });
});

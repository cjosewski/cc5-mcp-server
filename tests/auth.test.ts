import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { getBridgeToken, tokenPath, resetTokenCache } from "../src/auth.js";

beforeEach(() => {
  resetTokenCache();
  delete process.env.CC5_BRIDGE_TOKEN;
  fs.rmSync(path.dirname(tokenPath()), { recursive: true, force: true });
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
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
    fs.writeFileSync(tokenPath(), "from-file\n");
    expect(getBridgeToken()).toBe("from-file");
  });
});

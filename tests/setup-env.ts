import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate tests from a real CC5 token on the developer's machine.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-test-"));
delete process.env.CC5_BRIDGE_TOKEN;

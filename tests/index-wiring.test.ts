/**
 * src/index.ts wiring, read as text: importing it would run main(), which connects stdio. Checks the MCP server
 * instructions, that every tool module is registered once (check_fit right after the camera tools), the
 * create_character prompt, and that README.md and CLAUDE.md state the tool counts the code has: they drifted twice
 * (84 and 56 against 88).
 */

import fs from "node:fs";
import { describe, it, expect } from "vitest";

const read = (relative: string): string => fs.readFileSync(new URL(relative, import.meta.url), "utf-8");

const index = read("../src/index.ts");
const toolsDir = new URL("../src/tools/", import.meta.url);
const TOOL_CALL = /\bserver\.(?:tool|registerTool)\(/g;
/** Each src/tools/*.ts file and how many tools it registers. */
const toolFiles = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts")).sort()
  .map((file) => ({ file, tools: (fs.readFileSync(new URL(file, toolsDir), "utf-8").match(TOOL_CALL) ?? []).length }));
const registering = toolFiles.filter((f) => f.tools > 0);
const N = registering.reduce((sum, f) => sum + f.tools, 0);
const M = registering.length;

describe("src/index.ts wiring", () => {
  it("sends the protocol rules as the MCP server instructions", () => {
    expect(index).toMatch(/import\s*\{\s*SERVER_INSTRUCTIONS\s*\}\s*from\s*"\.\/prompts\/content-rules\.js";/);
    expect(index).toMatch(/new McpServer\(\s*\{[^}]*\}\s*,\s*\{\s*instructions:\s*SERVER_INSTRUCTIONS\s*\}\s*\)/);
  });

  it("registers check_fit right after the camera tools", () => {
    expect(index).toMatch(/import\s*\{\s*registerFitTools\s*\}\s*from\s*"\.\/tools\/fit\.js";/);
    expect(index).toMatch(/registerCameraTools\(server, bridge\);\s*registerFitTools\(server, bridge\);/);
  });

  it("calls every imported tool registration exactly once, as name(server, bridge)", () => {
    const imported = [...index.matchAll(/import\s*\{\s*(register\w+Tools)\s*\}\s*from/g)].map((m) => m[1]);
    expect(imported).toContain("registerFitTools");
    for (const name of imported) {
      expect(index.split(`${name}(server, bridge);`).length - 1, `src/index.ts: call ${name}(server, bridge) once`).toBe(1);
    }
    const called = [...index.matchAll(/\b(register\w+Tools)\(/g)].map((m) => m[1]);
    expect([...called].sort(), "src/index.ts: every register...Tools call must be imported").toEqual([...imported].sort());
  });

  it("imports every tool file in src/tools", () => {
    for (const { file } of registering) {
      const modulePath = `./tools/${file.replace(/\.ts$/, ".js")}`;
      expect(index, `src/index.ts: import and register the tools of src/tools/${file}`).toContain(`from "${modulePath}";`);
    }
  });

  it("still registers the create_character prompt", () => {
    expect(index).toContain("registerCreateCharacterPrompt(server);");
  });
});

describe("tool counts in the docs", () => {
  it("counts check_fit among the tools", () => {
    expect(toolFiles.find((f) => f.file === "fit.ts")?.tools).toBe(1);
    expect(N).toBeGreaterThan(0);
  });

  it("README.md states the number of tools and modules, and each tool file's count", () => {
    const readme = read("../README.md");
    expect(readme, `README.md: the Features heading must read "### MCP Tools (${N})"`).toContain(`### MCP Tools (${N})`);
    expect(readme, `README.md: the intro must say "provides ${N} tools across ${M} modules"`)
      .toContain(`provides ${N} tools across ${M} modules`);
    expect(readme, `README.md: the Project Structure tools/ line must say "(${M} files, ${N} tools total)"`)
      .toContain(`(${M} files, ${N} tools total)`);
    for (const { file, tools } of registering) {
      const entry = new RegExp(`(?:├|└)── ${file.replace(/[.-]/g, "\\$&")}\\s+#[^\\n]*\\(${tools} tools?\\)`);
      expect(readme, `README.md: the Project Structure line of ${file} must end with (${tools} tool${tools === 1 ? "" : "s"})`)
        .toMatch(entry);
    }
  });

  it("CLAUDE.md states the number of tools and files", () => {
    const claude = read("../CLAUDE.md");
    expect(claude, `CLAUDE.md: the tools section must say "registers ${N} tools from ${M} files"`)
      .toContain(`registers ${N} tools from ${M} files`);
    expect(claude, `CLAUDE.md: the Directory structure tools/ line must say "(${M} files, ${N} tools)"`)
      .toContain(`(${M} files, ${N} tools)`);
  });
});

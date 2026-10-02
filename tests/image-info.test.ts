import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { readImageSize } from "../src/image-info.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));

function write(name: string, bytes: number[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

describe("readImageSize", () => {
  it("reads PNG IHDR", () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0x08, 0x00, 0, 0, 0x04, 0x00];
    expect(readImageSize(write("a.png", png))).toEqual({ width: 2048, height: 1024 });
  });

  it("reads JPEG SOF0", () => {
    const jpg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x00, 0x04, 0x00, 3, 0, 0, 0];
    expect(readImageSize(write("a.jpg", jpg))).toEqual({ width: 1024, height: 512 });
  });

  it("reads TGA header", () => {
    const tga = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0x08, 32, 0];
    expect(readImageSize(write("a.tga", tga))).toEqual({ width: 4096, height: 2048 });
  });

  it("returns null for unknown data", () => {
    expect(readImageSize(write("a.bin", [1, 2, 3]))).toBeNull();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { readImageSize } from "../src/image-info.js";
import { tiff, bmp } from "./helpers/images.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));

function write(name: string, bytes: number[] | Buffer): string {
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

  it("reads a little-endian TIFF with SHORT width and height", () => {
    const t = tiff(true, [[254, 4, 0], [256, 3, 2048], [257, 3, 1024], [258, 3, 8]]);
    expect(readImageSize(write("a.tif", t))).toEqual({ width: 2048, height: 1024 });
  });

  it("reads a big-endian TIFF with LONG width and height", () => {
    const t = tiff(false, [[256, 4, 4096], [257, 4, 2048], [259, 3, 1]]);
    expect(readImageSize(write("b.tiff", t))).toEqual({ width: 4096, height: 2048 });
  });

  it("reads a TIFF whose first IFD comes after a large block of image data", () => {
    const t = tiff(true, [[256, 3, 2048], [257, 4, 2048]], 200_000);
    expect(readImageSize(write("c.tif", t))).toEqual({ width: 2048, height: 2048 });
  });

  it("returns null for a truncated or malformed TIFF", () => {
    const good = tiff(true, [[256, 3, 2048], [257, 3, 1024]]);
    expect(readImageSize(write("t1.tif", good.subarray(0, good.length - 10)))).toBeNull(); // IFD cut short
    expect(readImageSize(write("t2.tif", good.subarray(0, 6)))).toBeNull(); // header cut short
    const farIfd = Buffer.from(good);
    farIfd.writeUInt32LE(1_000_000, 4); // first IFD offset past the end of the file
    expect(readImageSize(write("t3.tif", farIfd))).toBeNull();
    expect(readImageSize(write("t4.tif", tiff(true, [[256, 3, 2048]])))).toBeNull(); // no ImageLength tag
    expect(readImageSize(write("t5.tif", tiff(true, [[256, 1, 8], [257, 1, 8]])))).toBeNull(); // BYTE type
    expect(readImageSize(write("t6.tif", tiff(true, [[256, 3, 0], [257, 3, 1024]])))).toBeNull(); // zero width
    const bigTiff = Buffer.from(good);
    bigTiff.writeUInt16LE(43, 2); // BigTIFF
    expect(readImageSize(write("t7.tif", bigTiff))).toBeNull();
  });

  it("reads a BMP header", () => {
    expect(readImageSize(write("a.bmp", bmp(1024, 512)))).toEqual({ width: 1024, height: 512 });
  });

  it("reads a top-down BMP (negative height) as its absolute height", () => {
    expect(readImageSize(write("b.bmp", bmp(1024, -512)))).toEqual({ width: 1024, height: 512 });
  });

  it("returns null for a truncated BMP", () => {
    expect(readImageSize(write("c.bmp", bmp(1024, 512).subarray(0, 20)))).toBeNull();
  });

  it("returns null for unknown data", () => {
    expect(readImageSize(write("a.bin", [1, 2, 3]))).toBeNull();
  });
});

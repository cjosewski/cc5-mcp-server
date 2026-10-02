/**
 * Read image dimensions from file headers (PNG, JPEG, TGA) without decoding.
 */

import fs from "node:fs";

export function readImageSize(file: string): { width: number; height: number } | null {
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    buf = Buffer.alloc(65_536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, n);
  } catch {
    return null;
  }
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (file.toLowerCase().endsWith(".tga") && buf.length >= 18) {
    return { width: buf.readUInt16LE(12), height: buf.readUInt16LE(14) };
  }
  return null;
}

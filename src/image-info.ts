/**
 * Read image dimensions from file headers (PNG, JPEG, TGA, TIFF, BMP) without decoding.
 */

import fs from "node:fs";

/**
 * A PNG's size from its first bytes: the 8-byte signature, then the IHDR chunk with the width (u32 big endian) at
 * offset 16 and the height at offset 20. Null when `buf` is shorter than that or not a PNG. check_fit reads its
 * captures with it.
 */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Up to `length` bytes of the file starting at `position` (fewer at the end of the file). */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

/**
 * TIFF: "II" (little endian) or "MM" (big endian), version 42, then the offset of the first IFD. The IFD is a
 * 2-byte entry count and 12-byte entries (tag u16, type u16, count u32, value u32); tag 256 is the width and 257
 * the height, as SHORT (type 3, in the value field's first 2 bytes) or LONG (type 4). The first IFD often sits after
 * the image data at the end of the file, so it is read at its offset. BigTIFF (version 43) is not read.
 */
function readTiffSize(fd: number, head: Buffer): { width: number; height: number } | null {
  if (head.length < 8) return null;
  const le = head[0] === 0x49;
  const u16 = (b: Buffer, at: number) => (le ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (b: Buffer, at: number) => (le ? b.readUInt32LE(at) : b.readUInt32BE(at));
  if (u16(head, 2) !== 42) return null;
  const ifd = u32(head, 4);
  if (ifd < 8) return null;
  const countBuf = readAt(fd, ifd, 2);
  if (countBuf.length < 2) return null;
  const count = u16(countBuf, 0);
  const entries = readAt(fd, ifd + 2, count * 12);
  if (entries.length < count * 12) return null;
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const at = i * 12;
    const tag = u16(entries, at);
    if (tag !== 256 && tag !== 257) continue;
    const type = u16(entries, at + 2);
    let value: number;
    if (type === 3) value = u16(entries, at + 8);
    else if (type === 4) value = u32(entries, at + 8);
    else return null;
    if (tag === 256) width = value;
    else height = value;
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

export function readImageSize(file: string): { width: number; height: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = readAt(fd, 0, 65_536);
    const png = pngSize(buf);
    if (png) return png;
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
    if (buf.length >= 2 && ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d))) {
      return readTiffSize(fd, buf);
    }
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
      // BMP: int32 little endian width at 18 and height at 22; a negative height is a top-down bitmap.
      if (buf.length < 26) return null;
      const width = buf.readInt32LE(18);
      const height = Math.abs(buf.readInt32LE(22));
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (file.toLowerCase().endsWith(".tga") && buf.length >= 18) {
      return { width: buf.readUInt16LE(12), height: buf.readUInt16LE(14) };
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

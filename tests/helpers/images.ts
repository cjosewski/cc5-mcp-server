/** Small synthetic image headers for the image-size tests. */

/**
 * A minimal TIFF: 8-byte header, `pad` bytes of image data, then the first IFD with one entry per
 * [tag, type, value] (type 3 SHORT puts the value in the first 2 bytes of the value field, type 4 LONG in all 4).
 */
export function tiff(littleEndian: boolean, entries: Array<[number, number, number]>, pad = 0): Buffer {
  const ifd = 8 + pad;
  const buf = Buffer.alloc(ifd + 2 + entries.length * 12 + 4);
  const u16 = (v: number, at: number) => (littleEndian ? buf.writeUInt16LE(v, at) : buf.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (littleEndian ? buf.writeUInt32LE(v, at) : buf.writeUInt32BE(v, at));
  buf.write(littleEndian ? "II" : "MM", 0, "latin1");
  u16(42, 2);
  u32(ifd, 4);
  u16(entries.length, ifd);
  entries.forEach(([tag, type, value], i) => {
    const at = ifd + 2 + i * 12;
    u16(tag, at);
    u16(type, at + 2);
    u32(1, at + 4);
    if (type === 3) u16(value, at + 8);
    else u32(value, at + 8);
  });
  return buf;
}

/** A BMP file header plus BITMAPINFOHEADER: width at offset 18, height at offset 22 (int32 little endian). */
export function bmp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(54);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(54, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

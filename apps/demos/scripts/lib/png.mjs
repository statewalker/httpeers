/**
 * A solid-colour PNG, built by hand.
 *
 * The smoke tests need a REAL image to hand to the file picker: one the browser
 * will actually decode, at dimensions nothing else in the gallery shares, so
 * "the picture the person chose arrived at the other peer" can be asserted by
 * measuring rather than by counting. A fixture file on disk would do the same
 * job, but a generated one cannot drift from the assertion that reads it.
 *
 * Deliberately no dependency. The format is four chunks and a CRC, and `zlib`
 * (with `crc32`, Node 22+) is in the standard library.
 */

import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** length + type + data + CRC(type + data) — the shape every PNG chunk has. */
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * A `width` x `height` PNG filled with one colour.
 *
 * Colour type 2 (truecolour, 8 bits) so there is no palette to build, and
 * filter byte 0 on every scanline so there is no prediction to undo.
 */
export function solidPng(width, height, [r, g, b] = [200, 30, 90]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10, 11, 12 stay 0: deflate, adaptive filtering, no interlace.

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

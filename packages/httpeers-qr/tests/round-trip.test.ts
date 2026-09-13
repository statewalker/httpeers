/**
 * The two halves check each other, with no camera and no DOM.
 *
 * That property is the package's whole claim: encode a string, rasterise the
 * result, decode the pixels, get the string back — in Node, with nothing
 * browser-shaped anywhere in the path. A test that only asserted "the SVG
 * contains a `<path>`" would pass for an SVG that no decoder can read.
 *
 * The payload is a real 302-character join blob, because size is the thing
 * that breaks QR codes: it decides the grid version, which decides how much a
 * blur or a small capture can be tolerated. Testing "hello" would prove
 * nothing about the codes this package actually exists to carry.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeQr } from "../src/decode.js";
import { qrModules, qrSvg } from "../src/encode.js";

/** A join blob of the length the mesh really produces. */
const JOIN_BLOB = `httpeers:join?v=1&hub=12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ&code=${"K7f2Qa9XmZp4".repeat(
  14,
)}`;

/** Modules of quiet zone, matching `encode.ts`'s own. */
const QUIET_ZONE = 4;

/**
 * Rasterise the module matrix directly rather than rendering the SVG.
 *
 * `qrSvg` and `qrModules` are the same code path up to the drawing, and this
 * keeps the test free of an SVG renderer — one more dependency that would run
 * in Node and not in a page, in a package whose point is that it runs in both.
 * `qrSvg` is asserted separately, as a string.
 */
async function rasterise(
  text: string,
  scale: number,
): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const modules = qrModules(text);
  const n = modules.length;
  const span = (n + QUIET_ZONE * 2) * scale;
  const gray = Buffer.alloc(span * span, 255);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y]?.[x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + QUIET_ZONE) * scale + dy) * span;
        gray.fill(0, row + (x + QUIET_ZONE) * scale, row + (x + QUIET_ZONE) * scale + scale);
      }
    }
  }

  const { data, info } = await sharp(gray, { raw: { width: span, height: span, channels: 1 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

describe("encode → decode, in Node", () => {
  it("round-trips a real join blob", async () => {
    const pixels = await rasterise(JOIN_BLOB, 4);
    expect(decodeQr(pixels)).toBe(JOIN_BLOB);
  });

  it("round-trips a short payload too", async () => {
    const pixels = await rasterise("hello mesh", 6);
    expect(decodeQr(pixels)).toBe("hello mesh");
  });

  it("returns null for pixels with no code in them, rather than throwing", async () => {
    // The ordinary case while scanning. A decoder that throws here forces
    // every caller to wrap its frame loop in try/catch.
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(decodeQr({ data: blank, width: 64, height: 64 })).toBeNull();
  });
});

describe("qrSvg", () => {
  it("is a self-contained SVG string sized by its viewBox", () => {
    const svg = qrSvg(JOIN_BLOB);
    const n = qrModules(JOIN_BLOB).length;
    const span = n + QUIET_ZONE * 2;
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${span} ${span}"`);
    // crispEdges is load-bearing, not cosmetic: antialiased module boundaries
    // are what a decoder has the most trouble with.
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain("<path");
  });

  it("refuses an empty payload instead of emitting an unscannable code", () => {
    expect(() => qrSvg("")).toThrow(/empty payload/);
  });

  it("grows the grid with the payload", () => {
    // A guard against an encoder that silently truncates: more data must not
    // fit in the same number of modules.
    expect(qrModules(JOIN_BLOB).length).toBeGreaterThan(qrModules("hi").length);
  });
});

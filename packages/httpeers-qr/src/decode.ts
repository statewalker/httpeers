/**
 * Decoding, on pixels and nothing else.
 *
 * THE POINT OF TAKING PIXELS. The decoder this replaces reaches for
 * `document`, builds an element, and drives a camera — so it runs in a page
 * and nowhere else. A function of `{ data, width, height }` runs in Node, in a
 * worker, in Deno and in a page, and the caller decides where the pixels came
 * from: a file, a canvas, a video frame, a PNG decoded on a server.
 *
 * WHAT THIS IS NOT. It is not the live camera loop, and it does not replace
 * it. Measured over twelve degradations of a real 302-character join blob
 * (rung 03 of the extraction prototypes), `jsqr` scored 8/12 against the
 * incumbent `html5-qrcode`'s 9/12, the two differing on heavy blur. The
 * incumbent stays where a camera is pointed at a screen; this exists so a
 * still image can be decoded anywhere, which the incumbent cannot do at all.
 *
 * Evidence, and its limit: those twelve degradations are MANUFACTURED — blur,
 * rotation, perspective, JPEG artefacts, low contrast, glare, small captures —
 * because no photograph of a real invitation survives in the repository. That
 * is weaker evidence than a phone photo and is labelled as such wherever the
 * score appears.
 */

import jsQR from "jsqr";

/**
 * Pixels, in the layout every image API already produces: RGBA, four bytes per
 * pixel, row-major. `ImageData` satisfies this structurally, so a browser
 * caller passes one straight through without naming a DOM type here.
 */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DecodeOptions {
  /**
   * How to treat inverted codes — light modules on a dark ground.
   *
   * The default tries both, because a code photographed off a dark-mode screen
   * is inverted and a caller has no way to know in advance.
   */
  inversion?: "attemptBoth" | "dontInvert" | "onlyInvert" | "invertFirst";
}

/**
 * The text a QR code in `pixels` carries, or `null` when there is none.
 *
 * `null` rather than a throw: "no code in this frame" is the ordinary case
 * when scanning, not an error, and a decoder that throws on it forces every
 * caller to wrap a loop in try/catch.
 */
export function decodeQr(pixels: Pixels, options: DecodeOptions = {}): string | null {
  const result = jsQR(pixels.data, pixels.width, pixels.height, {
    inversionAttempts: options.inversion ?? "attemptBoth",
  });
  return result?.data ?? null;
}

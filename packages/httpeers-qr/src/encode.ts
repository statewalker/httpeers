/**
 * An invitation as a QR code.
 *
 * WHAT IT ENCODES, AND WHY THAT AND NOTHING ELSE. The bare invitation code --
 * exactly the string the join field already accepts. Not a deep link to a
 * particular page, because `../../pages/hub/main.ts` states the rule this
 * upholds: an invitation is NOT tied to a page. Any page redeems any code, and
 * the hub never learns which origin used it. A QR carrying
 * `https://app.httpeers.net/?join=...` would quietly reverse that and teach the
 * hub about its guests' URLs.
 *
 * SVG, NOT CANVAS. It stays crisp at any size, survives a screenshot or a
 * print at full resolution, and needs no element to exist before it can be
 * built -- so this module is a pure function of a string and is testable
 * without a DOM.
 *
 * ERROR CORRECTION LEVEL M (~15%). A code that is going to be PHOTOGRAPHED off
 * a screen has to survive glare, moire against the pixel grid, and a phone
 * held at an angle. L is smaller but leaves nothing for that; Q and H would
 * push a 315-character invitation to a denser grid, which photographs worse.
 * M is the level that survives the actual use.
 */
import qrcode from "qrcode-generator";

/** Type number 0 asks the library to pick the smallest version that fits. */
const AUTO_VERSION = 0;
const ERROR_CORRECTION = "M";

/** Modules of empty space around the code. Four is the spec's minimum; without it many decoders never find the finder patterns. */
const QUIET_ZONE = 4;

function build(text: string) {
  if (text === "") {
    throw new Error(
      "qr: refusing to encode an empty payload -- the result would not be scannable.",
    );
  }
  const qr = qrcode(AUTO_VERSION, ERROR_CORRECTION);
  qr.addData(text);
  qr.make();
  return qr;
}

/** The code as a square matrix, `true` where a module is dark. Exported so a test can rasterise it and decode the pixels for real. */
export function qrModules(text: string): boolean[][] {
  const qr = build(text);
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => qr.isDark(y, x)));
}

/**
 * The code as an inline SVG string, sized by CSS rather than by attributes so
 * a caller decides how big it renders.
 *
 * Drawn as one `<path>` of rectangles rather than one element per module: a
 * 315-character invitation is a 45x45 grid, and 2000 elements is a needless
 * amount of DOM for a picture.
 */
export function qrSvg(text: string): string {
  const modules = qrModules(text);
  const n = modules.length;
  const span = n + QUIET_ZONE * 2;

  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y]?.[x]) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }

  // `shape-rendering="crispEdges"` stops the renderer antialiasing module
  // boundaries into grey, which is what a decoder has the most trouble with.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="invitation QR code">` +
    `<rect width="${span}" height="${span}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}

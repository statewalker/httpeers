/**
 * QR, as two pure functions that check each other.
 *
 * A string in, an SVG out; pixels in, a string out. Neither half touches a
 * camera, a canvas or the DOM, which is what lets the same code run on a
 * server rendering an invitation and in a page scanning one.
 */

export { type DecodeOptions, decodeQr, type Pixels } from "./decode.js";
export { qrModules, qrSvg } from "./encode.js";

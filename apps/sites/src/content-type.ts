/**
 * Extension -> MIME type.
 *
 * A table rather than a dependency: the set of things a static site serves is
 * small and known, and `FilesApi` exposes no content type of its own, so
 * there is nothing to reconcile against.
 */

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  xml: "application/xml",
  svg: "image/svg+xml",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
  zip: "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

/** Types served as text, which need a charset or browsers guess -- often wrongly. */
const TEXTUAL = /^(text\/|application\/(json|xml)$|image\/svg\+xml$)/;

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot === -1 || dot < slash) return DEFAULT_CONTENT_TYPE;
  const type = TYPES[path.slice(dot + 1).toLowerCase()];
  if (type == null) return DEFAULT_CONTENT_TYPE;
  return TEXTUAL.test(type) ? `${type}; charset=utf-8` : type;
}

/**
 * Request path -> the files that might answer it. Pure: no storage, no
 * `FilesApi`, no environment.
 *
 * KEPT PURE ON PURPOSE. Candidate ordering is the part of a static server
 * that is easy to get subtly wrong and hard to notice, so it is a
 * table-driven unit test with no adapter, no temp directory and no network.
 */

export type CandidateKind = "exact" | "html-extension" | "directory-index";

export interface Candidate {
  path: string;
  kind: CandidateKind;
}

/** The per-site configuration directory. Never servable -- see `isConfigPath`. */
export const SITE_CONFIG_DIR = ".site";

/**
 * Decode, collapse duplicate slashes, and reject traversal.
 *
 * DECODE FIRST, THEN CHECK. Checking before decoding lets `%2e%2e%2f` walk
 * straight through, because it contains no literal `..` until it is decoded.
 */
export function normalizeRequestPath(raw: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding. A rejection, not a crash.
    return undefined;
  }
  if (!path.startsWith("/")) return undefined;
  if (path.includes("\0")) return undefined;
  path = path.replace(/\/{2,}/g, "/");
  if (path.split("/").includes("..")) return undefined;
  return path;
}

/**
 * The files that could answer `path`, in the order to try them.
 *
 * A directory-index candidate is tagged so the caller can honour the
 * trailing-slash redirect -- see `serve.ts`, which must NOT serve
 * `/foo/index.html` at the URL `/foo`.
 */
export function candidates(path: string): Candidate[] {
  if (path.endsWith("/")) {
    return [{ path: `${path}index.html`, kind: "directory-index" }];
  }
  return [
    { path, kind: "exact" },
    { path: `${path}.html`, kind: "html-extension" },
    { path: `${path}/index.html`, kind: "directory-index" },
  ];
}

/**
 * Is this path inside a site's configuration directory?
 *
 * Matches the directory as a whole path segment only, so `/.well-known/` and
 * every other dotfile stay servable -- sites legitimately need those.
 */
export function isConfigPath(path: string): boolean {
  return path.split("/").includes(SITE_CONFIG_DIR);
}

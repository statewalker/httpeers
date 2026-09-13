/**
 * Candidates, against storage. The only module that decides what "exists".
 */
import type { FileStats, FilesApi } from "@statewalker/webrun-files";
import { type CandidateKind, candidates, isConfigPath, normalizeRequestPath } from "./resolve.js";

export interface FoundFile {
  found: true;
  /** The full storage path, including the site prefix. */
  storagePath: string;
  stats: FileStats;
  kind: CandidateKind;
}

export type LookupResult = FoundFile | { found: false };

const NOT_FOUND: LookupResult = { found: false };

/**
 * `stats()` for a path, narrowed to files.
 *
 * WHY EVERY LOOKUP GOES THROUGH THIS. `FilesApi.read()` returns an empty async
 * iterable for a path that does not exist -- it does not throw. A handler that
 * trusted `read()` would answer a missing file with `200` and a zero-length
 * body, which looks like a broken site rather than a missing one. Existence is
 * therefore always established before anything is read, and a directory is
 * never mistaken for a file.
 */
export async function statFile(
  files: FilesApi,
  storagePath: string,
): Promise<FileStats | undefined> {
  const stats = await files.stats(storagePath);
  return stats?.kind === "file" ? stats : undefined;
}

/**
 * Resolve a request path within one site.
 *
 * Returns the first candidate that is a file, tagged with which candidate it
 * was -- the caller needs `kind` to honour the trailing-slash redirect.
 */
export async function lookupFile(
  files: FilesApi,
  site: string,
  requestPath: string,
): Promise<LookupResult> {
  const path = normalizeRequestPath(requestPath);
  if (path == null) return NOT_FOUND;

  // 404, not 403: a 403 would confirm the directory exists.
  if (isConfigPath(path)) return NOT_FOUND;

  for (const candidate of candidates(path)) {
    const storagePath = `/${site}${candidate.path}`;
    const stats = await statFile(files, storagePath);
    if (stats != null) {
      return { found: true, storagePath, stats, kind: candidate.kind };
    }
  }
  return NOT_FOUND;
}

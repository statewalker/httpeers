/**
 * Model downloader.
 *
 * `ensureModel` fetches one `ModelEntry`'s GGUF file from Hugging Face into
 * `<dir>/<id>/<file>` and returns a `LockEntry` describing what landed.
 * Task 7 mounts that path read-only into a Compose service.
 *
 * Write-then-rename, matching `apps/hub/src/fs-atomic.ts`: the body streams
 * to `<file>.part` beside the target, and only a *successful* stream gets
 * renamed onto the real path. A rename within the same directory is atomic
 * on POSIX, so a reader of the target path sees a complete file or nothing
 * — never a truncated one. `llama-server` reading a truncated GGUF reports
 * an error about the model file, not about the download that produced it,
 * which is exactly the confusion this discipline exists to prevent. Any
 * failure mid-stream deletes the `.part` in a `catch` before rethrowing, so
 * a retry always starts clean instead of resuming (or worse, being served)
 * a partial file.
 *
 * The body is never buffered whole (`await response.arrayBuffer()`) — these
 * files run 1-20 GB, and a container-sized Node process holding one entirely
 * in memory is how this tool gets OOM-killed. `node:stream/promises`'
 * `pipeline` drives the web ReadableStream straight into a Node write
 * stream.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelEntry } from "./manifest.js";

export interface RemoteFile {
  size: number;
  sha256: string | null;
}

export interface LockEntry {
  id: string;
  repo: string;
  file: string;
  size: number;
  sha256: string | null;
  path: string;
}

export interface Lock {
  schemaVersion: 1;
  models: LockEntry[];
}

/** The Hugging Face URL that serves a model file's raw bytes. */
export function resolveUrl(entry: ModelEntry): string {
  return `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}`;
}

// The shape of one entry in Hugging Face's tree API response
// (`GET /api/models/<repo>/tree/main`). Only the fields this tool reads.
interface TreeEntry {
  path: string;
  size: number;
  lfs: { oid: string } | null;
}

function isTreeEntry(value: unknown): value is TreeEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { size?: unknown }).size === "number"
  );
}

/**
 * Picks one file's size and sha256 out of a Hugging Face tree API response.
 *
 * `sha256` comes from `lfs.oid` — the only checksum the tree API offers. A
 * file not stored via Git LFS (a stray README, say) has no `lfs` entry and
 * therefore no oid to report; this returns `null` rather than inventing one,
 * and callers (`isUpToDate`) fall back to comparing size alone in that case.
 *
 * Throws naming both the file that was requested and the paths the tree
 * actually holds, so a manifest typo or a renamed upstream file produces an
 * error an operator can act on instead of a generic "not found".
 */
export function pickRemoteFile(treeJson: unknown, file: string): RemoteFile {
  const entries = Array.isArray(treeJson) ? treeJson.filter(isTreeEntry) : [];
  const found = entries.find((entry) => entry.path === file);
  if (!found) {
    const available = entries.map((entry) => entry.path).join(", ") || "(empty tree)";
    throw new Error(`File "${file}" not found in Hugging Face tree; available files: ${available}`);
  }
  return { size: found.size, sha256: found.lfs?.oid ?? null };
}

/**
 * Whether a file already on disk matches the remote — no download needed.
 *
 * Size must always match; a mismatch is treated as "not up to date" even
 * when nothing else is known, because a truncated download must never be
 * served as if it were complete. sha256 is compared only when the remote
 * offers one (see `pickRemoteFile`) — otherwise the comparison falls back to
 * size alone.
 */
export function isUpToDate(
  existing: { size: number; sha256: string | null } | null,
  remote: RemoteFile,
): boolean {
  if (existing === null) return false;
  if (existing.size !== remote.size) return false;
  if (remote.sha256 !== null && existing.sha256 !== remote.sha256) return false;
  return true;
}

/**
 * Cross-checks the caller-supplied `previous` lock entry (read from
 * `manifest.lock.json` by Task 9's CLI, which owns that file — this module
 * does no lock-file I/O of its own) against what is actually on disk right
 * now.
 *
 * `previous` alone is not trustworthy: the file it describes could have
 * been deleted, truncated, or replaced since the lock was written. So this
 * only trusts `previous.sha256` when a fresh `stat` of `targetPath` still
 * reports the same size `previous` recorded. That is a cheap check — no
 * re-hashing of a multi-GB file — that still catches truncation or
 * deletion between runs. A `null`/missing `previous` (no prior knowledge)
 * or a size mismatch both fall through to "nothing usable on disk", which
 * is the safe direction: it forces a download rather than risking a stale
 * or truncated file being served.
 */
async function verifiedOnDisk(
  targetPath: string,
  previous: LockEntry | null,
): Promise<{ size: number; sha256: string | null } | null> {
  if (previous === null) return null;
  try {
    const info = await stat(targetPath);
    if (info.size !== previous.size) return null;
    return { size: info.size, sha256: previous.sha256 };
  } catch {
    return null;
  }
}

/**
 * Downloads (or skips, if already present and matching) one model's GGUF
 * file, and returns the lock entry describing it.
 *
 * `opts.previous` is the prior run's `LockEntry` for this model, as Task 9's
 * CLI reads it back from `manifest.lock.json` — this module never reads or
 * writes that file itself, only consumes what it's handed. It defaults to
 * `null` ("no prior knowledge"), and `null` always means "download": a
 * caller that forgets to pass it pays for a redundant download, never risks
 * serving a stale or truncated file.
 */
export async function ensureModel(
  entry: ModelEntry,
  opts: {
    dir: string;
    fetch: typeof globalThis.fetch;
    log: (s: string) => void;
    previous?: LockEntry | null;
  },
): Promise<LockEntry> {
  const modelDir = join(opts.dir, entry.id);
  const targetPath = join(modelDir, entry.file);
  const partPath = `${targetPath}.part`;

  const treeUrl = `https://huggingface.co/api/models/${entry.repo}/tree/main`;
  const treeResponse = await opts.fetch(treeUrl);
  const treeJson = await treeResponse.json();
  const remote = pickRemoteFile(treeJson, entry.file);

  const onDisk = await verifiedOnDisk(targetPath, opts.previous ?? null);
  if (isUpToDate(onDisk, remote)) {
    opts.log(`${entry.id}: already up to date (${remote.size} bytes), skipping download`);
    return {
      id: entry.id,
      repo: entry.repo,
      file: entry.file,
      size: remote.size,
      sha256: remote.sha256,
      path: targetPath,
    };
  }

  await mkdir(dirname(partPath), { recursive: true });

  try {
    const response = await opts.fetch(resolveUrl(entry));
    if (!response.ok || response.body === null) {
      throw new Error(
        `Download of ${entry.repo}/${entry.file} failed with HTTP ${response.status}`,
      );
    }

    let downloaded = 0;
    let lastLoggedPercent = -1;
    const total = remote.size;

    // Wrap the web ReadableStream as a Node Readable so it can be piped
    // through a counting stage into the write stream, without ever holding
    // the whole body in memory at once.
    const nodeBody = Readable.fromWeb(response.body as never);
    const writeStream = createWriteStream(partPath);

    nodeBody.on("data", (chunk: Buffer) => {
      downloaded += chunk.length;
      if (total > 0) {
        const percent = Math.floor((downloaded / total) * 100);
        if (percent > lastLoggedPercent) {
          lastLoggedPercent = percent;
          opts.log(`${entry.id}: ${percent}% (${downloaded}/${total} bytes)`);
        }
      }
    });

    await pipeline(nodeBody, writeStream);
    await rename(partPath, targetPath);
  } catch (err) {
    // Write-then-rename's other half: on ANY failure, delete the partial
    // file before rethrowing, so a retry starts clean and nothing truncated
    // is ever left where a reader (llama-server) would find it. `rm` itself
    // is best-effort here — if the `.part` was never created (e.g. the
    // fetch rejected before the stream started), there is nothing to clean
    // up, and that is not itself an error worth masking the original one.
    await rm(partPath, { force: true });
    throw err;
  }

  opts.log(`${entry.id}: downloaded ${remote.size} bytes`);
  return {
    id: entry.id,
    repo: entry.repo,
    file: entry.file,
    size: remote.size,
    sha256: remote.sha256,
    path: targetPath,
  };
}

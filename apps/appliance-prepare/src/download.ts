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
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
 * The sidecar path that records what `ensureModel` believes is on disk at
 * `targetPath`: the size and sha256 it verified (from HF's tree API) at the
 * moment it finished writing the file there.
 *
 * There is no cheap way to recompute a sha256 for a multi-GB file on every
 * run without re-reading the whole thing, which would defeat the point of
 * skipping the download. Trusting a small sidecar written right after our
 * own successful write-then-rename is safe: it can only exist because this
 * function itself created it immediately after the bytes at `targetPath`
 * were confirmed complete.
 */
function sidecarPathOf(targetPath: string): string {
  return `${targetPath}.meta.json`;
}

async function existingFile(
  targetPath: string,
): Promise<{ size: number; sha256: string | null } | null> {
  try {
    const info = await stat(targetPath);
    const sidecarRaw = await readFile(sidecarPathOf(targetPath), "utf8");
    const sidecar = JSON.parse(sidecarRaw) as { size: number; sha256: string | null };
    // The sidecar is only trustworthy while it agrees with the file it
    // describes. If the model file was replaced or truncated by something
    // outside this tool since the sidecar was written, its size will no
    // longer match `stat` — treat that as "nothing usable on disk" rather
    // than trusting stale metadata.
    if (sidecar.size !== info.size) return null;
    return { size: info.size, sha256: sidecar.sha256 };
  } catch {
    return null;
  }
}

/**
 * Downloads (or skips, if already present and matching) one model's GGUF
 * file, and returns the lock entry describing it.
 */
export async function ensureModel(
  entry: ModelEntry,
  opts: { dir: string; fetch: typeof globalThis.fetch; log: (s: string) => void },
): Promise<LockEntry> {
  const modelDir = join(opts.dir, entry.id);
  const targetPath = join(modelDir, entry.file);
  const partPath = `${targetPath}.part`;

  const treeUrl = `https://huggingface.co/api/models/${entry.repo}/tree/main`;
  const treeResponse = await opts.fetch(treeUrl);
  const treeJson = await treeResponse.json();
  const remote = pickRemoteFile(treeJson, entry.file);

  const onDisk = await existingFile(targetPath);
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
    // Written only after the rename succeeds, so the sidecar and the file
    // it describes never disagree about whether the download completed.
    await writeFile(
      sidecarPathOf(targetPath),
      JSON.stringify({ size: remote.size, sha256: remote.sha256 }),
    );
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

/**
 * Write-then-rename, the one way this daemon writes a file.
 *
 * A file truncated by a crash mid-write is worse than a missing one: a hub
 * that cannot parse `rules.dl` or `revocations.json` must refuse to start, and
 * one that silently fell back to defaults would re-open what the operator
 * closed. A rename within one directory is atomic on POSIX, so a reader sees
 * the old content or the new, never half of either.
 *
 * The staging file is a SIBLING of the target, not in `/tmp`: `/data` is a
 * mounted volume, and a rename across filesystems fails with `EXDEV`.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let counter = 0;
const stagingPath = (target: string) => `${target}.${process.pid}.${Date.now()}.${counter++}.tmp`;

export async function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const staging = stagingPath(target);
  await writeFile(staging, content, { mode });
  await rename(staging, target);
}

export function writeFileAtomicSync(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const staging = stagingPath(target);
  writeFileSync(staging, content, { mode: 0o600 });
  renameSync(staging, target);
}

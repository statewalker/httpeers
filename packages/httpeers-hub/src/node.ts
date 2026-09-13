/**
 * The Node profile: hub state on disk.
 *
 * Write-then-rename, for the reason rung 04 measured: the prototype's file
 * snapshot store wrote IN PLACE, so a crash mid-write left a truncated JSON
 * document — and a hub that cannot parse its snapshot starts EMPTY. Every
 * member forgotten, every spent invitation id forgotten and therefore
 * replayable, and nothing reporting an error.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeyValueStorage } from "./storage.js";

export function fileStorage(path: string): KeyValueStorage {
  const pathFor = (key: string) => `${path}.${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return {
    async get(key) {
      try {
        return await readFile(pathFor(key), "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async set(key, value) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      // Same directory, so the rename cannot cross a filesystem boundary —
      // the one case where it would stop being atomic.
      const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(staging, value, { mode: 0o600 });
      await rename(staging, target);
    },
    async delete(key) {
      const { rm } = await import("node:fs/promises");
      await rm(pathFor(key), { force: true });
    },
  };
}

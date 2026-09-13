/**
 * The candidate `hub` package's storage seam, and two adapters for it.
 *
 * DERIVED, NOT DESIGNED. Everything the hub does to storage today is
 * whole-value get / set / delete by key: `persist.ts` reads and writes one
 * JSON file; `browser/snapshot-store.ts` reads and writes one IndexedDB
 * value. Nothing lists, appends, or compare-and-sets. So the interface is
 * those three methods and no more.
 *
 * `SnapshotStore` (`hub/hub-state.ts`) is deliberately SYNCHRONOUS, because
 * every mutation writes and returns, and an async write would let a caller be
 * told "member added" while the snapshot still said otherwise. Both async
 * backends therefore need the same wrapper the browser already has: the
 * in-memory copy is authoritative, and flushes are serialised behind it.
 * `asyncSnapshotStore` below is that wrapper, generalised — it is
 * `browser/snapshot-store.ts`'s logic over any `KeyValueStorage` rather than
 * over idb-keyval specifically.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { EMPTY_SNAPSHOT, type HubSnapshot, type SnapshotStore } from "./hub-state.js";

/** The whole persistence contract. Three methods, because three is what the hub uses. */
export interface KeyValueStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** For tests and for a hub that deliberately keeps nothing. */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/**
 * A `FilesApi` as key/value storage — one file per key under `dir`.
 *
 * WRITE-THEN-MOVE, because a crash mid-write must not leave a half-written
 * snapshot where the whole state lives. `persist.ts`'s Node implementation
 * does NOT do this (it writes in place), which is a defect this adapter does
 * not inherit.
 *
 * FilesApi HAS NO CONDITIONAL WRITE — no compare-and-set, no if-match. That
 * is why the hub's single-writer precondition is a precondition rather than
 * something the storage layer can enforce; rung 04's third claim measures
 * exactly what that costs.
 */
export function filesStorage(files: FilesApi, dir = "hub"): KeyValueStorage {
  const path = (key: string): string => `${dir}/${encodeURIComponent(key)}.json`;

  return {
    async get(key) {
      const file = path(key);
      if (!(await files.exists(file))) return undefined;
      const chunks: Uint8Array[] = [];
      for await (const chunk of files.read(file)) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return new TextDecoder().decode(bytes);
    },
    async set(key, value) {
      const file = path(key);
      const temp = `${file}.tmp`;
      const bytes = new TextEncoder().encode(value);
      await files.write(
        temp,
        (async function* () {
          yield bytes;
        })(),
      );
      await files.move(temp, file);
    },
    async delete(key) {
      await files.remove(path(key));
    },
  };
}

export interface AsyncSnapshotStore extends SnapshotStore {
  /** Resolves when every write issued so far has reached the backend. */
  flushed(): Promise<void>;
}

/**
 * Load once, then serve reads from memory and flush writes behind them —
 * the shape `SnapshotStore`'s synchronous contract forces on any async
 * backend.
 */
export async function asyncSnapshotStore(
  storage: KeyValueStorage,
  key = "snapshot",
): Promise<AsyncSnapshotStore> {
  const raw = await storage.get(key);
  let current: HubSnapshot = EMPTY_SNAPSHOT;
  if (raw != null) {
    try {
      current = JSON.parse(raw) as HubSnapshot;
    } catch {
      // A corrupt value reads as empty rather than throwing, matching
      // `browser/snapshot-store.ts`. A hub that refuses to start because its
      // state file was truncated is worse than one that starts empty and
      // says so.
      current = EMPTY_SNAPSHOT;
    }
  }

  // Writes are chained, never concurrent: two overlapping flushes of the same
  // key can land out of order, and the loser would be the newer state.
  let chain: Promise<void> = Promise.resolve();

  return {
    read: () => current,
    write(snapshot) {
      current = snapshot;
      const value = JSON.stringify(snapshot);
      chain = chain.then(() => storage.set(key, value)).catch(() => {});
    },
    flushed: () => chain,
  };
}

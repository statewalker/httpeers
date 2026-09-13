/**
 * The browser profile: hub state in IndexedDB.
 *
 * A hub in a tab is a real hub — it mints, it holds the registries, and its
 * members expect to still be members after a reload. `localStorage` would do
 * for strings, but IndexedDB is transactional, which matters when two writes
 * race a reload.
 */

import type { KeyValueStorage } from "./storage.js";

type IdbRequest<T> = {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};
type IdbStore = {
  get(key: string): IdbRequest<string | undefined>;
  put(value: string, key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
};
type IdbDatabase = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): { objectStore(name: string): IdbStore };
  close(): void;
};
declare const indexedDB: { open(name: string, version: number): IdbRequest<IdbDatabase> };

export function idbStorage(name = "httpeers-hub", store = "state"): KeyValueStorage {
  const open = (): Promise<IdbDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const run = async <T>(
    mode: "readonly" | "readwrite",
    act: (s: IdbStore) => IdbRequest<unknown>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = act(db.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  return {
    get: (key) => run<string | undefined>("readonly", (s) => s.get(key)),
    set: async (key, value) => {
      await run("readwrite", (s) => s.put(value, key));
    },
    delete: async (key) => {
      await run("readwrite", (s) => s.delete(key));
    },
  };
}

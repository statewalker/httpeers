/**
 * The IndexedDB implementations of `ConfigStore` and `SessionStore`.
 *
 * One database, two object stores: `config`, keyed by page profile ("standalone", "mesh"), and
 * `sessions`, keyed by id and shared by every page on the origin. The factory is a parameter so
 * tests run under Node against `fake-indexeddb`.
 */

import type { ChatConfig, ConfigStore } from "./config.js";
import {
  applyPatch,
  byRecency,
  newSession,
  type Session,
  SessionNotFoundError,
  type SessionStore,
  type StoreClock,
  storeClock,
  summaryOf,
} from "./sessions.js";

export const DB_NAME = "llm-chat";
const DB_VERSION = 1;
const CONFIG = "config";
const SESSIONS = "sessions";

export interface IdbOptions {
  factory?: IDBFactory;
  dbName?: string;
}

function openDb({
  factory = globalThis.indexedDB,
  dbName = DB_NAME,
}: IdbOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONFIG)) db.createObjectStore(CONFIG);
      if (!db.objectStoreNames.contains(SESSIONS))
        db.createObjectStore(SESSIONS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function lazyDb(options: IdbOptions): () => Promise<IDBDatabase> {
  let db: Promise<IDBDatabase> | undefined;
  return () => {
    db ??= openDb(options);
    return db;
  };
}

/** One request in its own transaction; resolves when the transaction commits. */
function run<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  op: (objects: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = op(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function idbConfigStore(profile: string, options: IdbOptions = {}): ConfigStore {
  const db = lazyDb(options);
  return {
    async get() {
      const found = await run<ChatConfig | undefined>(await db(), CONFIG, "readonly", (s) =>
        s.get(profile),
      );
      return found ?? null;
    },
    async set(config) {
      await run(await db(), CONFIG, "readwrite", (s) => s.put(config, profile));
    },
    async clear() {
      await run(await db(), CONFIG, "readwrite", (s) => s.delete(profile));
    },
  };
}

export function idbSessionStore(options: IdbOptions & StoreClock = {}): SessionStore {
  const db = lazyDb(options);
  const time = storeClock(options);
  return {
    async list() {
      const all = await run<Session[]>(await db(), SESSIONS, "readonly", (s) => s.getAll());
      return all.map(summaryOf).sort(byRecency);
    },
    async get(id) {
      const found = await run<Session | undefined>(await db(), SESSIONS, "readonly", (s) =>
        s.get(id),
      );
      return found ?? null;
    },
    async create(init = {}) {
      const session = newSession(init, time);
      await run(await db(), SESSIONS, "readwrite", (s) => s.add(session));
      return session;
    },
    async update(id, patch) {
      const conn = await db();
      // Read and write in ONE transaction, so two updates cannot interleave.
      return new Promise<Session>((resolve, reject) => {
        const tx = conn.transaction(SESSIONS, "readwrite");
        const objects = tx.objectStore(SESSIONS);
        let next: Session | undefined;
        const read = objects.get(id);
        read.onsuccess = () => {
          const current = read.result as Session | undefined;
          if (current == null) return;
          next = applyPatch(current, patch, time.now());
          objects.put(next);
        };
        tx.oncomplete = () => {
          if (next == null) reject(new SessionNotFoundError(id));
          else resolve(next);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async delete(id) {
      await run(await db(), SESSIONS, "readwrite", (s) => s.delete(id));
    },
  };
}

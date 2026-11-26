/**
 * The member's two IndexedDB stores, over `idb-keyval`'s default database (the
 * one `@statewalker/webrun-http-browser` already uses). Shared by `./browser`
 * and `./extension`, and reaching no ServiceWorker adapter.
 */

import { del, get, set } from "idb-keyval";
import type { AsyncBytesBackend, AsyncKeyValueBackend } from "./kv.js";

/** The real thing: the same IndexedDB store `@statewalker/webrun-http-browser` already uses. */
export function idbBackend(): AsyncKeyValueBackend {
  return {
    get: async (key) => (await get<string>(key)) ?? undefined,
    set: async (key, value) => await set(key, value),
    delete: async (key) => await del(key),
  };
}

export function idbBytesBackend(): AsyncBytesBackend {
  return {
    get: async (key) => (await get<Uint8Array>(key)) ?? undefined,
    set: async (key, value) => await set(key, value),
    delete: async (key) => await del(key),
  };
}

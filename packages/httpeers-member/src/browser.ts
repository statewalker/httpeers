/**
 * The browser half of a member's storage.
 *
 * `idb-keyval` needs a real IndexedDB, so importing it from the root would put
 * a browser database in a Node member's bundle. The interfaces live in
 * `./kv.js`; these are the implementations of them that only a page can run.
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

/**
 * The BROWSER half of a member: the platform object, the two IndexedDB
 * stores, and one function that assembles a page session out of them.
 *
 * EVERYTHING BROWSER-BOUND IS BEHIND THIS ENTRY, and that is a load-bearing
 * arrangement rather than tidiness. `idb-keyval` needs a real IndexedDB;
 * `@libp2p/webrtc`'s Node build loads a native module and throws on import;
 * `@statewalker/webrun-http-browser/sw` is a ServiceWorker adapter. Any of
 * them reachable from `./index.ts` would make a Node member fail at import
 * time, which `tests/boundary.test.ts` now measures by reachability.
 *
 * `createSession` IS THE ONLY THING HERE THAT IS NOT A RE-EXPORT. It is the
 * defaults `session.ts` deliberately does not carry: the platform, the two
 * stores, `location.search` and the reload. A page that wants to substitute
 * any of them passes it and this steps aside.
 */

import { del, get, set } from "idb-keyval";
import { browserPlatform } from "./browser-platform.js";
import type { AsyncBytesBackend, AsyncKeyValueBackend } from "./kv.js";
import { createMeshMemory } from "./mesh-memory.js";
import type { PeerSession, PeerSessionInit } from "./session.js";
import { createIdentityStore, createPeerSession } from "./session.js";

export { type BrowserPlatformInit, browserPlatform } from "./browser-platform.js";
export {
  type CreateBrowserNodeInit,
  createBrowserNode,
  dialNeedsPermissiveGater,
} from "./browser-profile.js";
export { DEFAULT_SERVICE_WORKER_URL, type MountEdgeInit, mountEdge } from "./edge.js";
export {
  type WakeDocument,
  type WakeWindow,
  type WatchPageWakeInit,
  watchPageWake,
} from "./page-wake.js";

// THE SESSION ITSELF IS NOT RE-EXPORTED HERE. It is isomorphic and lives at
// the root, and two import paths to one symbol is how a package ends up with
// two versions of a type that look identical and are not.

/** The page's own globals, declared locally — see `./page-wake.ts` for why not `lib: dom`. */
declare const location: { search: string; reload(): void };

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

/**
 * `PeerSessionInit` with every browser-supplied part made optional.
 *
 * The four that become optional are exactly the four `session.ts` refuses to
 * default, and they are listed there with the reason. `serviceWorkerUrl` and
 * `dev` are here rather than there because they are `browserPlatform`'s
 * arguments, and a page that passes its own `platform` has no use for them.
 */
export interface CreateSessionInit
  extends Omit<PeerSessionInit, "platform" | "identity" | "meshMemory" | "reload" | "search"> {
  platform?: PeerSessionInit["platform"];
  identity?: PeerSessionInit["identity"];
  meshMemory?: PeerSessionInit["meshMemory"];
  reload?: () => void;
  /** Defaults to `location.search`, read once at `start()`. */
  search?: string;
  /** Where the ServiceWorker script lives — see `mountEdge`. */
  serviceWorkerUrl?: string;
  /** Relax libp2p's dial gater for loopback and private addresses. Off in production. */
  dev?: boolean;
}

export function createSession(init: CreateSessionInit): PeerSession {
  return createPeerSession({
    ...init,
    search: init.search ?? location.search,
    platform:
      init.platform ??
      browserPlatform({ serviceWorkerUrl: init.serviceWorkerUrl, dev: init.dev ?? false }),
    identity: init.identity ?? createIdentityStore({ backend: idbBytesBackend() }),
    meshMemory: init.meshMemory ?? createMeshMemory({ backend: idbBackend() }),
    reload: init.reload ?? ((): void => location.reload()),
  });
}
export { type ResetResult, resetBrowserState } from "./reset.js";

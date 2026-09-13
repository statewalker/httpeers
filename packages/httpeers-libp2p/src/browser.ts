/**
 * The browser profile.
 *
 * A page cannot listen and cannot open a TCP socket. It reaches the mesh by
 * reserving on a relay and being dialled back through the circuit, so its
 * transports are the three that make that work:
 *
 *   webSockets          — to reach the relay itself, which does listen.
 *   circuitRelayTransport — to be dialled through that reservation.
 *   webRTC              — so that once two members have exchanged an offer
 *                         over the circuit, the data goes directly and the
 *                         hub stays a signalling channel.
 *
 * `tcp()` is absent because it cannot exist here, which is the whole reason
 * this file is separate from `./node`.
 */

import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import type { BytesStore } from "./identity.js";
import type { TransportFactory } from "./transport.js";

/**
 * The slice of IndexedDB this file uses, declared MODULE-LOCALLY.
 *
 * The DOM lib is deliberately absent from this package — including it is how a
 * DOM-only global gets blessed by the compiler and is not noticed until the
 * code reaches a worker — and declaring these globally would collide with the
 * real ones for every consumer who does have them. Only what is called is
 * described; a fuller copy would be a second source of truth to drift.
 */
type IdbRequest<T> = {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};
type IdbStore = {
  get(key: string): IdbRequest<ArrayBuffer | Uint8Array | undefined>;
  put(value: Uint8Array, key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
};
type IdbDatabase = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): { objectStore(name: string): IdbStore };
  close(): void;
};
declare const indexedDB: { open(name: string, version: number): IdbRequest<IdbDatabase> };

/** Transports for a page. Fresh instances per call — libp2p's are not reusable. */
export function browserTransports(): TransportFactory[] {
  return [
    webSockets() as unknown as TransportFactory,
    circuitRelayTransport() as unknown as TransportFactory,
    webRTC() as unknown as TransportFactory,
  ];
}

/**
 * A `BytesStore` in IndexedDB — where a page keeps its identity.
 *
 * NOT `localStorage`, and the difference matters: a key is bytes, and
 * `localStorage` stores strings, so every read and write would go through a
 * base64 round trip that can silently truncate. IndexedDB stores a
 * `Uint8Array` as itself.
 *
 * Written against the raw IndexedDB API rather than a wrapper so this package
 * keeps its single dependency. It is thirty lines and it never changes.
 */
export function idbBytesStore(name = "httpeers", store = "identity"): BytesStore {
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
    async get(key) {
      const value = await run<ArrayBuffer | Uint8Array | undefined>("readonly", (s) => s.get(key));
      if (value === undefined) return undefined;
      return value instanceof Uint8Array ? value : new Uint8Array(value);
    },
    async set(key, value) {
      await run("readwrite", (s) => s.put(value, key));
    },
    async delete(key) {
      await run("readwrite", (s) => s.delete(key));
    },
  };
}

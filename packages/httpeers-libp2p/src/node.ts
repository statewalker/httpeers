/**
 * The Node profile. Everything here is why the root export is not this.
 *
 * `tcp()` cannot run in a browser, and the prototype hard-coded it inside its
 * node factory — so importing the transport module at all dragged a Node-only
 * transport into a browser bundle, in a package whose whole claim is that one
 * implementation runs on both. Separating the profiles is the fix, and the
 * root's boundary test asserts `@libp2p/tcp` never appears there.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tcp } from "@libp2p/tcp";
import type { BytesStore } from "./identity.js";
import type { TransportFactory } from "./transport.js";

/**
 * Transports for a server: TCP, and nothing a page could not also do.
 *
 * Listed as a function rather than a constant so a caller gets fresh factory
 * instances — libp2p's are not reusable across nodes.
 */
export function nodeTransports(): TransportFactory[] {
  return [tcp() as unknown as TransportFactory];
}

/**
 * A `BytesStore` on the filesystem — where a server keeps its identity.
 *
 * WRITE-THEN-MOVE, not write-in-place. A key file truncated by a crash
 * mid-write is not a corrupt file you notice, it is a mesh that silently
 * re-founds itself on the next start: `identityStore.loadOrCreate` sees
 * unreadable bytes, generates a new key, and every token the old identity
 * issued stops verifying. A rename is atomic on POSIX, so the file is either
 * the old key or the new one and never half of either.
 *
 * The prototype's snapshot store wrote in place; extraction prototype 04
 * measured the consequence and this is the shape that survived it.
 */
export function fileBytesStore(dir: string): BytesStore {
  return {
    async get(key) {
      try {
        return new Uint8Array(await readFile(join(dir, key)));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      const target = join(dir, key);
      // Same directory, so the rename cannot cross a filesystem boundary —
      // which is the one case where it would stop being atomic.
      const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(staging, value, { mode: 0o600 });
      await rename(staging, target);
    },
    async delete(key) {
      await rm(join(dir, key), { force: true });
    },
  };
}

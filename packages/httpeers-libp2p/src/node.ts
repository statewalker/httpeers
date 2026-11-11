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
import { createRequire } from "node:module";
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

/**
 * The oldest libdatachannel a Node peer's WebRTC dial is safe with: 0.24.6,
 * bundled by node-datachannel from 0.33.6.
 *
 * libdatachannel <= 0.24.5 could lose a race on the OFFERER: the remote answer
 * reached the ICE agent before its fingerprint was committed, so DTLS could
 * start with nothing to verify against (`DTLS alert: unknown CA`) and the dial
 * timed out. A busy CPU made it common. Fixed upstream by libdatachannel
 * 0235225 ("start DTLS after remote description"). httpeers dials WebRTC once
 * and relies on the fix; it used to retry every dial for it.
 */
export const LIBDATACHANNEL_MIN_VERSION = "0.24.6";

/**
 * Whether dotted version `version` is `min` or newer, compared numerically
 * part by part (`0.24.10` > `0.24.6`). A missing part counts as 0; a part that
 * is not a number makes the answer `false`. A pre-release suffix is ignored.
 */
export function versionAtLeast(version: string, min: string): boolean {
  const have = version.trim().replace(/^v/, "").split(/[-+]/)[0]?.split(".") ?? [];
  const want = min.split(".");
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const h = Number(have[i] ?? "0");
    const w = Number(want[i] ?? "0");
    if (!Number.isInteger(h) || !Number.isInteger(w)) return false;
    if (h !== w) return h > w;
  }
  return true;
}

/**
 * The warning `warnIfOldLibdatachannel` prints for a loaded libdatachannel
 * `version`, or `undefined` when that version has the DTLS fix.
 */
export function libdatachannelWarning(version: string): string | undefined {
  if (versionAtLeast(version, LIBDATACHANNEL_MIN_VERSION)) return undefined;
  return (
    `httpeers: node-datachannel bundles libdatachannel ${version}; ` +
    `${LIBDATACHANNEL_MIN_VERSION} or newer (node-datachannel >= 0.33.6) is needed. ` +
    "Older releases lose a DTLS startup race when dialling WebRTC, and the dial fails, " +
    "often under CPU load. Upgrade node-datachannel (a pnpm override if your lockfile pins an older one)."
  );
}

/**
 * The libdatachannel version that `@libp2p/webrtc` loads, read through
 * node-datachannel's `getLibraryVersion()`. Resolved FROM `@libp2p/webrtc`,
 * because that copy is the one that dials; this package's own copy is only a
 * fallback, for a tree where `@libp2p/webrtc` cannot be resolved from here.
 * Throws when node-datachannel cannot be loaded.
 */
export function loadedLibdatachannelVersion(): string {
  let load = createRequire(import.meta.url);
  try {
    load = createRequire(import.meta.resolve("@libp2p/webrtc"));
  } catch {
    // Keep this package's own resolution.
  }
  const nodeDatachannel = load("node-datachannel") as { getLibraryVersion(): string };
  return nodeDatachannel.getLibraryVersion();
}

let libdatachannelChecked = false;

/**
 * Once per process, `console.warn` if the libdatachannel `@libp2p/webrtc`
 * loads is older than `LIBDATACHANNEL_MIN_VERSION`. Call it where a Node
 * process builds `webRTC()`.
 *
 * NEVER THROWS, and stays quiet when node-datachannel cannot be loaded at
 * all: `webRTC()` reports that itself, and a peer that never dials WebRTC
 * should not fail over a diagnostic. Cheap: node-datachannel is the module
 * `@libp2p/webrtc` loads anyway, so after the first call this is a flag check.
 * Node only (this module is `./node`); a browser's WebRTC is its own and has
 * no such race.
 */
export function warnIfOldLibdatachannel(): void {
  if (libdatachannelChecked) return;
  libdatachannelChecked = true;
  let warning: string | undefined;
  try {
    warning = libdatachannelWarning(loadedLibdatachannelVersion());
  } catch {
    return;
  }
  if (warning != null) console.warn(warning);
}

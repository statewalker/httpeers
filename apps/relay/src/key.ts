/**
 * The relay's signing key -- which is its identity, which is embedded in
 * every multiaddr any peer will ever dial.
 *
 * IDENTITY IS NEVER GENERATED IMPLICITLY. A relay's peerId appears inside
 * `.../p2p/<relayPeerId>/...` in the invitation payload every client holds.
 * A freshly generated key on restart would invalidate every one of those
 * configurations at once, and the symptom -- peers failing to connect --
 * points nowhere near the relay's key handling. So a missing key is a loud
 * failure, never a silent regeneration. `generate()` exists, but only
 * `bootstrap.ts` calls it, and only when a human ran it.
 *
 * TWO NEW CONSTRAINTS THE CONTAINER ADDS, neither of which applied when this
 * ran from a working copy:
 *
 *   1. The key must never be in the image. `statewalker/httpeers` is public
 *      and images are pullable by anyone.
 *   2. The key must survive `docker compose up` replacing the container. It
 *      lives on a named volume; a key written to the container filesystem is
 *      a key that silently changes identity on the next deploy.
 *
 * `RELAY_KEY` (base64 of the same protobuf) exists for reproducible
 * bootstrap -- seeding a fresh volume without an interactive step. It is
 * consumed ONCE: if the key file already exists it is ignored entirely
 * rather than compared or overwritten, so a stale value left in an `.env`
 * can never silently replace a working identity.
 *
 * KEY FILE FORMAT: the protobuf encoding `@libp2p/crypto/keys`'
 * `privateKeyToProtobuf` / `privateKeyFromProtobuf` round-trip through,
 * written as raw bytes. libp2p's own idiomatic on-disk format, and the one
 * the httpeers-stack relay already used -- an existing `.httpeers/relay.key`
 * is readable by this loader unchanged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";

/** Where the container's named volume is mounted. Overridden by `RELAY_KEY_PATH`. */
export const DEFAULT_RELAY_KEY_PATH = "./.httpeers/relay.key";

/**
 * Thrown when no key exists and none was supplied. Distinct from a decode
 * failure so the entrypoint can print recovery guidance for the one case
 * where guidance helps.
 */
export class MissingRelayKeyError extends Error {
  constructor(readonly keyPath: string) {
    super(
      `relay: no signing key found at "${keyPath}".\n` +
        "relay: this relay's peerId is embedded in every multiaddr peers dial, so it refuses\n" +
        "relay: to start with a freshly generated key -- an ephemeral identity would invalidate\n" +
        "relay: every client's configuration on each restart.\n" +
        "relay: seed it with one of:\n" +
        "relay:   pnpm --filter @statewalker/httpeers-relay bootstrap   (writes a new key)\n" +
        "relay:   RELAY_KEY=<base64 protobuf>                           (seeds from an existing one)",
    );
    this.name = "MissingRelayKeyError";
  }
}

function decode(bytes: Uint8Array, source: string): Ed25519PrivateKey {
  const key = privateKeyFromProtobuf(bytes);
  if (key.type !== "Ed25519") {
    throw new Error(
      `relay: key from ${source} is a ${key.type} key -- only Ed25519 is supported, ` +
        "because a peerId used as a mesh identity must be a verifying key.",
    );
  }
  return key;
}

/** Reads an existing key. Throws `MissingRelayKeyError` if absent. */
export function loadRelayKey(keyPath: string = DEFAULT_RELAY_KEY_PATH): Ed25519PrivateKey {
  if (!existsSync(keyPath)) throw new MissingRelayKeyError(keyPath);
  return decode(readFileSync(keyPath), `"${keyPath}"`);
}

/** Writes `key` to `keyPath`, creating the directory. Used by seeding and by bootstrap. */
export function writeRelayKey(keyPath: string, key: Ed25519PrivateKey): void {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKeyToProtobuf(key), { mode: 0o600 });
}

/**
 * Generates a new identity and writes it. Only `bootstrap.ts` calls this.
 *
 * Async because `generateKeyPair` is -- the resolution and the encoding
 * functions beside it are not, which is an easy asymmetry to miss.
 */
export async function generateRelayKey(
  keyPath: string = DEFAULT_RELAY_KEY_PATH,
): Promise<Ed25519PrivateKey> {
  const key = await generateKeyPair("Ed25519");
  writeRelayKey(keyPath, key);
  return key;
}

export interface ResolveRelayKeyInit {
  keyPath?: string;
  /** `RELAY_KEY` -- base64 of the protobuf encoding. Consumed only when no key file exists. */
  seedBase64?: string;
}

/**
 * The startup path: an existing key wins, a seed is used only to create one,
 * and absence is an error.
 *
 * The precedence is deliberate and is the reason this is not a one-liner. If
 * the seed won, a stale `RELAY_KEY` in a server `.env` would silently replace
 * a working identity on the next deploy -- the exact failure the whole module
 * exists to prevent, reintroduced through the mechanism meant to make
 * bootstrap easy.
 */
export function resolveRelayKey(init: ResolveRelayKeyInit = {}): Ed25519PrivateKey {
  const keyPath = init.keyPath ?? DEFAULT_RELAY_KEY_PATH;
  if (existsSync(keyPath)) return decode(readFileSync(keyPath), `"${keyPath}"`);

  const seed = init.seedBase64?.trim();
  if (seed != null && seed.length > 0) {
    const key = decode(Buffer.from(seed, "base64"), "RELAY_KEY");
    writeRelayKey(keyPath, key);
    return key;
  }
  throw new MissingRelayKeyError(keyPath);
}

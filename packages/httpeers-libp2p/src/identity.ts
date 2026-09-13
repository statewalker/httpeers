/**
 * Identity, before a node exists.
 *
 * WHY THIS IS ITS OWN MODULE. Every process and every page in the mesh needs a
 * peerId *before* it can start a node: a hub's peerId is the mesh identity that
 * every token's `mesh` claim restates, a relay's is baked into the multiaddr
 * its members dial, and a member's is what the hub records. The prototype's
 * three assemblies each derived one their own way, and revision 1 of the
 * extraction exported none of it.
 *
 * ED25519 ONLY, and never branching on key type. The reason is the one
 * `httpeers-access` is built on: an Ed25519 peerId inlines its own public key,
 * so verification never needs a fetch. A key of any other type would produce a
 * peerId that cannot self-certify, and every token issued under it would be
 * unverifiable — so `decodeKey` refuses one rather than carrying it forward.
 *
 * IDEMPOTENCE IS THE WHOLE POINT of `identityStore`. A store that quietly
 * re-generated a key on a second read would silently re-found the mesh: every
 * token already issued stops verifying, every policy naming the issuer goes
 * stale, and nothing reports an error. There is no path in `loadOrCreate` that
 * writes when a key is already present.
 */

import {
  generateKeyPair,
  generateKeyPairFromSeed,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "@libp2p/interface";
import { peerIdFromPrivateKey, peerIdFromPublicKey } from "@libp2p/peer-id";
import type { PeerIdStr } from "@statewalker/httpeers-core";

/** `generateKeyPairFromSeed("Ed25519", seed)` requires exactly this many bytes. */
const SEED_BYTES = 32;

export interface GenerateKeyInit {
  /**
   * Derive the key deterministically instead of drawing from the CSPRNG, so a
   * test or a CI run can name a peerId as a constant. Exactly 32 bytes.
   */
  seed?: Uint8Array;
}

export async function generateKey(init: GenerateKeyInit = {}): Promise<Ed25519PrivateKey> {
  if (init.seed === undefined) return generateKeyPair("Ed25519");
  if (init.seed.length !== SEED_BYTES) {
    throw new TypeError(
      `generateKey: a seed must be exactly ${SEED_BYTES} bytes, got ${init.seed.length}. ` +
        "Hash a passphrase to 32 bytes rather than passing it directly.",
    );
  }
  return generateKeyPairFromSeed("Ed25519", init.seed);
}

/** The peerId a key identifies as — the mesh id, for a hub's key. */
export function peerIdOf(key: Ed25519PrivateKey | Ed25519PublicKey): PeerIdStr {
  return key.type === "Ed25519" && "publicKey" in key
    ? peerIdFromPrivateKey(key).toString()
    : peerIdFromPublicKey(key as Ed25519PublicKey).toString();
}

/**
 * The libp2p protobuf encoding — the format both platforms already persist and
 * the relay already reads back. Not a format chosen here; see the prototype's
 * `setup/keys.ts` for the contract it exists to satisfy.
 */
export function encodeKey(key: Ed25519PrivateKey): Uint8Array {
  return privateKeyToProtobuf(key);
}

/** Decode a stored key, refusing anything that is not Ed25519 **and saying what it was**. */
export function decodeKey(bytes: Uint8Array): Ed25519PrivateKey {
  const key = privateKeyFromProtobuf(bytes);
  if (key.type !== "Ed25519") {
    throw new TypeError(
      `decodeKey: expected an Ed25519 key, got ${key.type}. Only Ed25519 peerIds carry their ` +
        "own public key, which is what lets a token be verified without fetching anything.",
    );
  }
  return key;
}

/**
 * The bridge to `@statewalker/httpeers-access`.
 *
 * Declared STRUCTURALLY rather than imported, so this package does not depend
 * on `httpeers-access` — the dependency graph runs core → access and
 * core → libp2p, and the two never point at each other. The shape is
 * `access`'s `Signer`, and a mismatch would be a compile error at whichever
 * assembly wires them together, which is where it belongs.
 */
export interface SignerLike {
  readonly mesh: string;
  readonly seed: Uint8Array;
}

/**
 * A key, as something that can mint.
 *
 * A libp2p Ed25519 private key's `raw` is the 64-byte expanded form — the
 * 32-byte seed followed by the public key — and Biscuit signs from the seed
 * alone.
 */
export function signerOf(key: Ed25519PrivateKey): SignerLike {
  return { mesh: peerIdOf(key), seed: key.raw.slice(0, SEED_BYTES) };
}

/** Somewhere bytes live. A file on a server, IndexedDB in a page. */
export interface BytesStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IdentityStoreInit {
  backend: BytesStore;
  /** Which entry in the backend holds it. Defaults to `"identity"`. */
  key?: string;
}

export interface IdentityStore {
  /** The stored key, or `null`. Never generates. */
  read(): Promise<Ed25519PrivateKey | null>;
  /** The stored key, generating and persisting one only if there is none. */
  loadOrCreate(): Promise<Ed25519PrivateKey>;
  /** Forget it. The next `loadOrCreate` founds a NEW identity — see the module comment. */
  clear(): Promise<void>;
}

export function identityStore(init: IdentityStoreInit): IdentityStore {
  const entry = init.key ?? "identity";

  const read = async (): Promise<Ed25519PrivateKey | null> => {
    const bytes = await init.backend.get(entry);
    return bytes === undefined ? null : decodeKey(bytes);
  };

  return {
    read,
    async loadOrCreate() {
      const existing = await read();
      // The whole point: a key that exists is READ, never regenerated and
      // never overwritten. There is no write on this branch.
      if (existing !== null) return existing;

      const created = await generateKey();
      await init.backend.set(entry, encodeKey(created));
      return created;
    },
    async clear() {
      await init.backend.delete(entry);
    },
  };
}

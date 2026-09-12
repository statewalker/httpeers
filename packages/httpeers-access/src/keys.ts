/**
 * Where a mesh's verifying key comes from — and why it is not a dependency.
 *
 * THE FACT THE WHOLE EXTRACTION RESTS ON. An Ed25519 peerId *carries its own
 * public key*. The string is base58btc of an identity multihash whose digest
 * is a protobuf-encoded `PublicKey { Type: Ed25519, Data: <32 bytes> }`:
 *
 *     base58btc( 0x00 0x24 | 0x08 0x01 | 0x12 0x20 | <32 key bytes> )
 *                 ^    ^      ^    ^      ^    ^
 *                 |    |      |    |      |    └─ 32 bytes follow
 *                 |    |      |    |      └────── field 2 (Data), length-delimited
 *                 |    |      |    └───────────── value 1 = Ed25519
 *                 |    |      └────────────────── field 1 (Type), varint
 *                 |    └───────────────────────── digest length, 36
 *                 └────────────────────────────── multihash code 0x00, "identity"
 *
 * "Identity" means the digest is not a hash at all — it is the value itself.
 * So recovering the key is parsing, not fetching, and the prototype's
 * `peerIdFromString(issuer).publicKey.raw` was pulling in `@libp2p/peer-id`,
 * `@libp2p/crypto` and their graph to do twenty lines of decoding.
 *
 * This is NOT true of every peerId. An RSA peerId is a SHA-256 multihash *of*
 * the key, so there is nothing to recover and `resolve` returns empty — a
 * distinction worth stating, because treating that digest's tail as a public
 * key would silently produce a wrong one.
 *
 * `tests/self-certifying.test.ts` checks this against libp2p's own answer over
 * real generated peers rather than against a fixture, because a fixture agrees
 * with the implementation's mistakes.
 */

import { base58btc } from "multiformats/bases/base58";
import type { MeshId } from "./types.js";

/** Multihash code 0x00: the digest is the value, not a hash of it. */
const IDENTITY_CODE = 0x00;
/** `0x08 0x01` — protobuf field 1 (Type), varint, value 1 (Ed25519). */
const PB_TYPE_ED25519 = [0x08, 0x01] as const;
/** `0x12 0x20` — protobuf field 2 (Data), length-delimited, 32 bytes. */
const PB_DATA_32 = [0x12, 0x20] as const;
const ED25519_KEY_BYTES = 32;
/** type(2) + data header(2) + key(32) */
const PB_LENGTH = PB_TYPE_ED25519.length + PB_DATA_32.length + ED25519_KEY_BYTES;

/**
 * Where the verifying keys for a mesh come from.
 *
 * **Empty means deny.** An implementation that cannot resolve a mesh returns
 * no keys; it does not throw. A throw would turn an unknown issuer into a 500
 * where the contract wants a refusal, and the difference is visible to whoever
 * is probing.
 */
export interface IssuerKeys {
  resolve(mesh: MeshId): Promise<readonly Uint8Array[]>;
}

/**
 * The default: a peerId is its own key, so nothing is fetched and nothing is
 * configured. Reproduces the prototype's behaviour exactly.
 */
export function selfCertifyingKeys(): IssuerKeys {
  return {
    async resolve(mesh: MeshId): Promise<readonly Uint8Array[]> {
      const key = publicKeyOf(mesh);
      return key == null ? [] : [key];
    },
  };
}

/**
 * The raw Ed25519 public key inside a peerId, or `null` if there is not one.
 *
 * Separate from `resolve` so the failure can be inspected without the
 * deny-list contract getting in the way — see `describeMeshId`.
 */
export function publicKeyOf(mesh: MeshId): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    // A peerId string is base58btc WITHOUT its multibase prefix, so the `z`
    // this decoder expects has to be put back.
    bytes = base58btc.decode(`z${mesh}`);
  } catch {
    return null;
  }

  if (bytes.length !== 2 + PB_LENGTH) return null;
  if (bytes[0] !== IDENTITY_CODE) return null;
  if (bytes[1] !== PB_LENGTH) return null;

  const digest = bytes.subarray(2);
  if (digest[0] !== PB_TYPE_ED25519[0] || digest[1] !== PB_TYPE_ED25519[1]) return null;
  if (digest[2] !== PB_DATA_32[0] || digest[3] !== PB_DATA_32[1]) return null;

  return digest.slice(4);
}

/**
 * WHY a mesh id yields no key — as a value, not prose.
 *
 * `publicKeyOf` returns `null` for every kind of failure, which is right for a
 * deny list and wrong for a caller that has to report one. The token verifier
 * distinguishes `unparseable-issuer` from `issuer-not-ed25519`, and collapsing
 * them told an operator "that is not a peerId" about a peerId that was
 * perfectly valid and merely RSA. The ported token suite caught it.
 */
export type MeshIdProblem =
  /** Not base58btc, or not a multihash at all. */
  | "unparseable"
  /** A well-formed peerId that does not carry an inline Ed25519 key. */
  | "not-ed25519";

export function meshIdProblem(mesh: MeshId): MeshIdProblem | null {
  let bytes: Uint8Array;
  try {
    bytes = base58btc.decode(`z${mesh}`);
  } catch {
    return "unparseable";
  }

  // A multihash, properly: varint code, varint length, then exactly that many
  // bytes. Checking the SHAPE rather than just the first byte is what keeps
  // "a valid RSA peerId" apart from "a word that happens to be base58" —
  // "nonsense" decodes to bytes and would otherwise be reported as a peerId
  // carrying the wrong key type, which sends a reader somewhere useless.
  const header = readMultihashHeader(bytes);
  if (header == null) return "unparseable";

  // Past this point the string IS a well-formed multihash, so it is a peerId
  // shape; it simply may not be one that carries its key.
  if (header.code !== IDENTITY_CODE) return "not-ed25519";
  if (header.digest.length !== PB_LENGTH) return "not-ed25519";
  const digest = header.digest;
  if (digest[0] !== PB_TYPE_ED25519[0] || digest[1] !== PB_TYPE_ED25519[1]) return "not-ed25519";
  if (digest[2] !== PB_DATA_32[0] || digest[3] !== PB_DATA_32[1]) return "not-ed25519";
  return null;
}

/** `<varint code><varint length><digest>`, or `null` if the bytes are not that. */
function readMultihashHeader(bytes: Uint8Array): { code: number; digest: Uint8Array } | null {
  const code = readVarint(bytes, 0);
  if (code == null) return null;
  const length = readVarint(bytes, code.next);
  if (length == null) return null;
  const digest = bytes.subarray(length.next);
  // The length must describe the rest EXACTLY — trailing bytes mean this was
  // never a multihash, it was something else that decoded.
  if (digest.length !== length.value) return null;
  return { code: code.value, digest };
}

/** Unsigned LEB128, bounded to five bytes — enough for any multihash code. */
function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: at + i + 1 };
  }
  return null;
}

/**
 * Why a mesh id was refused, in words. For a human debugging a configuration —
 * `resolve` stays silent because its contract is a deny list, but "denied" is
 * not a useful thing to read in a log at three in the morning.
 *
 * Built on {@link meshIdProblem} rather than re-deriving the checks, so the
 * prose and the value can never disagree about the same string.
 */
export function describeMeshId(mesh: MeshId): string {
  switch (meshIdProblem(mesh)) {
    case "unparseable":
      return `unparseable mesh id: ${JSON.stringify(mesh)} is not base58btc, or not a multihash`;
    case "not-ed25519":
      return (
        "mesh id is a peerId that does not carry an inline Ed25519 public key. " +
        "An RSA peerId hashes its key rather than carrying it, so there is no key to recover."
      );
    default:
      return "mesh id is a valid self-certifying Ed25519 peerId";
  }
}

/**
 * The inverse of {@link publicKeyOf}: the peerId string a raw Ed25519 public
 * key self-certifies as.
 *
 * Needed because a signer generated here has to be able to say which mesh it
 * is, and that identity must be the same string libp2p would produce for the
 * same key — `tests/signer.test.ts` asserts the round trip on real libp2p
 * peerIds, which is the property that makes this an inverse rather than a
 * lookalike.
 */
export function meshIdOf(publicKey: Uint8Array): MeshId {
  if (publicKey.length !== ED25519_KEY_BYTES) {
    throw new TypeError(
      `meshIdOf: an Ed25519 public key is ${ED25519_KEY_BYTES} bytes, got ${publicKey.length}`,
    );
  }
  const bytes = new Uint8Array(2 + PB_LENGTH);
  bytes[0] = IDENTITY_CODE;
  bytes[1] = PB_LENGTH;
  bytes.set(PB_TYPE_ED25519, 2);
  bytes.set(PB_DATA_32, 4);
  bytes.set(publicKey, 6);
  // `base58btc.encode` emits the multibase `z` prefix; a peerId string omits it.
  return base58btc.encode(bytes).slice(1);
}

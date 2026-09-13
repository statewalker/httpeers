/**
 * A mesh signing key, without libp2p.
 *
 * WHY A SEED AND NOT A `sign()` METHOD. Biscuit signs internally from raw key
 * bytes — it takes a `PrivateKey`, never a callback — so an interface offering
 * `sign(payload)` could not be implemented over it. The API sketch proposed
 * one; it is dropped rather than faked, and `Signer` carries the seed the
 * library actually needs.
 *
 * The consequence is worth stating plainly: a `Signer` is key material. It
 * cannot be backed by an HSM or a non-extractable WebCrypto key while Biscuit
 * wants bytes, and pretending otherwise with a wrapper would hide that.
 *
 * `generateSigner` exists so this package's own tests can mint without
 * reaching for `httpeers-libp2p` — which would reintroduce exactly the
 * dependency the package is defined by not having.
 */

import { meshIdOf } from "./keys.js";
import type { MeshId } from "./types.js";

export interface Signer {
  /** The mesh this key signs for — its own self-certifying peerId. */
  readonly mesh: MeshId;
  /** The 32-byte Ed25519 seed. Key material: treat it as such. */
  readonly seed: Uint8Array;
}

/**
 * PKCS#8 for an Ed25519 private key is a 16-byte header followed by the
 * 32-byte seed — `302e020100300506032b657004220420` then the seed. WebCrypto
 * offers no direct seed export, so the header is skipped rather than parsed:
 * the structure is fixed by RFC 8410 for this algorithm and the length is
 * asserted below, so a change in shape fails loudly instead of yielding a
 * plausible wrong key.
 */
const PKCS8_ED25519_LENGTH = 48;
const PKCS8_SEED_OFFSET = 16;

/**
 * The shape of what `generateKey` returns, named locally.
 *
 * `CryptoKeyPair` is declared by the DOM lib, which this package deliberately
 * does not include (see tsconfig) — and declaring it GLOBALLY here would
 * collide with the real one for every consumer who does have it. A local
 * structural type says exactly what is used and collides with nothing.
 */
interface KeyPairLike {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** A fresh mesh key. Uses WebCrypto, so it runs wherever this package does. */
export async function generateSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as KeyPairLike;

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  if (pkcs8.length !== PKCS8_ED25519_LENGTH) {
    throw new Error(
      `generateSigner: expected a ${PKCS8_ED25519_LENGTH}-byte PKCS#8 Ed25519 key, got ${pkcs8.length}`,
    );
  }
  const seed = pkcs8.slice(PKCS8_SEED_OFFSET);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

  return { mesh: meshIdOf(publicKey), seed };
}

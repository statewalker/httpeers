/**
 * A person key is the person's identity in a group. Unlike a device's peer
 * key, it is copied from device to device, so its private part is extractable
 * by design. Protecting it at rest is the caller's job (the browser's storage,
 * an optional password).
 */
import { fromBase64Url, toBase64Url } from "./encoding.js";

/** Base64url (no padding) of the raw 32-byte Ed25519 public key. */
export type PersonId = string;

export interface PersonKey {
  readonly id: PersonId;
  readonly publicKey: Uint8Array;
  readonly privateKey: CryptoKey;
}

// The DOM lib declares CryptoKeyPair; this package does not load the DOM lib.
interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const ED25519 = { name: "Ed25519" } as const;
const KEY_BYTES = 32;

export async function generatePersonKey(): Promise<PersonKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as KeyPair;
  const buffer = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const publicKey = new Uint8Array(buffer);
  return { id: toBase64Url(publicKey), publicKey, privateKey: pair.privateKey };
}

/** PKCS#8 bytes of the private key: what travels to a new device. */
export async function exportPersonKey(key: PersonKey): Promise<Uint8Array> {
  const buffer = (await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer;
  return new Uint8Array(buffer);
}

export async function importPersonKey(pkcs8: Uint8Array): Promise<PersonKey> {
  const buffer = pkcs8.buffer.slice(
    pkcs8.byteOffset,
    pkcs8.byteOffset + pkcs8.byteLength,
  ) as ArrayBuffer;
  const privateKey = await crypto.subtle.importKey("pkcs8", buffer, ED25519, true, ["sign"]);
  // WebCrypto has no "public key of this private key" call; the JWK export carries it as `x`.
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = jwk.x ? fromBase64Url(jwk.x) : undefined;
  if (!publicKey || publicKey.length !== KEY_BYTES) throw new Error("not an Ed25519 private key");
  return { id: toBase64Url(publicKey), publicKey, privateKey };
}

export function publicKeyOf(id: PersonId): Uint8Array | undefined {
  const bytes = fromBase64Url(id);
  // Only return bytes if they are 32 bytes long AND the canonical encoding matches the id.
  // This rejects non-canonical encodings that decode to the same bytes.
  return bytes && bytes.length === KEY_BYTES && toBase64Url(bytes) === id ? bytes : undefined;
}

export async function verifyingKeyOf(id: PersonId): Promise<CryptoKey | undefined> {
  const raw = publicKeyOf(id);
  if (!raw) return undefined;
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  return crypto.subtle.importKey("raw", buffer, ED25519, true, ["verify"]);
}

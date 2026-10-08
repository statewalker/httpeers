/**
 * The code both screens show during a link. The mover commits to its nonce
 * before it sees the keeper's, so nobody (the hub included) can steer the code
 * by choosing keys or nonces until it matches another screen.
 */
import { fromBase64Url, lengthPrefixed, toBase64Url } from "./encoding.js";

const NONCE_BYTES = 32;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

export function newNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

export async function commitment(nonce: string): Promise<string> {
  const bytes = fromBase64Url(nonce) ?? new Uint8Array();
  return toBase64Url(await sha256(lengthPrefixed(["sandclaw/link-commit/v1", bytes])));
}

export async function checkReveal(committed: string, nonce: string): Promise<boolean> {
  const bytes = fromBase64Url(nonce);
  if (!bytes || bytes.length !== NONCE_BYTES) return false;
  return (await commitment(nonce)) === committed;
}

export async function linkCode(input: {
  mesh: string;
  keeper: string;
  mover: string;
  keeperNonce: string;
  moverNonce: string;
}): Promise<string> {
  const digest = await sha256(
    lengthPrefixed([
      "sandclaw/link-code/v1",
      input.mesh,
      input.keeper,
      input.mover,
      fromBase64Url(input.keeperNonce) ?? new Uint8Array(),
      fromBase64Url(input.moverNonce) ?? new Uint8Array(),
    ]),
  );
  // The first 4 bytes as an unsigned integer, reduced to 6 digits. The modulo
  // bias (2^32 mod 10^6) is about 0.02% and does not help anyone steer the code.
  const value = new DataView(digest.buffer).getUint32(0) % 1_000_000;
  const digits = value.toString().padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

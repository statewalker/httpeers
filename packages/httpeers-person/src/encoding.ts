/**
 * Byte and text helpers shared by keys, statements and the link code.
 * No dependencies: atob/btoa and TextEncoder are WinterCG globals.
 */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url string, or `undefined` when it is not one. Never throws. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Each part as a 4-byte big-endian length followed by its bytes. Hashing a
 * plain concatenation would let ("ab","c") and ("a","bc") collide.
 */
export function lengthPrefixed(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? utf8(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const chunk of chunks) {
    view.setUint32(at, chunk.length);
    out.set(chunk, at + 4);
    at += 4 + chunk.length;
  }
  return out;
}

/**
 * The one byte form a statement is signed in: keys sorted by code unit, values
 * NFC-normalized, no whitespace. Two devices that type the same name with
 * different Unicode compositions sign the same bytes.
 */
export function canonicalJson(record: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = (record[key] ?? "").normalize("NFC");
  return JSON.stringify(sorted);
}

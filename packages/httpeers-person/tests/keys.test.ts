import { describe, expect, it } from "vitest";
import {
  exportPersonKey,
  generatePersonKey,
  importPersonKey,
  publicKeyOf,
  verifyingKeyOf,
} from "../src/keys.js";

describe("person keys", () => {
  it("names a person by their public key", async () => {
    const key = await generatePersonKey();
    expect(key.publicKey).toHaveLength(32);
    expect(publicKeyOf(key.id)).toEqual(key.publicKey);
  });

  it("survives export and import, the way it moves to another device", async () => {
    const key = await generatePersonKey();
    const copy = await importPersonKey(await exportPersonKey(key));
    expect(copy.id).toBe(key.id);
    const data = new TextEncoder().encode("hello");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, copy.privateKey, data);
    const verifier = await verifyingKeyOf(key.id);
    if (!verifier) throw new Error("verifier should be defined");
    expect(await crypto.subtle.verify({ name: "Ed25519" }, verifier, sig, data)).toBe(true);
  });

  it("rejects ids that are not 32-byte keys", async () => {
    const short = (await generatePersonKey()).id.slice(0, -2);
    expect(publicKeyOf(short)).toBeUndefined();
    expect(publicKeyOf("not base64url!")).toBeUndefined();
    expect(await verifyingKeyOf("")).toBeUndefined();
  });

  it("accepts only the canonical id of a key", async () => {
    const { id } = await generatePersonKey();
    // The last character of a 43-char id carries 2 spare bits; flipping one keeps the bytes.
    const last = id.at(-1) as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = id.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expect(publicKeyOf(twin)).toBeUndefined();
  });
});

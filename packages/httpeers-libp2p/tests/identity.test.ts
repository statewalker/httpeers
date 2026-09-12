/**
 * Identity, and the one property that ties this package to `httpeers-access`.
 *
 * `peerIdOf(key)` here and `meshIdOf(publicKeyOf(id))` there must agree, or a
 * hub mints tokens under one identity and verifiers expect another. The two
 * packages share no code — access deliberately has no libp2p — so nothing but
 * a test can hold them together, and the failure they would otherwise produce
 * is "the mesh stopped authenticating", far from either file.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { meshIdOf, publicKeyOf } from "@statewalker/httpeers-access";
import { describe, expect, it } from "vitest";
import {
  type BytesStore,
  decodeKey,
  encodeKey,
  generateKey,
  identityStore,
  peerIdOf,
  signerOf,
} from "../src/identity.js";

function memoryStore(): BytesStore & { readonly writes: number } {
  const map = new Map<string, Uint8Array>();
  let writes = 0;
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      writes += 1;
      map.set(k, v);
    },
    delete: async (k) => void map.delete(k),
    get writes() {
      return writes;
    },
  };
}

describe("keys", () => {
  it("peerIdOf agrees with libp2p", async () => {
    for (let i = 0; i < 10; i++) {
      const key = await generateKey();
      expect(peerIdOf(key)).toBe(peerIdFromPrivateKey(key).toString());
    }
  });

  it("AGREES WITH httpeers-access, which shares no code with this package", async () => {
    // The cross-package invariant. `access` recovers a key from a peerId with
    // multiformats and no libp2p; this derives a peerId from a key with libp2p
    // and no multiformats. They must describe the same identity.
    for (let i = 0; i < 10; i++) {
      const key = await generateKey();
      const id = peerIdOf(key);

      expect(meshIdOf(publicKeyOf(id) as Uint8Array)).toBe(id);
      expect(publicKeyOf(id)).toEqual(new Uint8Array(key.publicKey.raw));
    }
  });

  it("a seed makes it deterministic, across runs and platforms", async () => {
    const seed = new Uint8Array(32).fill(7);
    expect(peerIdOf(await generateKey({ seed }))).toBe(peerIdOf(await generateKey({ seed })));
  });

  it("refuses a seed of the wrong length, and says to hash instead", async () => {
    await expect(generateKey({ seed: new Uint8Array(16) })).rejects.toThrow(/32 bytes.*[Hh]ash/s);
  });

  it("encode/decode round-trips through the format the relay already reads", async () => {
    const key = await generateKey();
    expect(peerIdOf(decodeKey(encodeKey(key)))).toBe(peerIdOf(key));
  });

  it("decodeKey refuses a non-Ed25519 key, naming what it got", async () => {
    const rsa = await generateKeyPair("RSA", 2048);
    const { privateKeyToProtobuf } = await import("@libp2p/crypto/keys");
    expect(() => decodeKey(privateKeyToProtobuf(rsa))).toThrow(/got RSA/);
  }, 60_000);

  it("signerOf produces a signer whose mesh is the key's own peerId", async () => {
    const key = await generateKey();
    const signer = signerOf(key);
    expect(signer.mesh).toBe(peerIdOf(key));
    expect(signer.seed).toHaveLength(32);
    // The seed is the FIRST half of the expanded form, not the whole thing.
    expect(signer.seed).toEqual(key.raw.slice(0, 32));
  });
});

describe("identityStore", () => {
  it("generates once, then reads for ever", async () => {
    // IDEMPOTENCE IS THE WHOLE POINT. A second generation would silently
    // re-found the mesh: every token already issued stops verifying, and
    // nothing reports an error.
    const backend = memoryStore();
    const store = identityStore({ backend });

    const first = await store.loadOrCreate();
    const second = await store.loadOrCreate();
    const third = await store.loadOrCreate();

    expect(peerIdOf(second)).toBe(peerIdOf(first));
    expect(peerIdOf(third)).toBe(peerIdOf(first));
    expect(backend.writes).toBe(1);
  });

  it("read() never generates", async () => {
    const backend = memoryStore();
    const store = identityStore({ backend });

    expect(await store.read()).toBeNull();
    expect(backend.writes).toBe(0);
  });

  it("clear() means the next loadOrCreate founds a NEW identity", async () => {
    const backend = memoryStore();
    const store = identityStore({ backend });

    const before = peerIdOf(await store.loadOrCreate());
    await store.clear();
    const after = peerIdOf(await store.loadOrCreate());

    expect(after).not.toBe(before);
  });

  it("keeps separate entries apart", async () => {
    const backend = memoryStore();
    const hub = identityStore({ backend, key: "hub" });
    const relay = identityStore({ backend, key: "relay" });

    expect(peerIdOf(await hub.loadOrCreate())).not.toBe(peerIdOf(await relay.loadOrCreate()));
  });
});

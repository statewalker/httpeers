/**
 * A signer generated here must be indistinguishable from one libp2p made.
 *
 * `generateSigner` exists so this package can mint in its own tests without
 * depending on `httpeers-libp2p` — which would reintroduce precisely the
 * dependency the package is defined by not having. But a key that is *nearly*
 * right is worse than no key: it would mint tokens that verify here and
 * nowhere else, and the divergence would surface as "the mesh stopped
 * authenticating" long after this file.
 *
 * So the encoding is checked as an INVERSE on real libp2p peerIds, not on its
 * own output. `meshIdOf(publicKeyOf(id)) === id` for ids libp2p generated is a
 * statement about libp2p's encoding; `meshIdOf(publicKeyOf(x)) === x` for our
 * own output would only be a statement about our own.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { describe, expect, it } from "vitest";
import { meshIdOf, publicKeyOf, selfCertifyingKeys } from "../src/keys.js";
import { generateSigner } from "../src/signer.js";

describe("meshIdOf", () => {
  it("is the exact inverse of publicKeyOf on REAL libp2p peerIds", async () => {
    for (let i = 0; i < 25; i++) {
      const peerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
      const key = publicKeyOf(peerId);
      expect(key).not.toBeNull();
      expect(meshIdOf(key as Uint8Array)).toBe(peerId);
    }
  });

  it("refuses a key of the wrong length instead of encoding nonsense", () => {
    expect(() => meshIdOf(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => meshIdOf(new Uint8Array(64))).toThrow(/32 bytes/);
  });
});

describe("generateSigner", () => {
  it("produces a mesh id that resolves back to its own key", async () => {
    const signer = await generateSigner();

    expect(signer.seed).toHaveLength(32);
    const resolved = await selfCertifyingKeys().resolve(signer.mesh);
    expect(resolved).toHaveLength(1);
    expect(publicKeyOf(signer.mesh)).toEqual(resolved[0]);
  });

  it("produces a mesh id libp2p would also accept as a peerId", async () => {
    // The round trip through libp2p's own parser: if `meshIdOf` produced a
    // string libp2p could not read, every hub generated this way would be
    // unreachable by a real peer.
    const { peerIdFromString } = await import("@libp2p/peer-id");
    const signer = await generateSigner();

    const parsed = peerIdFromString(signer.mesh);

    expect(parsed.type).toBe("Ed25519");
    expect(new Uint8Array(parsed.publicKey?.raw as Uint8Array)).toEqual(
      publicKeyOf(signer.mesh) as Uint8Array,
    );
  });

  it("generates a different key each time", async () => {
    // Cheap, and catches the worst possible bug in a key generator.
    const a = await generateSigner();
    const b = await generateSigner();
    expect(a.mesh).not.toBe(b.mesh);
    expect(a.seed).not.toEqual(b.seed);
  });
});

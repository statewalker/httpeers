/**
 * `selfCertifyingKeys` must agree with libp2p, byte for byte.
 *
 * THIS IS THE ONE FILE IN THE PACKAGE THAT IMPORTS libp2p, and it does so on
 * purpose: agreeing with libp2p IS the claim. The whole extraction rests on a
 * single fact — an Ed25519 peerId carries its own public key, so recovering it
 * is local computation and never a dependency — and the only honest way to
 * check that recovery is to compare it against the library whose answer is
 * currently authoritative.
 *
 * A hand-written fixture would not do. A fixture is produced by the same
 * reasoning as the implementation, so it agrees with the implementation's bugs;
 * that is exactly how an encoding mistake survives review. Real generated
 * peers, compared against libp2p's own `publicKey.raw`, cannot.
 *
 * What is at stake if the two ever disagree: every token minted by a hub
 * verifies against that hub's peerId. A one-byte difference here does not
 * produce a wrong answer, it produces a mesh where nobody can authenticate —
 * and it would appear at a version bump, far from this file.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { describe, expect, it } from "vitest";
import { selfCertifyingKeys } from "../src/keys.js";

describe("selfCertifyingKeys", () => {
  it("recovers exactly the key libp2p does, for real generated peers", async () => {
    const keys = selfCertifyingKeys();
    // Many, not one: a single peerId can pass by coincidence of length or
    // padding, and base58 output varies in length with the leading bytes.
    for (let i = 0; i < 25; i++) {
      const priv = await generateKeyPair("Ed25519");
      const peerId = peerIdFromPrivateKey(priv);

      const resolved = await keys.resolve(peerId.toString());

      expect(resolved).toHaveLength(1);
      expect(new Uint8Array(resolved[0] as Uint8Array)).toEqual(
        new Uint8Array(peerId.publicKey.raw),
      );
    }
  });

  it("returns EMPTY, not a throw, for a mesh id it cannot resolve", async () => {
    // `IssuerKeys`'s contract is "empty ⇒ deny". A throw would turn an
    // unknown issuer into a 500 where the specification wants a refusal, and
    // the difference is visible to an attacker.
    const keys = selfCertifyingKeys();
    for (const notAPeerId of ["", "nonsense", "12D3KooW!!!", "QmNotEd25519"]) {
      await expect(keys.resolve(notAPeerId)).resolves.toEqual([]);
    }
  });

  it("refuses an RSA peerId rather than guessing at its bytes", async () => {
    // An RSA peerId is a SHA-256 multihash of the key, not the key itself, so
    // there is nothing to recover — the digest is a hash, and treating its
    // tail as a public key would silently produce a wrong one.
    const priv = await generateKeyPair("RSA", 2048);
    const peerId = peerIdFromPrivateKey(priv);

    await expect(selfCertifyingKeys().resolve(peerId.toString())).resolves.toEqual([]);
  }, 60_000);

  it("explains a refusal when asked to, and distinguishes the reasons", async () => {
    // `resolve` stays quiet because its contract is a deny list, but a caller
    // debugging a mesh id needs to know WHICH way it was wrong.
    //
    // The first assertion here was originally written against "nonsense",
    // which is entirely VALID base58 — n, o, s and e are all in the alphabet —
    // so the code correctly reported the next problem instead, and the test
    // was wrong rather than the code. `0`, `O`, `I` and `l` are the four
    // characters base58 excludes precisely because they are confusable.
    const { describeMeshId } = await import("../src/keys.js");

    expect(describeMeshId("0OIl")).toMatch(/not base58/i);
    // Valid base58, but not a multihash — the length prefix does not describe
    // the rest of the bytes. Reported as unparseable rather than as "a peerId
    // with the wrong key type", which would send a reader somewhere useless.
    expect(describeMeshId("nonsense")).toMatch(/unparseable/i);

    const rsa = peerIdFromPrivateKey(await generateKeyPair("RSA", 2048)).toString();
    expect(describeMeshId(rsa)).toMatch(/ed25519/i);

    const ed = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
    expect(describeMeshId(ed)).toMatch(/valid/i);
  }, 60_000);
});

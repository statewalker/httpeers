/**
 * The loader seam is OPTIONAL, and this is the test that says so.
 *
 * Every other test in this package mints and verifies real tokens without ever
 * calling `initBiscuit` — so the ordinary import path is proven a hundred and
 * sixty times over. What that does not state explicitly is the architectural
 * claim behind it: worker-side verification is an OPTION, not a requirement,
 * because access checks run in the page and the ServiceWorker holds no
 * application code.
 *
 * If that ever stops being true — if something in this package starts needing
 * the seam to work at all — the assertion below is where it shows.
 */

import { describe, expect, it } from "vitest";
import { initBiscuit } from "../src/engine.js";
import { ruleSet } from "../src/rules.js";
import { generateSigner } from "../src/signer.js";
import { mintToken, verifyToken } from "../src/tokens.js";

describe("the wasm loader seam", () => {
  it("is never needed on the ordinary path", async () => {
    const signer = await generateSigner();
    const token = await mintToken({
      signer,
      sub: "12D3KooWSubjectForEngineTest",
      roles: ["member"],
      ttlMs: 60_000,
    });

    const claims = await verifyToken(token, {
      issuer: signer.mesh,
      connectionPeer: "12D3KooWSubjectForEngineTest",
    });

    expect(claims.sub).toBe("12D3KooWSubjectForEngineTest");
    // Rules build and evaluate through the same wasm, also without the seam.
    expect(ruleSet({ rules: ['capability("a") <- role("b");'] }).rules).toHaveLength(1);
  });

  it("is exported, and takes the binding module from its caller", () => {
    // It cannot import biscuit-wasm's internals itself: the deep import the
    // seam needs is not resolvable through that package's own `exports` map.
    // So the signature is the documentation — a caller who cannot satisfy
    // their bundler cannot call it, and finds out at the type level.
    expect(typeof initBiscuit).toBe("function");
    expect(initBiscuit.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Biscuit in a browser, with nothing to arm.
 *
 * This file used to prove the wasm loader seam: three bundler aliases, an
 * optimizer exclusion and an explicit `initBiscuit` before any token could be
 * touched, each found by a page dying. The engine is pure TypeScript now, so
 * the claim is the opposite one and stronger: a page imports `httpeers-access`
 * the ordinary way and it works — `vitest.browser.config.ts` carries no Biscuit
 * alias at all, which is what makes this test mean anything.
 */

import { describe, expect, it } from "vitest";

describe("Biscuit, in a browser", () => {
  it("mints and verifies tokens with no initialisation", async () => {
    const { generateSigner, mintToken } = await import("@statewalker/httpeers-access/issuer");
    const { verifyToken } = await import("@statewalker/httpeers-access");

    const signer = await generateSigner();
    const sub = `12D3KooW${"S".repeat(44)}`;
    const token = await mintToken({ signer, sub, roles: ["member"], ttlMs: 60_000 });
    const claims = await verifyToken(token, { issuer: signer.mesh, connectionPeer: sub });

    expect(claims.sub).toBe(sub);
    expect(claims.roles).toEqual(["member"]);
  }, 60_000);

  it("authorizes against a rule set", async () => {
    // The other half a page does: not reading a token but DECIDING with one.
    const { authorize, ruleSet } = await import("@statewalker/httpeers-access");
    const rules = ruleSet({
      version: 1,
      rules: ['capability("app:read") <- role("member");'],
      policies: ['allow if capability("app:read");'],
    });
    const decision = authorize(
      rules,
      { operation: "GET", resource: "/hello", now: 2000 },
      {
        sub: "p",
        iss: "h",
        mesh: "h",
        roles: ["member"],
        iat: 1000,
        exp: 1_000_000,
        audience: "unrestricted",
      },
    );
    expect(decision.allowed).toBe(true);
  }, 60_000);

  it("fetches no .wasm", () => {
    const wasm = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith(".wasm"));
    expect(wasm).toEqual([]);
  });
});

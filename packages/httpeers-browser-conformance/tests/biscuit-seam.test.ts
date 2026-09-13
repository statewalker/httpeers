/**
 * Making biscuit-wasm work in a browser — the thing every demo page needs
 * before it can touch a token.
 *
 * `engine.ts` says the loader seam is optional because "the architecture puts
 * access checks in the PAGE, not the worker ... so the ordinary import works".
 * In a page under Vite it does NOT: `tests/biscuit-in-browser.test.ts` measures
 * the plain import failing. This measures the way through, and the three things
 * it takes — each of which was found by a failure, not by reading.
 *
 * 1. **Alias the package entry to the binding module.** `biscuit.js` is
 *    `export * from "./biscuit_bg.js"` plus `__wbg_set_wasm(wasm)`, where
 *    `wasm` is a `.wasm` import: a MODULE in Node (hence the
 *    `ExperimentalWarning` on every Node run) and a URL STRING under Vite.
 *    Left in place it loads whenever anything imports the package and
 *    overwrites whatever the seam armed — with a string. The symptom is the
 *    page dying outright, not an exception.
 *
 * 2. **Keep it out of `optimizeDeps`.** A pre-bundled copy is a second module
 *    instance; arming one leaves the other — the one the library calls —
 *    holding no wasm. Symptom: `Cannot read properties of undefined (reading
 *    'biscuitbuilder_new')`.
 *
 * 3. **Import the binding through the same specifier the library uses**, for
 *    the same one-instance reason.
 *
 * `__wbindgen_start()` is NOT required — checked by deliberately not calling
 * it, because `biscuit.js` does call it and it would have been easy to report
 * `initBiscuit` as defective for omitting it.
 *
 * The wasm imports exactly TWO modules, measured with
 * `WebAssembly.Module.imports`. `engine.ts` says seven snippets; seven
 * directories ship and the binary references one.
 */

import { describe, expect, it } from "vitest";

describe("initBiscuit, in a browser", () => {
  it("arms the binding so tokens mint and verify", async () => {
    const { initBiscuit } = await import("@statewalker/httpeers-access/engine");
    // The SAME specifier `httpeers-access` imports, aliased in
    // `vitest.browser.config.ts` to the binding module. A demo app needs those
    // same two lines in its own Vite config.
    const binding = await import("@biscuit-auth/biscuit-wasm");
    const snippet = await import("#biscuit-snippet");

    // Fetched from a static URL, which is what a deployed page does: the wasm
    // is an asset beside the bundle, not something the bundler inlines.
    await initBiscuit("/biscuit_bg.wasm", binding as never, {
      "./snippets/biscuit-auth-314ca57174ae0e6d/inline0.js": snippet,
    });

    const { generateSigner, mintToken } = await import("@statewalker/httpeers-access/issuer");
    const { verifyToken } = await import("@statewalker/httpeers-access");

    const signer = await generateSigner();
    const sub = `12D3KooW${"S".repeat(44)}`;
    const token = await mintToken({ signer, sub, roles: ["member"], ttlMs: 60_000 });
    const claims = await verifyToken(token, { issuer: signer.mesh, connectionPeer: sub });

    expect(claims.sub).toBe(sub);
    expect(claims.roles).toEqual(["member"]);
  }, 60_000);

  it("authorizes against a rule set once armed", async () => {
    // The other half a page does: not reading a token but DECIDING with one.
    // Datalog evaluation is where the wasm is actually exercised.
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
});

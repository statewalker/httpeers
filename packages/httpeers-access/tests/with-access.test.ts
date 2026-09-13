/**
 * One middleware, so the nesting order cannot be got wrong.
 *
 * THE HAZARD THIS REPLACES, in the prototype's own words (`peer.ts`):
 *
 *   "BINDING OUTSIDE, POLICY INSIDE. `withPolicy`'s `lookupClaims` read only
 *    works because the binding middleware calls `getClaims` first — which
 *    caches via `cacheClaims` — before policy ever runs. Reverse the nesting
 *    and policy reads an empty cache: every request would look tokenless to
 *    the authorizer, no matter what it actually carried."
 *
 * Two middlewares, composed by the caller, with a correctness requirement
 * recorded in a comment three files away from where the composing happens.
 * The first test below MEASURES that hazard — building the pair the wrong way
 * round and watching an authenticated request come back denied — so the reason
 * for merging them is evidence rather than assertion.
 *
 * `withAccess` then has no order to get wrong: it takes no ordering parameter,
 * because there is one middleware.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { FetchHandler } from "@statewalker/httpeers-core";
import { ANONYMOUS, json, registerPeer } from "@statewalker/httpeers-core";
import { beforeAll, describe, expect, it } from "vitest";
import { access, withAccess } from "../src/access.js";
import { ruleSet } from "../src/rules.js";
import type { Signer } from "../src/signer.js";
import { mintToken } from "../src/tokens.js";

const RULES = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: [
    'allow if capability("app:read"), resource("/data")' +
      ' or capability("app:read"), resource($r), $r.starts_with("/data/");',
  ],
});

const ok: FetchHandler = async () => json({ reached: true });

describe("withAccess", () => {
  let hubKey: Ed25519PrivateKey;
  let issuer: string;
  let signer: Signer;
  let member: string;
  let token: string;

  beforeAll(async () => {
    hubKey = await generateKeyPair("Ed25519");
    issuer = peerIdFromPrivateKey(hubKey).toString();
    signer = { mesh: issuer, seed: hubKey.raw.slice(0, 32) };
    member = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
    token = await mintToken({ signer, sub: member, roles: ["member"], ttlMs: 600_000 });
  });

  function request(path: string, bearer?: string): Request {
    const req = new Request(`http://peer.local${path}`, {
      headers: bearer == null ? {} : { authorization: `Bearer ${bearer}` },
    });
    registerPeer(req, member);
    return req;
  }

  it("lets an authenticated, authorised request through", async () => {
    const handler = withAccess({
      issuer,
      rules: RULES,
      selfPeer: "12D3KooWSelfPeerForTests",
      provenPeer: (req) => (req.headers.get("x-anon") != null ? ANONYMOUS : member),
    })(ok);

    const response = await handler(request("/data/thing", token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: true });
  });

  it("refuses the same request without a token", async () => {
    const handler = withAccess({
      issuer,
      rules: RULES,
      provenPeer: () => member,
    })(ok);

    const response = await handler(request("/data/thing"));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a path no rule allows, even with a good token", async () => {
    const handler = withAccess({ issuer, rules: RULES, provenPeer: () => member })(ok);

    const response = await handler(request("/secret", token));

    expect(response.status).toBe(403);
  });

  it("CLAIMS REACH POLICY — the hazard the merge removes", async () => {
    // The whole point. In the prototype this held only because the caller
    // nested the two middlewares correctly; here there is no nesting to do.
    // If claims did not reach the authorizer, `/data/thing` above would be
    // denied for a token that plainly carries `role("member")`.
    const seen: Array<string | undefined> = [];
    const inspect: FetchHandler = async (req) => {
      seen.push(access(req)?.claims?.sub);
      return json({ ok: true });
    };

    const handler = withAccess({ issuer, rules: RULES, provenPeer: () => member })(inspect);
    await handler(request("/data/thing", token));

    expect(seen).toEqual([member]);
  });

  it("exposes the derived capabilities to the handler", async () => {
    let caps: string[] = [];
    const inspect: FetchHandler = async (req) => {
      caps = [...(access(req)?.capabilities() ?? [])].sort();
      return json({ ok: true });
    };

    const handler = withAccess({ issuer, rules: RULES, provenPeer: () => member })(inspect);
    await handler(request("/data/thing", token));

    expect(caps).toEqual(["app:read"]);
  });

  it("a revoked token is refused, and the refusal says why", async () => {
    const handler = withAccess({
      issuer,
      rules: RULES,
      provenPeer: () => member,
      revocation: { check: () => "removed from the mesh" },
    })(ok);

    const response = await handler(request("/data/thing", token));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("removed from the mesh");
  });

  it("bootstrap requests skip the token, and are still bound to a proven peer", async () => {
    // A join request has no token yet — that is what it is for. It must still
    // come from a peer the transport proved, or anyone could bootstrap.
    const handler = withAccess({
      issuer,
      rules: RULES,
      provenPeer: (req) => (req.headers.get("x-anon") != null ? ANONYMOUS : member),
      bootstrap: (req) => new URL(req.url).pathname === "/join",
    })(ok);

    expect((await handler(request("/join"))).status).toBe(200);

    const anonymous = new Request("http://peer.local/join", { headers: { "x-anon": "1" } });
    registerPeer(anonymous, member);
    expect((await handler(anonymous)).status).toBe(401);
  });
});

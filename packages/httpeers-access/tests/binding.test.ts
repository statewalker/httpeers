/**
 * The testability argument, made concrete.
 *
 * No libp2p, no transport, no JWT cryptography, no network. Every seam —
 * `getPeerId`, `usesTransportIdentity`, `getClaims`, `isRevoked` — is a
 * one-line stub. This is what the stopping rule asks for: one file, one
 * exported signature, behaviour assertable in isolation.
 *
 * The case this whole design exists for is the confused-deputy replay: a
 * hub-minted token is a bearer token, valid at every provider that trusts
 * the hub, so a malicious provider could otherwise replay a member's token
 * elsewhere. The handshake — `getPeerId`, which no caller can forge — is
 * what defeats it.
 */

import type {
  ClaimsResult,
  MeshClaims,
  ProvenPeer,
  TokenRejectionReason,
} from "@statewalker/httpeers-core";
import { ANONYMOUS } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { newPeerHandlers, PeerBindingLostError } from "../src/binding.js";

const ALICE = "12D3KooWAlice";
const MALLORY = "12D3KooWMallory";

function claimsFor(sub: string): MeshClaims {
  // `audience: "unrestricted"` because this middleware does not look at the
  // audience at all -- the destination enforces that inside `verifyToken`,
  // before these claims exist (ADR-0020). The fixture states the field rather
  // than defaulting it because `MeshClaims` has no default: three states,
  // each explicit.
  return {
    sub,
    iss: "hub",
    mesh: "hub",
    roles: ["member"],
    iat: Date.now(),
    exp: Date.now() + 60_000,
    audience: "unrestricted",
  };
}

/** No `authorization` header at all. */
const ABSENT: ClaimsResult = { status: "absent" };

/** A token that verified. */
function verified(claims: MeshClaims): ClaimsResult {
  return { status: "verified", claims };
}

/**
 * A token that was PRESENTED and did not verify. This is the state the seam
 * could not express before Task 34 — it and `ABSENT` were both `null`, which
 * is why every refusal answered the same 401.
 */
function refused(reason: TokenRejectionReason, detail: string): ClaimsResult {
  return { status: "refused", reason, detail, failedChecks: [] };
}

interface SubjectOpts {
  peer: ProvenPeer | undefined;
  found?: ClaimsResult;
  bootstrap?: boolean;
  isRevoked?: (claims: MeshClaims) => Promise<string | null>;
}

function subject(opts: SubjectOpts) {
  let reached = false;
  const handler = newPeerHandlers({
    getPeerId: async () => opts.peer as ProvenPeer,
    usesTransportIdentity: async () => opts.bootstrap ?? false,
    getClaims: async () => opts.found ?? ABSENT,
    isRevoked: opts.isRevoked,
    handleEndpoints: async () => {
      reached = true;
      return new Response("ok");
    },
  });
  return { handler, reached: () => reached };
}

const req = (method = "GET") => new Request("http://peer/test/whoami", { method });

describe("newPeerHandlers", () => {
  it("admits a matching peer and token", async () => {
    const s = subject({ peer: ALICE, found: verified(claimsFor(ALICE)) });
    expect((await s.handler(req())).status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("rejects a token replayed over a different connection (the confused-deputy case)", async () => {
    // Mallory holds a valid token naming Alice as `sub`, but the transport
    // handshake on THIS connection proved Mallory, not Alice.
    const s = subject({ peer: MALLORY, found: verified(claimsFor(ALICE)) });
    expect((await s.handler(req())).status).toBe(403);
    expect(s.reached()).toBe(false);
  });

  it("rejects a missing token on an ordinary path", async () => {
    const s = subject({ peer: ALICE, found: ABSENT });
    const res = await s.handler(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "membership token required" });
  });

  it("admits a bootstrap request with no token, identity taken from the transport", async () => {
    const s = subject({ peer: ALICE, found: ABSENT, bootstrap: true });
    expect((await s.handler(req())).status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("rejects a bootstrap request from an ANONYMOUS caller", async () => {
    // Bootstrap needs no token, but it still needs a PROVEN peer.
    const s = subject({ peer: ANONYMOUS, found: ABSENT, bootstrap: true });
    expect((await s.handler(req())).status).toBe(401);
  });

  it("rejects ANONYMOUS on an ordinary path — distinct from a lost binding", async () => {
    const s = subject({ peer: ANONYMOUS, found: verified(claimsFor(ALICE)) });
    const res = await s.handler(req());
    expect(res.status).toBe(401);
    // A different reason than the missing-token case above: this caller DID
    // present a token, but the transport proved nobody. Pinning the body,
    // not just the status, keeps the two 401s from silently collapsing into
    // one generic "unauthorized" if a later refactor merges the branches.
    expect(await res.json()).toEqual({ error: "possession unproven" });
  });

  it("THROWS when the binding was lost, rather than denying", async () => {
    // This distinguishes a bug from a policy decision. If it denied
    // instead, a re-created Request would look exactly like an anonymous
    // caller, hiding the bug behind a plausible-looking response.
    const s = subject({ peer: undefined, found: verified(claimsFor(ALICE)) });
    await expect(s.handler(req())).rejects.toThrow(PeerBindingLostError);
  });

  it("isRevoked returning a reason refuses the request and the reason reaches the response", async () => {
    const s = subject({
      peer: ALICE,
      found: verified(claimsFor(ALICE)),
      isRevoked: async () => "member removed",
    });
    const res = await s.handler(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "member removed" });
    expect(s.reached()).toBe(false);
  });

  it("isRevoked absent — nothing is revoked (the seam is optional)", async () => {
    let reached = false;
    const handler = newPeerHandlers({
      getPeerId: async () => ALICE,
      usesTransportIdentity: async () => false,
      getClaims: async () => verified(claimsFor(ALICE)),
      // isRevoked intentionally omitted.
      handleEndpoints: async () => {
        reached = true;
        return new Response("ok");
      },
    });
    const res = await handler(req());
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it("discriminates bootstrap by method, not path — a presence write bootstraps, a presence read on the same path does not", async () => {
    let reached = false;
    const handler = newPeerHandlers({
      getPeerId: async () => ALICE,
      usesTransportIdentity: async (r) => r.method === "POST",
      getClaims: async () => ABSENT,
      handleEndpoints: async () => {
        reached = true;
        return new Response("ok");
      },
    });

    const postRes = await handler(req("POST"));
    expect(postRes.status).toBe(200);
    expect(reached).toBe(true);

    reached = false;
    const getRes = await handler(req("GET"));
    expect(getRes.status).toBe(401);
    expect(reached).toBe(false);
  });
});

describe("a refused token says WHY, and the status says whether retrying can help", () => {
  // The four conditions this suite pins used to be one opaque 401. What
  // separates them is not a taxonomy but a question with two answers: could
  // authenticating again work? See `REFUSAL_STATUS` in `peer-handlers.ts`.

  it("expired -> 401: the credential is stale and a refresh is the remedy", async () => {
    const s = subject({ peer: ALICE, found: refused("expired", "token expired") });
    const res = await s.handler(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token expired", reason: "expired" });
    expect(s.reached()).toBe(false);
  });

  it("audience -> 403: THE RETRY LOOP. A fresh token is scoped the same way", async () => {
    // The sharp case Task 34 exists for. Under the old collapse this answered
    // 401 "membership token required", so a client refreshed, was refused
    // identically, and refreshed again -- forever, with nothing in the
    // exchange able to say that refreshing was not the remedy.
    const s = subject({
      peer: ALICE,
      found: refused("audience", "this peer is not an intended audience for this token"),
    });
    const res = await s.handler(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "this peer is not an intended audience for this token",
      reason: "audience",
    });
  });

  it("... and that is a DIFFERENT status from presenting no token at all", async () => {
    // The counterfactual, without which the assertion above would pass under
    // a handler that answered 403 to everything.
    const absent = await subject({ peer: ALICE, found: ABSENT }).handler(req());
    expect(absent.status).toBe(401);
  });

  it("peer-binding -> 401: the honest client here is a page that reset its identity", async () => {
    // The row that looks most like "stop" and is not. Every page in this stack
    // has a reset-identity control, and a page that resets while still holding
    // a token minted for its OLD key presents exactly this -- a token whose
    // subject does not match the key it is now proving. A refresh fixes it, so
    // by the table's own question it is 401. A thief looping here obtains
    // nothing; an honest client told to stop is a real failure.
    const s = subject({
      peer: MALLORY,
      found: refused("peer-binding", "token subject does not match connected peer"),
    });
    const res = await s.handler(req());
    expect(res.status).toBe(401);
    // The status says "retry may help"; the BODY is what still distinguishes
    // this from having presented no token at all.
    expect(await res.json()).toEqual({
      error: "token subject does not match connected peer",
      reason: "peer-binding",
    });
    expect(s.reached()).toBe(false);
  });

  it("... and the middleware's OWN sub comparison stays 403, deliberately", async () => {
    // Not the same condition despite the same words. This fires when an
    // injected `getClaims` declares claims VERIFIED whose subject does not
    // match the proven peer -- a supplier not enforcing the binding at all,
    // which is a deployment bug no token the client can fetch will fix.
    const s = subject({ peer: MALLORY, found: verified(claimsFor(ALICE)) });
    const res = await s.handler(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "token subject does not match connected peer" });
  });

  it("mesh-mismatch -> 403, signature -> 403: another hub minted it", async () => {
    const mesh = subject({
      peer: ALICE,
      found: refused("mesh-mismatch", "mesh does not match issuer"),
    });
    expect((await mesh.handler(req())).status).toBe(403);
    const sig = subject({
      peer: ALICE,
      found: refused("signature", "token signature does not verify against this mesh's key"),
    });
    expect((await sig.handler(req())).status).toBe(403);
  });

  it("malformed-token -> 401: what was presented is not a credential at all", async () => {
    // Deliberately on the 401 side of the line. A client holding bytes that
    // are not a token is in the same position as one holding nothing, and
    // obtaining a real token is exactly what fixes it.
    const s = subject({ peer: ALICE, found: refused("malformed-token", "malformed token") });
    expect((await s.handler(req())).status).toBe(401);
  });

  it("the reason is in the BODY and never in a header", async () => {
    // Headers are latin1; `detail` is prose meant for a person, and the app
    // page renders it verbatim into the DOM.
    const s = subject({
      peer: ALICE,
      found: refused("audience", "this peer is not an intended audience for this token"),
    });
    const res = await s.handler(req());
    const headers = [...res.headers.keys()];
    expect(headers).toEqual(["content-type"]);
  });

  it("a refusal never reaches the endpoints, whatever its status", async () => {
    for (const reason of ["expired", "audience", "peer-binding", "malformed-token"] as const) {
      const s = subject({ peer: ALICE, found: refused(reason, "x") });
      await s.handler(req());
      expect(s.reached()).toBe(false);
    }
  });
});

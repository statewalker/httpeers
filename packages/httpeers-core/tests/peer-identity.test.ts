/**
 * Proven identity travels in a HEADER, and the rules that makes safe.
 *
 * WHY THIS REPLACED A `WeakMap`. The binding used to live in a
 * `WeakMap<Request, ProvenPeer>`, which is unforgeable but does not survive a
 * re-created `Request` — and re-creating one is what handlers DO. Seven places
 * in these packages construct a new `Request` from an old one; exactly one
 * remembered to call `copyPeerBinding`. The others are outbound-by-design, so
 * it was correct by author discipline, with no test guarding it and no way for
 * third-party middleware (a Hono router, a user's own wrapper) to know the
 * function existed at all.
 *
 * A header survives every one of those re-creations for free, because
 * `new Request(url, req)` copies headers. It is also inspectable, which is
 * what lets a security test be written in plain HTTP.
 *
 * THE COST, AND THE RULE THAT PAYS IT. A header is whatever the caller typed.
 * So the header is only trustworthy where something STRIPS it before setting
 * it, and this module exists to make that the only way to write it:
 * `registerPeer` and `registerAnonymous` always delete first, and
 * `stripPeerBinding` is the ingress primitive for a request that proved
 * nothing. Every entry point into a peer must call one of the three. A path
 * that forgets is the forgery hole, so each one is tested here and again at
 * every adapter.
 */

import { describe, expect, it } from "vitest";
import {
  ANONYMOUS,
  forwardLocalOnly,
  lookupPeer,
  PEER_ID_HEADER,
  registerAnonymous,
  registerPeer,
  stripPeerBinding,
} from "../src/index.js";

const ALICE = "12D3KooWAlice";
const MALLORY = "12D3KooWMallory";

describe("the proven-peer header", () => {
  it("registers a peer and reads it back", () => {
    const req = new Request("http://peer.local/x");
    registerPeer(req, ALICE);
    expect(lookupPeer(req)).toBe(ALICE);
    expect(req.headers.get(PEER_ID_HEADER)).toBe(ALICE);
  });

  it("survives a re-created Request with nothing copied by hand", () => {
    // THE WHOLE REASON FOR THE CHANGE. Under the WeakMap this required a
    // `copyPeerBinding` call that six of seven call sites did not make.
    const req = new Request("http://peer.local/peers/12D3KooWBob/hello");
    registerPeer(req, ALICE);

    const stripped = new Request("http://peer.local/hello", req);
    expect(lookupPeer(stripped)).toBe(ALICE);

    // And across an explicit header rebuild, which is how the proxy and the
    // ghost re-issue a request.
    const rebuilt = new Request("http://peer.local/hello", {
      method: req.method,
      headers: { ...Object.fromEntries(req.headers) },
    });
    expect(lookupPeer(rebuilt)).toBe(ALICE);
  });

  it("reads ANONYMOUS back as the sentinel, not as a string", () => {
    // `ProvenPeer` is unchanged in memory: only the wire encoding is new, so
    // every downstream `=== ANONYMOUS` check keeps working.
    const req = new Request("http://peer.local/x");
    registerAnonymous(req);
    expect(lookupPeer(req)).toBe(ANONYMOUS);
    expect(typeof req.headers.get(PEER_ID_HEADER)).toBe("string");
  });

  it("is absent, not anonymous, on a request nobody bound", () => {
    // Absence is a bug or a local origin; anonymity is a proven value. The two
    // must stay distinguishable — `forwardLocalOnly` depends on it.
    expect(lookupPeer(new Request("http://peer.local/x"))).toBeUndefined();
  });
});

describe("forgery", () => {
  it("registerPeer overwrites a value the caller supplied", () => {
    // THE ATTACK: a client sets the header itself, hoping the far side trusts
    // it. The ingress primitive must not merely set — it must strip first, or
    // a second value could linger in a multi-valued header.
    const req = new Request("http://peer.local/x", {
      headers: { [PEER_ID_HEADER]: MALLORY },
    });
    registerPeer(req, ALICE);
    expect(lookupPeer(req)).toBe(ALICE);
    expect(req.headers.get(PEER_ID_HEADER)).toBe(ALICE);
    expect(req.headers.get(PEER_ID_HEADER)).not.toContain(MALLORY);
  });

  it("registerAnonymous overwrites a claimed identity", () => {
    const req = new Request("http://peer.local/x", {
      headers: { [PEER_ID_HEADER]: MALLORY },
    });
    registerAnonymous(req);
    expect(lookupPeer(req)).toBe(ANONYMOUS);
  });

  it("stripPeerBinding removes a claimed identity and asserts nothing", () => {
    // The ingress primitive for a LOCALLY originated request: this peer proved
    // nothing about a caller that never crossed a wire, and a page's own
    // script must not be able to claim otherwise.
    const req = new Request("http://peer.local/x", {
      headers: { [PEER_ID_HEADER]: MALLORY },
    });
    stripPeerBinding(req);
    expect(lookupPeer(req)).toBeUndefined();
    expect(req.headers.has(PEER_ID_HEADER)).toBe(false);
  });
});

describe("forwardLocalOnly, over the header", () => {
  it("allows a request that carries no binding", async () => {
    expect(await forwardLocalOnly(new Request("http://local/x"), "12D3KooWT")).toBe(true);
  });

  it("refuses a request a proven peer sent", async () => {
    const req = new Request("http://local/x");
    registerPeer(req, MALLORY);
    expect(await forwardLocalOnly(req, "12D3KooWT")).toBe(false);
  });

  it("refuses a request proven to be from NOBODY", async () => {
    // `ANONYMOUS` is a binding, not absence. Reading the sentinel as absence
    // would make this peer an open relay for anonymous callers.
    const req = new Request("http://local/x");
    registerAnonymous(req);
    expect(await forwardLocalOnly(req, "12D3KooWT")).toBe(false);
  });

  it("refuses a request carrying a FORGED binding it never stripped", async () => {
    // Conservative in the right direction: an un-stripped header makes this
    // peer refuse to relay, rather than relay on a stranger's say-so. The
    // forgery still has to be stripped at ingress for authorization to be
    // sound — this only says the relay policy fails safe.
    const req = new Request("http://local/x", { headers: { [PEER_ID_HEADER]: MALLORY } });
    expect(await forwardLocalOnly(req, "12D3KooWT")).toBe(false);
  });
});

describe("egress does not leak the caller's identity onward", () => {
  it("a relayed request reaches the third party identity-free", async () => {
    // UNDER THE WeakMap THIS WAS FREE: a re-created Request simply had no
    // entry, so "outbound is identity-free by definition" held by accident of
    // the mechanism. A header copies itself, so the router now has to strip
    // deliberately -- otherwise A relaying for B tells C who B is.
    //
    // Not exploitable on its own (C strips at ingress), but it contradicts
    // the documented contract and leaks the original caller to a third party.
    const { createPeerRouter, createMounts } = await import("../src/index.js");
    let forwarded: Request | null = null;
    const router = createPeerRouter({
      selfPeerId: "12D3KooWSelf",
      mounts: createMounts(),
      allowForward: async () => true,
      remote: async (_peerId, req) => {
        forwarded = req;
        return new Response("ok");
      },
    });

    // A REAL-SHAPED peer id: `looksLikePeerId` needs 40+ chars after the
    // prefix, and a short one makes the router serve locally instead of
    // forwarding -- which would pass this test while measuring nothing.
    const third = `12D3KooW${"T".repeat(44)}`;
    const inbound = new Request(`http://peer.local/${third}/x`);
    registerPeer(inbound, "12D3KooWCaller");
    await router(inbound);

    expect(forwarded).not.toBeNull();
    expect(lookupPeer(forwarded as unknown as Request)).toBeUndefined();
  });
});

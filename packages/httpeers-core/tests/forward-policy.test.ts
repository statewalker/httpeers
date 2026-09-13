/**
 * Who may make this peer dial a third party.
 *
 * R-2: relaying is its own capability, deny by default. The hole it guards is
 * invisible for a while because it fails CLOSED at the far end — the third
 * party rejects the tokenless request, so every observable outcome looks
 * right. The damage is the work done, not the answer given.
 *
 * `forwardLocalOnly` is the policy every assembly actually wants, named once
 * so nobody re-derives it. It was re-derived wrongly by omission: `startMember`
 * passed NO policy at all, so the router denied everything and a member could
 * not call another member through its own edge.
 */
import { describe, expect, it } from "vitest";
import { forwardLocalOnly } from "../src/index.js";
import { registerAnonymous, registerPeer } from "../src/index.js";

const TARGET = "12D3KooWTarget";

describe("forwardLocalOnly", () => {
  it("allows a request that never came off a wire", async () => {
    // No binding at all: this originated at our own edge, so forwarding it is
    // this peer routing its own traffic, not relaying for a stranger.
    expect(await forwardLocalOnly(new Request("http://local/x"), TARGET)).toBe(true);
  });

  it("refuses a request a proven peer sent us", async () => {
    const req = new Request("http://local/x");
    registerPeer(req, "12D3KooWCaller");
    expect(await forwardLocalOnly(req, TARGET)).toBe(false);
  });

  it("refuses a request proven to be from NOBODY", async () => {
    // `ANONYMOUS` is a binding — it means the transport proved there was no
    // identity, which is still "arrived from the network". Treating the
    // sentinel as absence is the obvious wrong reading of `lookupPeer`, and
    // it would let any anonymous caller use this peer as an open relay.
    const req = new Request("http://local/x");
    registerAnonymous(req);
    expect(await forwardLocalOnly(req, TARGET)).toBe(false);
  });
});

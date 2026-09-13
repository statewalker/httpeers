/**
 * A page cannot name itself a peer.
 *
 * Moving the proven identity into a header bought rewrite-safety and cost one
 * thing: a header is writable by whoever builds the request, and a page builds
 * the requests that enter its own edge. So every LOCAL ingress has to strip
 * before dispatching, and these are the two local ingresses a member has.
 *
 * The hole this closes was real and was introduced by the switch itself.
 * `createEdgeDispatch` used to branch on `lookupPeer(req) !== undefined` to
 * mean "this arrived from the network, not ours to touch" — a safe reading
 * when the binding lived in a `WeakMap` no page could write. Under a header
 * the same check reads a value the page supplied, so a page could claim to be
 * any peer, skip the token attachment, and have `withAccess` downstream treat
 * the claim as PROVEN.
 *
 * The branch is gone rather than repaired: the edge is only ever mounted as a
 * local entry point (`serveTransport` dispatches to `peer.dispatch` directly
 * and never through here), so "arrived from the network" was never a state it
 * could legitimately observe.
 */

import { lookupPeer, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { createEdgeDispatch } from "../src/edge-dispatch.js";
import { createGateway } from "../src/gateway.js";

const MALLORY = "12D3KooWMalloryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const BOB = "12D3KooWBobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("the edge strips a claimed identity", () => {
  it("does not believe a peer header the page set", async () => {
    let seen: Request | null = null;
    const edge = createEdgeDispatch({
      key: "peers",
      dispatch: async (req) => {
        seen = req;
        return new Response("ok");
      },
      token: () => "REAL-TOKEN",
    });

    await edge(
      new Request("http://local/peers/hello", {
        headers: { [PEER_ID_HEADER]: MALLORY },
      }),
    );

    // The forged claim must not survive into dispatch, where `withAccess`
    // would read it as the transport's own word.
    expect(seen).not.toBeNull();
    expect(lookupPeer(seen as unknown as Request)).toBeUndefined();
    expect((seen as unknown as Request).headers.has(PEER_ID_HEADER)).toBe(false);
  });

  it("still attaches this peer's token when the page claimed an identity", async () => {
    // The old branch RETURNED EARLY on a binding, skipping the token. A page
    // that set the header would have had its call go out tokenless — so this
    // asserts the shortcut is gone, not merely that the header was removed.
    let seen: Request | null = null;
    const edge = createEdgeDispatch({
      key: "peers",
      dispatch: async (req) => {
        seen = req;
        return new Response("ok");
      },
      token: () => "REAL-TOKEN",
    });

    await edge(
      new Request(`http://local/peers/${BOB}/hello`, {
        headers: { [PEER_ID_HEADER]: MALLORY },
      }),
    );

    expect((seen as unknown as Request).headers.get("authorization")).toBe("Bearer REAL-TOKEN");
  });
});

describe("the gateway strips a claimed identity", () => {
  it("does not pass a caller's peer header into the mesh", async () => {
    // The gateway is ordinary HTTP in front of a member: its callers are
    // anonymous browsers and curl, and any peer header they send is a claim
    // about somebody else.
    let seen: Request | null = null;
    const gateway = createGateway({
      source: {
        peerId: "12D3KooWSelffffffffffffffffffffffffffffffffffff",
        meshView: () => null,
        fetch: async (req) => {
          seen = req;
          return new Response("ok");
        },
      },
      basePath: "",
      edgeKey: "peers",
    });

    await gateway(
      new Request(`http://gw.example/${BOB}/hello`, {
        headers: { [PEER_ID_HEADER]: MALLORY },
      }),
    );

    expect(seen).not.toBeNull();
    expect(lookupPeer(seen as unknown as Request)).toBeUndefined();
  });
});

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

import type { MeshView } from "@statewalker/httpeers-core";
import { lookupPeer, MESH_TOKEN_HEADER, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { createEdgeDispatch } from "../src/edge-dispatch.js";
import { createGateway } from "../src/gateway.js";

const MALLORY = "12D3KooWMalloryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const BOB = "12D3KooWBobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SELF_PEER = "12D3KooWSelffffffffffffffffffffffffffffffffffff";
// The gateway's dispatch never actually consults the view (only its `GET /`
// listing does), but a real caller always has one, and BOB has to be a member
// of it for this to look like a genuine mesh rather than a two-peer stub.
const PEER = BOB;
const VIEW: MeshView = {
  version: 1,
  self: SELF_PEER,
  members: [{ peerId: PEER, roles: [], online: true, addrs: [] }],
  advertisements: [],
};

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

    expect((seen as unknown as Request).headers.get(MESH_TOKEN_HEADER)).toBe("REAL-TOKEN");
  });

  // The edge rebuilt `outbound` with `new Request(url, req)`, which reads
  // `req.body` -- `undefined` in Firefox (checked against 155, no
  // `Request.prototype.body` there) -- so every POST through /peers/<peer>/
  // arrived at the far side with no body at all, silently.
  it("forwards a POST body where the runtime has no Request.body (Firefox)", async () => {
    let received: string | null = null;
    const edge = createEdgeDispatch({
      key: "peers",
      dispatch: async (req) => {
        received = await req.text();
        return new Response("ok");
      },
      token: () => "REAL-TOKEN",
    });

    const post = new Request(`http://local/peers/${BOB}/hello`, {
      method: "POST",
      body: "ping",
    });
    Object.defineProperty(post, "body", { value: undefined });

    expect((await edge(post)).status).toBe(200);
    expect(received).toBe("ping");
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
        peerId: SELF_PEER,
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

  // The gateway forwarded `request.body`, which is `undefined` in Firefox --
  // so every POST through /peers/<peer>/... arrived empty, silently.
  it("forwards a POST body where the runtime has no Request.body (Firefox)", async () => {
    let received: string | null = null;
    const gateway = createGateway({
      source: {
        peerId: SELF_PEER,
        fetch: async (request) => {
          received = await request.text();
          return new Response("ok");
        },
        meshView: () => VIEW,
      },
      basePath: "/peers",
      edgeKey: "peers",
    });
    const post = new Request(`http://local/peers/${PEER}/echo`, { method: "POST", body: "ping" });
    Object.defineProperty(post, "body", { value: undefined });
    expect((await gateway(post)).status).toBe(200);
    expect(received).toBe("ping");
  });
});

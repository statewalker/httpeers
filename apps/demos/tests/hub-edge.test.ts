/**
 * The hub page calls itself through its own edge (statewalker/httpeers#165).
 *
 * The page's edge is a local ingress: it strips any proven-peer header and
 * attaches the hub's own token (`sub` = the hub). The hub's router then serves
 * `/<self>/...` and unprefixed paths locally, behind `withAccess`, where the
 * token's `check if bound($k), connection_peer($k)` needs a proven peer. With
 * none, every self-call was refused `401 token subject does not match
 * connected peer`. This wires the chain the page builds, minus the browser:
 * `createHub`, the router behind `withAccess` (what `servePeer` exposes as
 * `dispatch`), and the page's edge dispatch.
 */
import { selfCertifyingKeys, withAccess } from "@statewalker/httpeers-access";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import {
  ANONYMOUS,
  createPeerRouter,
  forwardLocalOnly,
  lookupPeer,
  type PeerIdStr,
} from "@statewalker/httpeers-core";
import { createHub, memoryStorage, usesTransportIdentity } from "@statewalker/httpeers-hub";
import { describe, expect, it } from "vitest";
import { hubEdgeDispatch } from "../src/shared/hub-edge.js";
import { meshRules } from "../src/shared/policy.js";

const OTHER = "12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa";
const PAGE_ORIGIN = "https://hub.example";
/** What the page's own `fetch` carries: the page as its referrer. */
const FROM_PAGE = { referrer: `${PAGE_ORIGIN}/hub.html` };

async function hubPage() {
  const signer = await generateSigner();
  const self = signer.mesh as PeerIdStr;
  const hub = await createHub({
    selfPeerId: self,
    policies: meshRules(),
    storage: memoryStorage(),
    mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 60_000 }),
  });
  const forwarded: Request[] = [];
  const dispatch = createPeerRouter({
    selfPeerId: self,
    mounts: hub.mounts,
    allowForward: forwardLocalOnly,
    remote: async (_peer, req) => {
      forwarded.push(req);
      return new Response("remote");
    },
    access: withAccess({
      issuer: self,
      rules: meshRules(),
      selfPeer: self,
      keys: selfCertifyingKeys(),
      provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
      bootstrap: usesTransportIdentity(),
    }),
  });
  const selfToken = await mintToken({ signer, sub: self, roles: ["admin"], ttlMs: 60_000 });
  const edge = hubEdgeDispatch({
    key: "peers",
    selfPeerId: self,
    ownOrigin: PAGE_ORIGIN,
    dispatch,
    token: () => selfToken,
  });
  return { self, hub, edge, forwarded };
}

describe("the hub page through its own edge", () => {
  it("reads its own /.well-known/mesh addressed by its peer id", async () => {
    const { self, hub, edge } = await hubPage();
    const res = await edge(new Request(`${PAGE_ORIGIN}/peers/${self}/.well-known/mesh`, FROM_PAGE));
    expect(res.status).toBe(200);
    await hub.stop();
  });

  it("reads its own /.well-known/mesh with no peer prefix", async () => {
    const { hub, edge } = await hubPage();
    const res = await edge(new Request(`${PAGE_ORIGIN}/peers/.well-known/mesh`, FROM_PAGE));
    expect(res.status).toBe(200);
    await hub.stop();
  });

  it("still forwards a call to another peer as a local, unbound request", async () => {
    const { hub, edge, forwarded } = await hubPage();
    const res = await edge(new Request(`${PAGE_ORIGIN}/peers/${OTHER}/hello`, FROM_PAGE));
    expect(await res.text()).toBe("remote");
    expect(lookupPeer(forwarded[0] as Request)).toBeUndefined();
    await hub.stop();
  });

  // A REQUEST ANOTHER SITE STARTED IS NOT THE HUB. The ServiceWorker takes
  // navigations and cross-site requests under the key too, and the edge
  // attaches the hub's token to them; they must not also be bound to the hub.
  it.each([
    ["no referrer (a navigation with no-referrer)", ""],
    ["a cross-origin referrer", "https://evil.example/attack.html"],
    ["the referrer a page gets for a cross-origin one", "about:client"],
  ])("does not give hub identity to a request with %s", async (_, referrer) => {
    const { self, hub, edge } = await hubPage();
    const read = await edge(
      new Request(`${PAGE_ORIGIN}/peers/${self}/.well-known/mesh`, { referrer }),
    );
    expect(read.status).toBe(401);
    const invite = await edge(
      new Request(`${PAGE_ORIGIN}/peers/.well-known/invite`, {
        method: "POST",
        referrer,
        headers: { "content-type": "text/plain" },
        body: '{"roles":["admin"]}',
      }),
    );
    expect(invite.status).toBe(401);
    await hub.stop();
  });
});

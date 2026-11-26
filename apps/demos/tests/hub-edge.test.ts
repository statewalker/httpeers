/**
 * The hub page calls itself through its own edge (statewalker/httpeers#165).
 *
 * The page's edge is a local ingress: it strips any proven-peer header and
 * attaches the hub's own token (`sub` = the hub). The hub's router then serves
 * `/<self>/...` and unprefixed paths locally, behind `withAccess`, where the
 * token's `check if bound($k), connection_peer($k)` needs a proven peer. With
 * none, every self-call was refused `401 token subject does not match
 * connected peer`.
 *
 * This wires the chain the page builds, minus the browser: `createHub`, the
 * router behind `withAccess` (what `servePeer` exposes as `dispatch`), the
 * page's edge dispatch, and between the ServiceWorker and the page the same
 * `webrun-http-link/2` transfer `SwHttpAdapter` uses (`connectHttpLink` /
 * `serveHttpLink` over a MessageChannel), which carries only the url, method
 * and headers: what the edge can tell from a request is what survives it.
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
import { connectHttpLink, serveHttpLink } from "@statewalker/webrun-http-browser";
import { afterEach, describe, expect, it } from "vitest";
import { asHub, HUB_SELF_HEADER, hubEdgeDispatch } from "../src/shared/hub-edge.js";
import { meshRules } from "../src/shared/policy.js";

const OTHER = "12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa";
const ORIGIN = "https://hub.example";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step();
});

async function hubPage() {
  const signer = await generateSigner();
  const self = signer.mesh as PeerIdStr;
  const hub = await createHub({
    selfPeerId: self,
    policies: meshRules(),
    storage: memoryStorage(),
    mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 60_000 }),
  });
  cleanups.push(() => hub.stop());
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
  const dispatched: Request[] = [];
  const edge = hubEdgeDispatch({
    key: "peers",
    selfPeerId: self,
    dispatch: (req) => {
      dispatched.push(req);
      return dispatch(req);
    },
    token: () => selfToken,
  });

  // The page serves the edge; the "ServiceWorker" end sends into it.
  const { port1, port2 } = new MessageChannel();
  const serving = serveHttpLink(port2, edge);
  const link = await connectHttpLink(port1);
  await serving;
  cleanups.push(() => {
    port1.close();
    port2.close();
  });
  const send = (url: string, init?: RequestInit) => link.send(new Request(url, init));
  return { self, send, forwarded, dispatched };
}

describe("the hub page through its own edge", () => {
  it("reads its own /.well-known/mesh addressed by its peer id", async () => {
    const { self, send, dispatched } = await hubPage();
    const res = await send(`${ORIGIN}/peers/${self}/.well-known/mesh`, asHub());
    expect(res.status).toBe(200);
    // Removed before dispatch: no mount, router or peer ever sees it.
    expect(dispatched[0]?.headers.has(HUB_SELF_HEADER)).toBe(false);
  });

  it("reads its own /.well-known/mesh with no peer prefix", async () => {
    const { send } = await hubPage();
    const res = await send(`${ORIGIN}/peers/.well-known/mesh`, asHub());
    expect(res.status).toBe(200);
  });

  // A REQUEST ANOTHER SITE STARTED IS NOT THE HUB. Navigations (links,
  // iframes, form POSTs) reach the ServiceWorker too and get the hub's token
  // attached; they cannot set a header, so they are never bound to the hub.
  it("does not give hub identity to the same call without the header", async () => {
    const { self, send } = await hubPage();
    const res = await send(`${ORIGIN}/peers/${self}/.well-known/mesh`);
    expect(res.status).toBe(401);
  });

  it("does not let a POST to /.well-known/invite without the header run as the hub", async () => {
    const { send } = await hubPage();
    const res = await send(`${ORIGIN}/peers/.well-known/invite`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"roles":["admin"]}',
    });
    expect(res.status).toBe(401);
  });

  it("forwards a call to another peer unbound and without the header", async () => {
    const { send, forwarded } = await hubPage();
    const res = await send(`${ORIGIN}/peers/${OTHER}/hello`, asHub());
    expect(await res.text()).toBe("remote");
    const out = forwarded[0] as Request;
    expect(lookupPeer(out)).toBeUndefined();
    expect(out.headers.has(HUB_SELF_HEADER)).toBe(false);
  });

  it("binds only on the exact header value", async () => {
    const { self, send } = await hubPage();
    const res = await send(`${ORIGIN}/peers/${self}/.well-known/mesh`, {
      headers: { [HUB_SELF_HEADER]: "true" },
    });
    expect(res.status).toBe(401);
  });
});

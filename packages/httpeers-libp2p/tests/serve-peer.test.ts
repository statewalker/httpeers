/**
 * Two real peers, a real Noise handshake, and the seam three assemblies
 * collapse into.
 *
 * Nothing here is stubbed. `servePeer` is the symbol the coverage audit found
 * exported nowhere while every assembly turned on it, so the test that matters
 * is the one an assembly would write: stand up two nodes, serve a mount table
 * on one, call it from the other, and check that what arrives carries the
 * identity the TRANSPORT proved rather than anything the caller said.
 */

import { tcp } from "@libp2p/tcp";
import type { FetchHandler } from "@statewalker/httpeers-core";
import { createMounts, json, lookupPeer } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey, peerIdOf } from "../src/identity.js";
import { type Peer, servePeer } from "../src/serve-peer.js";
import { createNode } from "../src/transport.js";

const started: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop();
});

async function node(listen: string[] = []) {
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports: [tcp() as never],
  });
  started.push({ stop: async () => void (await created.stop()) });
  return created;
}

/** A mount that reports back what the transport proved about its caller. */
function echoPeer(): FetchHandler {
  return async (request) => json({ caller: String(lookupPeer(request) ?? "none") });
}

describe("servePeer", () => {
  it("serves a mount table to another peer over a real handshake", async () => {
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();

    const mounts = createMounts();
    mounts.provide("/hello", async () => json({ hello: true }));

    const server: Peer = await servePeer({ node: serverNode, mounts });
    started.push(server);

    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const client = await servePeer({ node: clientNode, mounts: createMounts() });
    started.push(client);

    const response = await client.call(
      server.peerId,
      new Request(`http://peer.local/${server.peerId}/hello`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: true });
  }, 120_000);

  it("the mount sees the peer the TRANSPORT proved, not one the caller named", async () => {
    // The basis of every binding check downstream. A caller cannot assert its
    // own identity here — the only thing that reaches `lookupPeer` is what
    // Noise established for that stream.
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();

    const mounts = createMounts();
    mounts.provide("/whoami", echoPeer());

    const server = await servePeer({ node: serverNode, mounts });
    started.push(server);
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const client = await servePeer({ node: clientNode, mounts: createMounts() });
    started.push(client);

    const response = await client.call(
      server.peerId,
      new Request(`http://peer.local/${server.peerId}/whoami`, {
        // A lie, and it must not matter.
        headers: { "x-peer-id": "12D3KooWImpersonatingSomebodyElse" },
      }),
    );

    expect(await response.json()).toEqual({ caller: clientNode.peerId.toString() });
  }, 120_000);

  it("runs `access` over LOCAL requests only", async () => {
    // The distinction `servePeer` inherits from the router and which is easy
    // to lose by wrapping the whole thing: policy governs what this peer
    // serves, never what it forwards.
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();

    const seen: string[] = [];
    const mounts = createMounts();
    mounts.provide("/guarded", async () => json({ reached: true }));

    const server = await servePeer({
      node: serverNode,
      mounts,
      access: (next) => async (request) => {
        seen.push(new URL(request.url).pathname);
        return next(request);
      },
    });
    started.push(server);

    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const client = await servePeer({ node: clientNode, mounts: createMounts() });
    started.push(client);

    await client.call(server.peerId, new Request(`http://peer.local/${server.peerId}/guarded`));

    expect(seen).toEqual(["/guarded"]);
  }, 120_000);

  it("refuses to forward by default", async () => {
    // Relaying is a distinct capability, not a side effect of routing. The
    // failure this prevents is invisible from the outside — the third party
    // rejects a tokenless request, so the ANSWER looks right and the work was
    // still done on somebody else's say-so.
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();

    const server = await servePeer({ node: serverNode, mounts: createMounts() });
    started.push(server);
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    const client = await servePeer({ node: clientNode, mounts: createMounts() });
    started.push(client);

    // A REAL third-party peerId, generated. The first version of this test
    // used a hand-written string, which was 36 characters after the `12D3Koo`
    // prefix where `looksLikePeerId` needs 40 — so the router never saw a peer
    // id at all, treated it as a local path, and answered 404. The test passed
    // for a reason that had nothing to do with forwarding.
    const elsewhere = peerIdOf(await generateKey());
    expect(elsewhere).toMatch(/^12D3Koo[A-Za-z0-9]{40,}$/);

    const response = await client.call(
      server.peerId,
      new Request(`http://peer.local/${elsewhere}/anything`),
    );

    // Refused as a forward, and distinguishable from "no such mount".
    expect(response.status).toBe(403);
  }, 120_000);

  it("stop() is idempotent", async () => {
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const server = await servePeer({ node: serverNode, mounts: createMounts() });

    await server.stop();
    // An assembly that tears down twice — a page unloading while a test also
    // cleans up — must not see the second call throw.
    await expect(server.stop()).resolves.toBeUndefined();
  }, 120_000);
});

describe("createNode", () => {
  it("requires a transport rather than guessing one", async () => {
    // The prototype hard-coded `tcp()`, which put a Node-only transport into
    // every browser bundle that imported the module. There is no sensible
    // default — a server wants tcp, a page wants webRTC — so it asks.
    await expect(createNode({ transports: [] })).rejects.toThrow(/at least one transport/);
  });
});

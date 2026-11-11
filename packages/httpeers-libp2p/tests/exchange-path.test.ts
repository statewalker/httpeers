/**
 * GUARDS THE PARAMETRISATION. Every test in this package runs twice (see
 * `vitest.config.ts`), and the transport tests pass `muxPerPeer: MUX_PER_PEER`
 * (`exchange-path-option.ts`). A switch that silently did nothing would make
 * the second run a copy of the first and report the mux path as tested. This
 * checks, in each project, which protocol a peer built that way rides.
 */

import { tcp } from "@libp2p/tcp";
import { createMounts } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/identity.js";
import { MUX_PROTOCOL } from "../src/mux-link.js";
import { servePeer } from "../src/serve-peer.js";
import { createNode, PROTOCOL } from "../src/transport.js";
import { MUX_PER_PEER } from "./exchange-path-option.js";

const started: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (started.length > 0)
    await started
      .pop()?.()
      .catch(() => {});
});

async function node(listen: string[] = []) {
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports: [tcp() as never],
  });
  started.push(async () => await created.stop());
  return created;
}

const muxInForce = MUX_PER_PEER;

describe(`the exchange path in force (${muxInForce ? "mux per peer" : "stream per exchange"})`, () => {
  it("is the one this project names", async () => {
    const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
    const clientNode = await node();
    const mounts = createMounts();
    // A body that stays open, so the call's stream is still there to look at.
    mounts.provide("/open", async () => new Response(new ReadableStream({ start() {} })));
    const server = await servePeer({ node: serverNode, mounts, muxPerPeer: MUX_PER_PEER });
    started.push(() => server.stop());
    const client = await servePeer({
      node: clientNode,
      mounts: createMounts(),
      muxPerPeer: MUX_PER_PEER,
    });
    started.push(() => client.stop());
    await clientNode.dial(serverNode.getMultiaddrs()[0]);

    const response = await client.call(server.peerId, new Request("http://peer.local/open"));
    expect(response.status).toBe(200);

    const protocols = clientNode
      .getConnections(serverNode.peerId)
      .flatMap((c) => c.streams.map((s) => s.protocol));
    if (muxInForce) {
      expect(protocols).toContain(MUX_PROTOCOL);
      expect(protocols).not.toContain(PROTOCOL);
    } else {
      expect(protocols).toContain(PROTOCOL);
      expect(protocols).not.toContain(MUX_PROTOCOL);
    }
    // Not awaited: a cancel of a body that never sends settles only when the node stops.
    void response.body?.cancel().catch(() => {});
  }, 30_000);
});

/**
 * The relay-circuit fallback: a member reaches its hub over a KEPT limited
 * circuit through the relay, because WebRTC is impossible.
 *
 * WHY A MEMBER WITH NO `webRTC()` TRANSPORT. That is the case this exists for
 * (a hub in Docker on a bridge network, nothing published), and it is the only
 * way to be sure no upgrade happens behind the test's back: a member that
 * could upgrade would pass these tests over a direct connection and prove
 * nothing about the circuit. No `tcp()` either, for the same reason -- the
 * hub listens on loopback TCP, and a same-host dial would be unlimited.
 *
 * WHY EVERY TEST ASSERTS `limits != null`. The relay applies default limits
 * (`apps/relay/src/limits.ts`: generous, but present), which is what makes
 * libp2p refuse the protocol unless both sides opt in. A circuit without
 * limits would let the negative control pass for the wrong reason and the
 * positive ones prove nothing.
 *
 * WHY THE STREAM IS CHECKED AGAINST THE KEPT CONNECTION. libp2p 3.3.8 does not
 * reuse a limited connection for a bare `/p2p/<id>` dial
 * (`findExistingConnection` keeps only `limits == null`), so "the request
 * worked" alone could mean a second circuit was dialled. The tests count
 * connections to the hub and look for the protocol stream on the one kept.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Libp2p } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { PeerCallError } from "@statewalker/httpeers-core";
import { createRemote, PROTOCOL, reachHubRelayed } from "@statewalker/httpeers-libp2p";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { type Mesh, startMesh } from "./mesh-harness.js";

const CHUNKS = 20;

let mesh: Mesh | null = null;
let member: Libp2p | null = null;

afterEach(async () => {
  await member?.stop();
  member = null;
  await mesh?.stop();
  mesh = null;
}, 30_000);

/** A member that can reach the hub ONLY through the relay: no WebRTC, no TCP. */
async function relayOnlyMember(): Promise<Libp2p> {
  return createLibp2p({
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: async () => false },
    services: { identify: identify() },
  });
}

/** `CHUNKS` server-sent events, each written separately and a little apart. */
async function sse(): Promise<Response> {
  const encoder = new TextEncoder();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (n === CHUNKS) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.enqueue(encoder.encode(`data: ${n++}\n\n`));
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A hub serving on limited connections, a relay-only member, and that member's kept circuit. */
async function relayedMember(): Promise<{
  live: Mesh;
  node: Libp2p;
  kept: Connection;
  dialled: () => number;
}> {
  mesh = await startMesh({ runOnLimitedConnection: true, extraMounts: { "/stream": sse } });
  member = await relayOnlyMember();
  const live = mesh;
  const node = member;

  const kept = await reachHubRelayed(node, live.relayAddr, live.hubPeerId);
  expect(kept.limits != null).toBe(true);

  let opened = 0;
  node.addEventListener("connection:open", (event) => {
    if (event.detail.remotePeer.toString() === live.hubPeerId) opened++;
  });
  return { live, node, kept, dialled: () => opened };
}

/** Redeem a fresh invitation over `remote` -- a bootstrap route, so no token is needed yet. */
async function redeem(remote: ReturnType<typeof createRemote>, live: Mesh): Promise<string> {
  const response = await remote(
    live.hubPeerId,
    new Request("http://hub.invalid/.well-known/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: await live.invite() }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function connectionsTo(node: Libp2p, peerId: string): Connection[] {
  return node.getConnections().filter((c) => c.remotePeer.toString() === peerId);
}

describe("a member reaches its hub over a kept relay circuit", () => {
  it("answers a request over the limited connection, and leaves it open and limited", async () => {
    const { live, node, kept, dialled } = await relayedMember();
    const remote = createRemote({ node, runOnLimitedConnection: true });

    const token = await redeem(remote, live);
    const response = await remote(
      live.hubPeerId,
      new Request("http://hub.invalid/.well-known/mesh", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();

    expect(kept.status).toBe("open");
    expect(kept.limits != null).toBe(true);
    // The request rode the circuit already held -- nothing new was dialled.
    expect(dialled()).toBe(0);
    expect(connectionsTo(node, live.hubPeerId).map((c) => c.id)).toEqual([kept.id]);
  }, 60_000);

  it("streams a response of many chunks, in order, on the kept connection", async () => {
    const { live, node, kept, dialled } = await relayedMember();
    const remote = createRemote({ node, runOnLimitedConnection: true });
    const token = await redeem(remote, live);

    const response = await remote(
      live.hubPeerId,
      new Request("http://hub.invalid/stream", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(200);
    // Mid-stream, the protocol stream is on the kept circuit, not a new one.
    expect(kept.streams.some((s) => s.protocol === PROTOCOL)).toBe(true);

    const text = await response.text();
    const events = [...text.matchAll(/^data: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(events).toEqual(Array.from({ length: CHUNKS }, (_, i) => i));

    expect(kept.status).toBe("open");
    expect(kept.limits != null).toBe(true);
    expect(dialled()).toBe(0);
  }, 60_000);

  it("refuses the same call when the flag is unset (negative control)", async () => {
    const { live, node, kept } = await relayedMember();
    const remote = createRemote({ node });

    const call = remote(
      live.hubPeerId,
      new Request("http://hub.invalid/.well-known/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: await live.invite() }),
      }),
    );
    const error = await call.then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(PeerCallError);
    expect((error as PeerCallError).kind).toBe("limited-connection");
    expect(kept.limits != null).toBe(true);
  }, 60_000);
});

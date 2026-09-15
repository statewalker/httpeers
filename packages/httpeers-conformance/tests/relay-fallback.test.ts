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
 * limits would let the negative controls pass for the wrong reason and the
 * positive cases prove nothing.
 *
 * WHY THE STREAM IS CHECKED AGAINST THE KEPT CONNECTION. libp2p 3.3.8 does not
 * reuse a limited connection for a bare `/p2p/<id>` dial
 * (`findExistingConnection` keeps only `limits == null`), so "the request
 * worked" alone could mean a second circuit was dialled. The tests count
 * connections to the hub and look for the protocol stream on the one kept.
 *
 * SERVING AND CALLING ARE SEPARATE OPT-INS. The hub serves on limited
 * connections; the member only CALLS over them, and only to the hub. The last
 * two cases pin the member's half: its serving side stays closed to circuits,
 * and it is the serving flag -- nothing else -- that decides that.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Libp2p } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createMounts, PeerCallError } from "@statewalker/httpeers-core";
import {
  createRemote,
  type Peer,
  PROTOCOL,
  reachHubRelayed,
  type ServePeerInit,
  servePeer,
} from "@statewalker/httpeers-libp2p";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { hubHoldsCircuitTo, type Mesh, startMesh } from "./mesh-harness.js";

const CHUNKS = 20;

let mesh: Mesh | null = null;
let member: Libp2p | null = null;
let memberPeer: Peer | null = null;

afterEach(async () => {
  await memberPeer?.stop();
  memberPeer = null;
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

type Call = (peerId: string, request: Request) => Promise<Response>;

interface Relayed {
  live: Mesh;
  node: Libp2p;
  /** The member's own served peer, built from `peerInit`. Its `call` is what a member uses. */
  peer: Peer;
  kept: Connection;
  dialled: () => number;
}

/**
 * A hub serving on limited connections, a relay-only member serving `/hello`,
 * and that member's kept circuit. `peerInit` picks the member's opt-ins; the
 * hub id is passed in, because a member's predicate names its own hub.
 */
async function relayedMember(
  peerInit: (hubPeerId: string) => Partial<ServePeerInit> = (hub) => ({
    callOnLimitedConnection: (peerId) => peerId === hub,
  }),
): Promise<Relayed> {
  mesh = await startMesh({ serveOnLimitedConnection: true, extraMounts: { "/stream": sse } });
  member = await relayOnlyMember();
  const live = mesh;
  const node = member;

  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response("hello from the member"));
  memberPeer = await servePeer({ node, mounts, ...peerInit(live.hubPeerId) });

  const kept = await reachHubRelayed(node, live.relayAddr, live.hubPeerId);
  expect(kept.limits != null).toBe(true);

  let opened = 0;
  node.addEventListener("connection:open", (event) => {
    if (event.detail.remotePeer.toString() === live.hubPeerId) opened++;
  });
  return { live, node, peer: memberPeer, kept, dialled: () => opened };
}

function inviteRequest(id: string): Request {
  return new Request("http://hub.invalid/.well-known/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

/** Redeem a fresh invitation -- a bootstrap route, so no token is needed yet. */
async function redeem(call: Call, live: Mesh): Promise<string> {
  const response = await call(live.hubPeerId, inviteRequest(await live.invite()));
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

/** What `call` rejected with, or `null` if it answered. */
async function refusal(call: Promise<Response>): Promise<unknown> {
  return call.then(
    () => null,
    (err: unknown) => err,
  );
}

function connectionsTo(node: Libp2p, peerId: string): Connection[] {
  return node.getConnections().filter((c) => c.remotePeer.toString() === peerId);
}

describe("a member reaches its hub over a kept relay circuit", () => {
  it("answers a request over the limited connection, and leaves it open and limited", async () => {
    const { live, node, peer, kept, dialled } = await relayedMember();

    const token = await redeem(peer.call, live);
    const response = await peer.call(
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
    const { live, peer, kept, dialled } = await relayedMember();
    const token = await redeem(peer.call, live);

    const response = await peer.call(
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

  it("refuses the same call when the member did not opt in to calling (negative control)", async () => {
    const { live, node, kept } = await relayedMember(() => ({}));

    const error = await refusal(createRemote({ node })(live.hubPeerId, inviteRequest("unused")));
    expect(error).toBeInstanceOf(PeerCallError);
    expect((error as PeerCallError).kind).toBe("limited-connection");

    // A predicate is per target: one that allows some OTHER peer does not allow the hub.
    const narrow = createRemote({ node, callOnLimitedConnection: (peerId) => peerId === "other" });
    const narrowed = await refusal(narrow(live.hubPeerId, inviteRequest("unused")));
    expect((narrowed as PeerCallError).kind).toBe("limited-connection");

    expect(kept.limits != null).toBe(true);
  }, 60_000);

  it("keeps the member's serving side closed to the circuit it calls over", async () => {
    const { live, node } = await relayedMember();
    const hubEnd = await hubHoldsCircuitTo(live, node.peerId.toString());

    // The hub turns the same limited connection around and calls the member,
    // with the calling side opted in -- so only the MEMBER's serving flag stands
    // in the way.
    const fromHub = createRemote({ node: live.hubNode, callOnLimitedConnection: true });
    const error = await refusal(
      fromHub(node.peerId.toString(), new Request("http://member.invalid/hello")),
    );
    // The member's libp2p throws `LimitedConnectionError` on ITS side and aborts
    // the stream; all the hub sees is a stream that ended before a byte arrived,
    // which `mapPeerCallError` reads as a reset. That the refusal is the serving
    // flag and not something else is the next case's job.
    expect(error).toBeInstanceOf(PeerCallError);
    expect((error as PeerCallError).kind).toBe("stream-reset");
    expect(hubEnd.limits != null).toBe(true);
  }, 60_000);

  it("serves over the circuit only when the member opts in to serving (control for the case above)", async () => {
    const { live, node } = await relayedMember(() => ({ serveOnLimitedConnection: true }));
    const hubEnd = await hubHoldsCircuitTo(live, node.peerId.toString());

    const fromHub = createRemote({ node: live.hubNode, callOnLimitedConnection: true });
    const response = await fromHub(
      node.peerId.toString(),
      new Request("http://member.invalid/hello"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the member");
    expect(hubEnd.limits != null).toBe(true);
  }, 60_000);
});

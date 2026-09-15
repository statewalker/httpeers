/**
 * `startMember` falls back to a kept relay circuit when the WebRTC upgrade to
 * the hub fails -- the member half of the relay fallback, end to end.
 *
 * `relay-fallback.test.ts` proves the library can carry a call over a kept
 * circuit. This proves a member USES it with nobody telling it to: the same
 * `startMember` call a page makes, against a hub it cannot upgrade to, comes up
 * live, says so, and stays live.
 *
 * WHY A MEMBER WITH NO `webRTC()` TRANSPORT, and no `tcp()`: see
 * `relay-fallback.test.ts`. A member that could upgrade would pass over a
 * direct connection and prove nothing about the circuit.
 *
 * WHY THE FIRST HUB CALL IS TIMED. The route ensurer used to dial
 * `hubRoute(hub, hub)` before every edge call to the hub. With no unlimited
 * connection that dial is attempted every time, and against a real network it
 * costs up to libp2p's 10 s dial timeout before the call proceeds -- a member
 * that "works" but pays that per request. The dials are also recorded, so the
 * assertion does not depend on how fast a doomed dial happens to fail here.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createMounts } from "@statewalker/httpeers-core";
import { type MemberHandle, type MemberPlatform, startMember } from "@statewalker/httpeers-member";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  MESH_RULES,
  type Mesh,
  PRESENCE_TTL_MS,
  startMesh,
  testPlatform,
} from "./mesh-harness.js";

const KEEPALIVE_INTERVAL_MS = 1_000;

let mesh: Mesh | null = null;
const members: MemberHandle[] = [];

afterEach(async () => {
  while (members.length > 0)
    await members
      .pop()
      ?.stop()
      .catch(() => {});
  await mesh?.stop();
  mesh = null;
}, 30_000);

/** Every address `node.dial` was asked for, in order -- recorded on the instance the member uses. */
function recordDials(node: Libp2p): string[] {
  const dialled: string[] = [];
  const dial = node.dial.bind(node);
  node.dial = (async (target, options) => {
    for (const addr of Array.isArray(target) ? target : [target]) dialled.push(String(addr));
    return dial(target, options);
  }) as Libp2p["dial"];
  return dialled;
}

/** A platform whose node can reach the hub ONLY through the relay: no WebRTC, no TCP. */
function relayOnlyPlatform(): MemberPlatform & { dialled: () => string[] } {
  let dialled: string[] = [];
  return {
    async createNode({ privateKey }: { privateKey?: Ed25519PrivateKey }) {
      const node = await createLibp2p({
        ...(privateKey != null ? { privateKey } : {}),
        transports: [webSockets(), circuitRelayTransport()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionGater: { denyDialMultiaddr: async () => false },
        services: { identify: identify() },
      });
      dialled = recordDials(node);
      return node;
    },
    dialled: () => dialled,
  };
}

async function liveMesh(): Promise<Mesh> {
  mesh = await startMesh({
    serveOnLimitedConnection: true,
    extraMounts: { "/ping": async () => new Response("pong") },
  });
  return mesh;
}

async function join(
  live: Mesh,
  platform: MemberPlatform,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
): Promise<MemberHandle> {
  const member = await startMember({
    key: "peers",
    mounts: createMounts(),
    rules: MESH_RULES,
    config: { relayAddrs: [live.relayAddr], hubPeerId: live.hubPeerId },
    platform,
    invitationId: await live.invite(),
    heartbeatIntervalMs,
    keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
  });
  members.push(member);
  return member;
}

function openTo(node: Libp2p, peerId: string): Connection[] {
  return node
    .getConnections()
    .filter((c) => c.remotePeer.toString() === peerId && c.status === "open");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The hub's own verdict on whether `peerId` is online, after expiring stale presence. */
function onlineAtHub(live: Mesh, peerId: string): boolean {
  live.hub.sweep();
  return live.hub.meshView().members.find((m) => m.peerId === peerId)?.online === true;
}

describe("a member whose WebRTC upgrade to the hub fails", () => {
  it("joins over a kept relay circuit, says so, and calls the hub with no failed dial first", async () => {
    const live = await liveMesh();
    const platform = relayOnlyPlatform();
    const member = await join(live, platform);

    expect(member.joinedBy).toBe("redeemed");
    expect(live.hub.isMember(member.peerId)).toBe(true);
    expect(member.hubLink()).toBe("relay");

    const [kept, ...others] = openTo(member.node, live.hubPeerId);
    expect(others).toEqual([]);
    expect(kept?.limits != null).toBe(true);

    const before = platform.dialled().length;
    const started = Date.now();
    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    const elapsedMs = Date.now() - started;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
    console.info(`relay mode: first hub call took ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(5_000);

    // Nothing was dialled for the call -- in particular not `hubRoute(hub, hub)`.
    expect(platform.dialled().slice(before)).toEqual([]);
    expect(openTo(member.node, live.hubPeerId).map((c) => c.id)).toEqual([kept?.id]);
  }, 60_000);

  it("stays online at the hub on heartbeats over the circuit, which the keepalive leaves alone", async () => {
    const live = await liveMesh();
    const member = await join(live, relayOnlyPlatform());
    const [kept] = openTo(member.node, live.hubPeerId);

    // Past the presence TTL, so only heartbeats that actually landed keep it
    // online, and past several keepalive ticks, so a keepalive that closed or
    // replaced the circuit would show.
    await sleep(PRESENCE_TTL_MS + 3 * HEARTBEAT_INTERVAL_MS);

    expect(onlineAtHub(live, member.peerId)).toBe(true);
    expect(member.hubLink()).toBe("relay");
    expect(openTo(member.node, live.hubPeerId).map((c) => c.id)).toEqual([kept?.id]);
    expect(kept?.limits != null).toBe(true);
  }, 60_000);

  it("re-links over a new circuit when the kept one closes", async () => {
    const live = await liveMesh();
    // Heartbeats far apart, so the KEEPALIVE is what re-links. A heartbeat
    // finding no connection makes libp2p dial the hub from its peer store,
    // which also opens a circuit and would pass this for the wrong reason
    // (measured: it did).
    const member = await join(live, relayOnlyPlatform(), 60_000);
    const [kept] = openTo(member.node, live.hubPeerId);

    await kept?.close();

    let relinked: Connection | undefined;
    for (let attempt = 0; attempt < 100 && relinked == null; attempt++) {
      await sleep(100);
      relinked = openTo(member.node, live.hubPeerId)[0];
    }
    expect(relinked).toBeDefined();
    expect(relinked?.id).not.toBe(kept?.id);
    expect(relinked?.limits != null).toBe(true);
    expect(member.hubLink()).toBe("relay");

    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    expect(res.status).toBe(200);
  }, 60_000);
});

describe("a member whose WebRTC upgrade to the hub succeeds (control)", () => {
  it("reports a direct link, against the same hub", async () => {
    const live = await liveMesh();
    const member = await join(live, testPlatform);

    expect(member.hubLink()).toBe("direct");
    expect(openTo(member.node, live.hubPeerId).every((c) => c.limits == null)).toBe(true);

    const started = Date.now();
    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    console.info(`direct mode: first hub call took ${Date.now() - started} ms`);
    expect(res.status).toBe(200);
  }, 60_000);
});

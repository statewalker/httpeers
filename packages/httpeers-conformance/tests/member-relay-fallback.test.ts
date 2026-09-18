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
 *
 * TWO WAYS FOR THE UPGRADE TO FAIL. A member with no WebRTC transport cannot
 * even try it. A WebRTC-CAPABLE member -- what a page is -- tries, against a
 * hub with no WebRTC transport, and fails at signalling. Neither is a real ICE
 * timeout (seconds, not milliseconds), but the second is the member a browser
 * actually runs, and the one that can leave a signalling circuit behind.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createMounts, PeerCallError } from "@statewalker/httpeers-core";
import { createRemote } from "@statewalker/httpeers-libp2p";
import { type MemberHandle, type MemberPlatform, startMember } from "@statewalker/httpeers-member";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  hubHoldsCircuitTo,
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

type RecordingPlatform = MemberPlatform & { dialled: () => string[] };

/** A platform whose node can reach the hub ONLY through the relay: no WebRTC, no TCP. */
function relayOnlyPlatform(): RecordingPlatform {
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

/**
 * A platform whose node is a PAGE's: webSockets + webRTC + circuitRelay,
 * listening on `/webrtc` only (`browser-profile.ts`). No TCP, so nothing
 * unlimited can reach the hub except a WebRTC upgrade.
 */
function webRTCCapablePlatform(): RecordingPlatform {
  let dialled: string[] = [];
  return {
    async createNode({ privateKey }: { privateKey?: Ed25519PrivateKey }) {
      const node = await createLibp2p({
        ...(privateKey != null ? { privateKey } : {}),
        addresses: { listen: ["/webrtc"] },
        transports: [webSockets(), webRTC(), circuitRelayTransport()],
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

async function liveMesh(init: { webRTCUpgrade?: boolean } = {}): Promise<Mesh> {
  mesh = await startMesh({
    ...init,
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
  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response("hello from the member"));
  const member = await startMember({
    key: "peers",
    mounts,
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

  it("re-links over a new circuit ONLY when the kept one closes -- no WebRTC retry", async () => {
    const live = await liveMesh({ webRTCUpgrade: false });
    // Heartbeats far apart, so the KEEPALIVE is what re-links. A heartbeat
    // finding no connection makes libp2p dial the hub from its peer store,
    // which also opens a circuit and would pass this for the wrong reason
    // (measured: it did).
    const platform = webRTCCapablePlatform();
    const member = await join(live, platform, 60_000);
    expect(member.hubLink()).toBe("relay");
    // Every circuit to the hub, the signalling one included, so that the
    // re-link has nothing left to lean on.
    const before = openTo(member.node, live.hubPeerId);
    const dialsBefore = platform.dialled().length;
    await Promise.all(before.map((c) => c.close()));

    let relinked: Connection | undefined;
    for (let attempt = 0; attempt < 100 && relinked == null; attempt++) {
      await sleep(100);
      relinked = openTo(member.node, live.hubPeerId)[0];
    }
    expect(relinked).toBeDefined();
    expect(before.map((c) => c.id)).not.toContain(relinked?.id);
    expect(relinked?.limits != null).toBe(true);
    expect(member.hubLink()).toBe("relay");

    // THE MEMBER IS WEBRTC-CAPABLE, so this is a choice and not an inability:
    // the re-link dialled the circuit, and never the upgrade.
    const relinkDials = platform.dialled().slice(dialsBefore);
    expect(relinkDials).toContain(`${live.relayAddr}/p2p-circuit/p2p/${live.hubPeerId}`);
    expect(relinkDials.filter((addr) => addr.includes("/webrtc"))).toEqual([]);

    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    expect(res.status).toBe(200);
  }, 60_000);
});

describe("a relay-mode member's serving side", () => {
  it("refuses a call the hub turns around over the circuit", async () => {
    const live = await liveMesh();
    const member = await join(live, relayOnlyPlatform());
    expect(member.hubLink()).toBe("relay");
    const hubEnd = await hubHoldsCircuitTo(live, member.peerId);

    // The hub opts in to CALLING over limited connections, so only the
    // member's serving side stands in the way -- and `startMember` never opens
    // it. `relay-fallback.test.ts` has the control where a served peer opts in.
    const fromHub = createRemote({ node: live.hubNode, callOnLimitedConnection: true });
    const error = await fromHub(member.peerId, new Request("http://member.invalid/hello")).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(PeerCallError);
    expect((error as PeerCallError).kind).toBe("stream-reset");
    expect(hubEnd.limits != null).toBe(true);

    // Refusing the hub's call cost the member nothing: its own calls still work.
    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    expect(res.status).toBe(200);
  }, 60_000);
});

describe("a WebRTC-capable member against a hub it cannot upgrade to", () => {
  it("falls back to the relay and keeps calling the hub", async () => {
    const live = await liveMesh({ webRTCUpgrade: false });
    const platform = webRTCCapablePlatform();

    const started = Date.now();
    const member = await join(live, platform);
    const joinMs = Date.now() - started;
    expect(member.hubLink()).toBe("relay");

    const open = openTo(member.node, live.hubPeerId);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((c) => c.limits != null)).toBe(true);

    const calls: number[] = [];
    for (let i = 0; i < 5; i++) {
      const callStarted = Date.now();
      const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("pong");
      calls.push(Date.now() - callStarted);
    }

    const after = openTo(member.node, live.hubPeerId);
    console.info(
      `webrtc-capable member, no upgrade: join ${joinMs} ms; ` +
        `limited connections to the hub after join ${open.length}, after 5 calls ${after.length}; ` +
        `calls ${calls.join("/")} ms; ` +
        `dials ${JSON.stringify(platform.dialled().map((a) => a.replace(/\/p2p\/12D3KooW\w+/g, "/p2p/<id>")))}`,
    );
    expect(calls.every((ms) => ms < 5_000)).toBe(true);
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

/**
 * `startMember` falls back to relay mode when the hub REFUSES THE RESERVATION
 * after a direct link came up -- and a real hub's refusals read as what they are.
 *
 * THE PRODUCTION FAILURE THIS PINS. A hub's relay grants a bounded number of
 * reservations (libp2p's default: 15, each held 2 h). Once they were spent, a
 * page that resumed over WebRTC had its reservation refused with
 * `RESERVATION_REFUSED`, and `startMember` failed the WHOLE join -- "Could not
 * join" -- while the same page, had its WebRTC upgrade failed instead, would
 * have come up in relay mode and worked. The reservation is what lets OTHER
 * members reach this one; nothing this member does itself needs it.
 *
 * WHY A PAGE-SHAPED MEMBER (webSockets + webRTC + circuitRelay, no TCP): that
 * is the member that failed, and with no TCP nothing unlimited can reach the
 * hub except the WebRTC upgrade -- so "every connection to the hub is limited"
 * is a statement about what `startMember` did, not about the loopback.
 *
 * WHY `maxRelayReservations: 1` AND TWO MEMBERS rather than a store of 0: the
 * first member takes the only slot the way a real one would, so the second is
 * refused for exactly the production reason -- a full store -- by a hub that
 * is otherwise working.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createMounts } from "@statewalker/httpeers-core";
import {
  dialRelay,
  HubReservationError,
  reachHub,
  reserveOnHub,
} from "@statewalker/httpeers-libp2p";
import {
  type MemberHandle,
  type MemberPlatform,
  type MemberState,
  startMember,
} from "@statewalker/httpeers-member";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { MESH_RULES, type Mesh, startMesh } from "./mesh-harness.js";

let mesh: Mesh | null = null;
const members: MemberHandle[] = [];
const nodes: Libp2p[] = [];

afterEach(async () => {
  while (members.length > 0)
    await members
      .pop()
      ?.stop()
      .catch(() => {});
  while (nodes.length > 0) await Promise.resolve(nodes.pop()?.stop()).catch(() => {});
  await mesh?.stop();
  mesh = null;
}, 30_000);

/** A page's node (`browser-profile.ts`): listens on `/webrtc` only, every address `dial`led is recorded. */
async function pageNode(
  privateKey?: Ed25519PrivateKey,
): Promise<{ node: Libp2p; dialled: string[] }> {
  const node = await createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    addresses: { listen: ["/webrtc"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: async () => false },
    services: { identify: identify() },
  });
  const dialled: string[] = [];
  const dial = node.dial.bind(node);
  node.dial = (async (target, options) => {
    for (const addr of Array.isArray(target) ? target : [target]) dialled.push(String(addr));
    return dial(target, options);
  }) as Libp2p["dial"];
  return { node, dialled };
}

type PagePlatform = MemberPlatform & { dialled: () => string[] };

function pagePlatform(): PagePlatform {
  let dialled: string[] = [];
  return {
    async createNode({ privateKey }) {
      const page = await pageNode(privateKey);
      dialled = page.dialled;
      return page.node;
    },
    dialled: () => dialled,
  };
}

async function fullMesh(): Promise<Mesh> {
  mesh = await startMesh({
    serveOnLimitedConnection: true,
    maxRelayReservations: 1,
    extraMounts: { "/ping": async () => new Response("pong") },
  });
  return mesh;
}

async function join(
  live: Mesh,
  platform: MemberPlatform,
  init: { onState?: (state: MemberState) => void; heartbeatIntervalMs?: number } = {},
): Promise<MemberHandle> {
  const member = await startMember({
    key: "peers",
    mounts: createMounts(),
    rules: MESH_RULES,
    config: { relayAddrs: [live.relayAddr], hubPeerId: live.hubPeerId },
    platform,
    invitationId: await live.invite(),
    heartbeatIntervalMs: init.heartbeatIntervalMs,
    keepaliveIntervalMs: 1_000,
    onState: init.onState,
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

describe("a member whose hub refuses the reservation after a direct link", () => {
  it("joins in relay mode, says why, and calls the hub over a kept circuit", async () => {
    const live = await fullMesh();
    const first = await join(live, pagePlatform());
    expect(first.hubLink()).toBe("direct"); // took the only slot
    expect(first.hubLinkNote).toBeUndefined();

    const states: MemberState[] = [];
    const member = await join(live, pagePlatform(), { onState: (s) => states.push(s) });

    expect(member.joinedBy).toBe("redeemed");
    expect(live.hub.isMember(member.peerId)).toBe(true);
    // It DID get as far as asking: the fallback is from the reservation, not the upgrade.
    expect(states).toContain("awaiting-reservation");
    expect(states.at(-1)).toBe("ready");
    expect(member.hubLink()).toBe("relay");
    // The reason, from the real hub's real refusal.
    expect(member.hubLinkNote).toContain("RESERVATION_REFUSED");
    expect(member.hubLinkNote).toContain("reservation store is full");
    expect(member.hubLinkNote).not.toContain("not a member");

    // THE SAME STATE AS A MEMBER THAT FELL BACK AT THE UPGRADE: the WebRTC
    // link is gone, one kept circuit is the data path, on both ends -- so the
    // hub reports this member as `relay` too.
    const toHub = openTo(member.node, live.hubPeerId);
    expect(toHub.length).toBeGreaterThan(0);
    expect(toHub.every((c) => c.limits != null)).toBe(true);
    expect(openTo(live.hubNode, member.peerId).every((c) => c.limits != null)).toBe(true);
    // `leaveRelay` was not called: the circuit runs through the relay.
    expect(openTo(member.node, live.relayAddr.split("/p2p/").at(-1) ?? "").length).toBe(1);

    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");

    // The member that holds the slot is untouched.
    const firstRes = await first.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    expect(firstRes.status).toBe(200);
  }, 60_000);

  it("re-links over a circuit only: no reservation supervisor was left running", async () => {
    const live = await fullMesh();
    await join(live, pagePlatform());
    const platform = pagePlatform();
    // Heartbeats far apart, so the KEEPALIVE is what re-links (see
    // `member-relay-fallback.test.ts` for why a heartbeat would mislead).
    const member = await join(live, platform, { heartbeatIntervalMs: 60_000 });
    expect(member.hubLink()).toBe("relay");

    const before = openTo(member.node, live.hubPeerId);
    const dialsBefore = platform.dialled().length;
    await Promise.all(before.map((c) => c.close()));

    let relinked: Connection | undefined;
    for (let attempt = 0; attempt < 100 && relinked == null; attempt++) {
      await sleep(100);
      relinked = openTo(member.node, live.hubPeerId)[0];
    }
    expect(relinked).toBeDefined();
    expect(relinked?.limits != null).toBe(true);

    // A running `superviseHubReservation` would have answered the lost link
    // with `reachHub` -- a `/webrtc` dial. Give it time to show.
    await sleep(2_000);
    const relinkDials = platform.dialled().slice(dialsBefore);
    expect(relinkDials).toContain(`${live.relayAddr}/p2p-circuit/p2p/${live.hubPeerId}`);
    expect(relinkDials.filter((addr) => addr.includes("/webrtc"))).toEqual([]);
    expect(member.hubLink()).toBe("relay");

    const res = await member.fetch(new Request(`http://local/peers/${live.hubPeerId}/ping`));
    expect(res.status).toBe(200);
  }, 60_000);
});

describe("reserveOnHub against a real hub", () => {
  it("a stranger is told it is not a member (PERMISSION_DENIED), not that the store is full", async () => {
    mesh = await startMesh();
    const { node } = await pageNode();
    nodes.push(node);
    await dialRelay(node, mesh.relayAddr);
    await reachHub(node, mesh.relayAddr, mesh.hubPeerId);

    const err = await reserveOnHub(node, mesh.hubPeerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubReservationError);
    expect((err as HubReservationError).status).toBe("PERMISSION_DENIED");
    expect((err as HubReservationError).refusal).toBe("not-a-member");
    expect((err as Error).message).toContain("not a member");
    expect((err as Error).message).not.toContain("full");
  }, 60_000);
});

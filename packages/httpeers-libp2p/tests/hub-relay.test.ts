/**
 * The hub's relay reservations: how many it grants, and when it lets them go.
 *
 * THE PRODUCTION FAILURE THIS PINS. libp2p's relay server holds at most 15
 * reservations by default, for two hours each, and does not drop one when its
 * holder disconnects. A hub built on those defaults filled up after fifteen
 * distinct peers in two hours (test runs, revoked members, a member whose page
 * was reopened) and then refused EVERY member with `RESERVATION_REFUSED` --
 * which `startMember` reports as a failed join.
 *
 * Nothing is stubbed: a real hub node with the real relay service and the real
 * membership gater, and real member nodes reserving on it over TCP through the
 * same `reserveOnHub` a member calls.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { reserveOnHub } from "../src/hub-link.js";
import {
  HUB_MAX_RESERVATIONS,
  type HubRelayServiceInit,
  hubRelayService,
  membershipGater,
  releaseReservation,
} from "../src/hub-relay.js";
import { generateKey } from "../src/identity.js";

/** libp2p's `DEFAULT_MAX_RESERVATION_STORE_SIZE`: the ceiling production hit. */
const LIBP2P_DEFAULT_MAX_RESERVATIONS = 15;

const started: Libp2p[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.stop()));
});

async function hubNode(members: Set<string>, init?: HubRelayServiceInit) {
  const node = await createLibp2p({
    privateKey: await generateKey(),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    // Every member here dials from 127.0.0.1, and libp2p rate-limits inbound
    // connections per address (5/s). In production each member has its own.
    connectionManager: { inboundConnectionThreshold: 1_000 },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: membershipGater(() => (peerId) => members.has(peerId)),
    services: { identify: identify(), relay: hubRelayService(init) },
  });
  started.push(node);
  return node;
}

async function memberNode(): Promise<Libp2p> {
  const node = await createLibp2p({
    privateKey: await generateKey(),
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  started.push(node);
  return node;
}

/** A member dials the hub and reserves on it, the way `startMember` does. */
async function reserve(hub: Libp2p, member: Libp2p): Promise<string> {
  await member.dial(hub.getMultiaddrs()[0]);
  return reserveOnHub(member, hub.peerId.toString());
}

/** Resolves once `check` holds; the hub learns of a hang-up asynchronously. */
async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("hubRelayService reservations", () => {
  it(`grants more than libp2p's default ${LIBP2P_DEFAULT_MAX_RESERVATIONS} reservations to members`, async () => {
    const members = new Set<string>();
    const hub = await hubNode(members);
    const nodes = await Promise.all(
      Array.from({ length: LIBP2P_DEFAULT_MAX_RESERVATIONS + 5 }, () => memberNode()),
    );
    for (const node of nodes) members.add(node.peerId.toString());

    // Every one still connected -- so this measures the store's size, not its
    // clean-up.
    const refused: string[] = [];
    for (const node of nodes) {
      await reserve(hub, node).catch((error: unknown) => refused.push(String(error)));
    }
    expect(refused).toEqual([]);
    expect(hub.services.relay.reservations.size).toBe(nodes.length);
  }, 60_000);

  it("sizes the store deliberately, and lets a caller choose the size", async () => {
    expect(HUB_MAX_RESERVATIONS).toBeGreaterThan(LIBP2P_DEFAULT_MAX_RESERVATIONS);

    const members = new Set<string>();
    const hub = await hubNode(members, { maxReservations: 1 });
    const [first, second] = [await memberNode(), await memberNode()];
    members.add(first.peerId.toString());
    members.add(second.peerId.toString());

    await reserve(hub, first);
    await expect(reserve(hub, second)).rejects.toThrow(/RESERVATION_REFUSED/);
  }, 30_000);

  it("releases a reservation when its holder disconnects", async () => {
    const members = new Set<string>();
    // ONE slot: a reservation that outlived its holder would refuse the next.
    const hub = await hubNode(members, { maxReservations: 1 });
    const first = await memberNode();
    members.add(first.peerId.toString());
    await reserve(hub, first);
    expect(hub.services.relay.reservations.has(first.peerId)).toBe(true);

    await first.stop();
    await eventually(() => !hub.services.relay.reservations.has(first.peerId));

    const second = await memberNode();
    members.add(second.peerId.toString());
    await expect(reserve(hub, second)).resolves.toContain(hub.peerId.toString());
  }, 30_000);

  it("keeps the reservation of a holder that is still connected another way", async () => {
    const members = new Set<string>();
    const hub = await hubNode(members);
    const member = await memberNode();
    members.add(member.peerId.toString());
    await reserve(hub, member);

    // A second connection, then close the first: the peer never went away.
    const [firstConnection] = hub.getConnections(member.peerId);
    await member.dial(hub.getMultiaddrs()[0], { force: true });
    await eventually(() => hub.getConnections(member.peerId).length >= 2);
    await firstConnection?.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hub.getConnections(member.peerId).length).toBeGreaterThan(0);
    expect(hub.services.relay.reservations.has(member.peerId)).toBe(true);
  }, 30_000);

  it("releases a revoked member's reservation, and the gater refuses a new one", async () => {
    const members = new Set<string>();
    const hub = await hubNode(members, { maxReservations: 1 });
    const revoked = await memberNode();
    members.add(revoked.peerId.toString());
    await reserve(hub, revoked);

    // What the daemon's revoke does: out of the member store, then released.
    members.delete(revoked.peerId.toString());
    expect(releaseReservation(hub.services.relay, revoked.peerId.toString())).toBe(true);
    expect(hub.services.relay.reservations.has(revoked.peerId)).toBe(false);
    // Idempotent: nothing left to release.
    expect(releaseReservation(hub.services.relay, revoked.peerId.toString())).toBe(false);
    // And a subject that is not a peer id holds nothing, rather than throwing.
    expect(releaseReservation(hub.services.relay, "not-a-peer-id")).toBe(false);

    // No way back in. (Over a fresh connection: on the old one the member's
    // own libp2p still believes in the reservation and would not ask.)
    await revoked.hangUp(hub.peerId);
    await expect(reserve(hub, revoked)).rejects.toThrow(/PERMISSION_DENIED/);

    // And the slot it held is free for a member.
    const member = await memberNode();
    members.add(member.peerId.toString());
    await expect(reserve(hub, member)).resolves.toContain(hub.peerId.toString());
  }, 30_000);
});

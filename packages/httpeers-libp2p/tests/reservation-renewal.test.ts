/**
 * THE INCIDENT, REPRODUCED AGAINST A REAL RELAY.
 *
 * 2026-09-19: the server hub had been up since the previous evening, its
 * websocket to `relay.httpeers.net` was still ESTABLISHED, and the relay held
 * NO reservation for it. Members got
 * `InvalidMessageError: failed to connect via relay with status NO_RESERVATION`,
 * and nothing repaired it -- because `superviseRelay` decided "am I reserved?"
 * from `node.getMultiaddrs()`, which is the hub's own belief and stays true
 * for as long as the hub's transport reservation store holds an entry. A
 * restart fixed it.
 *
 * So this suite drops the reservation ON THE RELAY, leaving the connection
 * open, and requires the hub to notice and come back. Nothing is stubbed: a
 * real `circuitRelayServer` over TCP, a real hub node holding a real
 * reservation through the real transport. `releaseReservation` is how a test
 * reaches the server's store -- the same call the hub daemon uses to free a
 * revoked member's slot (`hub-relay.ts`).
 *
 * THE FIRST TEST IS THE MEASUREMENT THAT MATTERS: it asserts that
 * `getMultiaddrs()` STILL reports the circuit address after the relay has
 * forgotten the reservation. That is the incident's whole shape, and it is
 * why the local address list cannot be the thing that decides.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  type CircuitRelayService,
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { releaseReservation } from "../src/hub-relay.js";
import { generateKey } from "../src/identity.js";
import { dialRelay, superviseRelay, waitForCircuitReservation } from "../src/reservation.js";

/**
 * Long enough that libp2p's OWN refresh timer (expiry minus five minutes,
 * floored at thirty seconds) never fires inside a test: whatever repairs the
 * reservation here has to be ours.
 */
const RESERVATION_TTL_MS = 30 * 60_000;

/** The renewal cadence under test. Production derives it from the relay's TTL. */
const TEST_RENEWAL_INTERVAL_MS = 250;

const started: Libp2p[] = [];
const stopping: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stopping.splice(0)) stop();
  await Promise.all(started.splice(0).map((node) => node.stop()));
});

async function relayNode(): Promise<Libp2p<{ relay: CircuitRelayService }>> {
  const node = await createLibp2p({
    privateKey: await generateKey(),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), relay: relayService() },
  });
  started.push(node);
  return node as unknown as Libp2p<{ relay: CircuitRelayService }>;
}

function relayService() {
  return circuitRelayServer({
    reservations: {
      maxReservations: 64,
      reservationTtl: RESERVATION_TTL_MS,
      applyDefaultLimit: true,
    },
  });
}

/** A hub-shaped node: it reserves on a relay it DISCOVERS, exactly as `apps/hub` does. */
async function hubNode(): Promise<Libp2p> {
  const node = await createLibp2p({
    privateKey: await generateKey(),
    addresses: { listen: ["/p2p-circuit"] },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  started.push(node);
  return node;
}

async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Reserved {
  relay: Awaited<ReturnType<typeof relayNode>>;
  hub: Libp2p;
  relayAddr: string;
  /** Does the RELAY hold a reservation for the hub right now? */
  relayHolds(): boolean;
  /** Does the HUB believe it is reserved -- the old, blind check? */
  hubBelieves(): boolean;
  /** The ids of the hub's live connections to the relay, to prove none was closed. */
  connectionIds(): string[];
}

/** A hub with a real, relay-granted reservation. */
async function reserved(): Promise<Reserved> {
  const relay = await relayNode();
  const hub = await hubNode();
  const relayAddr = `${relay.getMultiaddrs()[0].toString()}`;
  await dialRelay(hub, relayAddr);
  await waitForCircuitReservation(hub);
  return {
    relay,
    hub,
    relayAddr,
    relayHolds: () => relay.services.relay.reservations.get(hub.peerId) != null,
    hubBelieves: () => hub.getMultiaddrs().some((addr) => addr.toString().includes("/p2p-circuit")),
    connectionIds: () => hub.getConnections(relay.peerId).map((c) => c.id),
  };
}

describe("a reservation lost on the relay, with the connection still up", () => {
  it("leaves the hub's own address list saying 'reserved' -- the incident", async () => {
    const mesh = await reserved();
    expect(mesh.relayHolds()).toBe(true);
    expect(mesh.hubBelieves()).toBe(true);

    expect(releaseReservation(mesh.relay.services.relay, mesh.hub.peerId)).toBe(true);

    // The relay has forgotten it. The connection is untouched, and so is
    // everything the hub can see locally.
    expect(mesh.relayHolds()).toBe(false);
    expect(mesh.connectionIds().length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mesh.hubBelieves()).toBe(true);
  }, 60_000);

  it("is detected and restored by the supervisor, without closing the connection", async () => {
    const mesh = await reserved();
    const before = mesh.connectionIds();
    expect(before.length).toBeGreaterThan(0);

    const supervisor = superviseRelay({
      node: mesh.hub,
      relayAddr: mesh.relayAddr,
      renewalIntervalMs: TEST_RENEWAL_INTERVAL_MS,
      log: () => {},
    });
    stopping.push(() => supervisor.stop());

    expect(releaseReservation(mesh.relay.services.relay, mesh.hub.peerId)).toBe(true);
    expect(mesh.relayHolds()).toBe(false);

    await eventually(() => mesh.relayHolds());

    // THE CONNECTION NEVER WENT DOWN. A supervisor that repaired this by
    // hanging up and redialling would pass the line above while dropping every
    // member's circuit, which is the failure mode this whole design avoids.
    expect(mesh.connectionIds()).toEqual(before);
  }, 60_000);

  it("reports the loss and the recovery in its state", async () => {
    const mesh = await reserved();
    const supervisor = superviseRelay({
      node: mesh.hub,
      relayAddr: mesh.relayAddr,
      renewalIntervalMs: TEST_RENEWAL_INTERVAL_MS,
      log: () => {},
    });
    stopping.push(() => supervisor.stop());

    // `verifiedAt`, not `status`: the supervisor starts in `reserved` because
    // its contract is to be started once a reservation has landed. What this
    // waits for is the RELAY having said so.
    await eventually(() => supervisor.state().verifiedAt != null);
    const confirmed = supervisor.state();
    expect(confirmed.status).toBe("reserved");
    expect(confirmed.relayPeerId).toBe(mesh.relay.peerId.toString());
    expect(confirmed.expiresAt).toBeGreaterThan(Date.now());
    expect(confirmed.lostSince).toBeNull();

    releaseReservation(mesh.relay.services.relay, mesh.hub.peerId);
    await eventually(() => mesh.relayHolds());
    expect(supervisor.state().renewals).toBeGreaterThan(0);
    expect(supervisor.state().consecutiveFailures).toBe(0);
  }, 60_000);
});

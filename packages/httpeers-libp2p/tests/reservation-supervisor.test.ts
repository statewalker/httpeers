/**
 * The supervisor's state machine, on a clock this test owns.
 *
 * WHAT IS FAKED AND WHAT IS NOT. The relay is faked -- that is the point: the
 * cases here are "the relay says no" and "the relay cannot be reached", which
 * a real relay will not produce on demand. The state machine, the cadence, the
 * jitter and the logging are the real ones. The real relay lives next door in
 * `reservation-renewal.test.ts`, where the incident is reproduced end to end;
 * neither suite is sufficient alone and each says so.
 *
 * THE ASYMMETRY THIS FILE EXISTS TO PIN. A circuit address that is PRESENT
 * must never make the supervisor say "reserved" -- that belief is exactly what
 * was true, and wrong, for hours during the 2026-09-19 incident. A circuit
 * address that has GONE is still proof of a loss. Two directions, one field,
 * and getting them the same way round again would restore the bug.
 */

import type { Libp2p } from "@libp2p/interface";
import { describe, expect, it } from "vitest";
import type { RelayReservationGrant } from "../src/hop-reserve.js";
import {
  DEFAULT_RENEWAL_INTERVAL_MS,
  MAX_RENEWAL_INTERVAL_MS,
  MIN_RENEWAL_INTERVAL_MS,
  RESERVATION_LOSS_GRACE_MS,
  type RelayLog,
  type RelayReservationEvent,
  renewalDelayMs,
  renewalIntervalMs,
  reservationHealthy,
  superviseRelay,
} from "../src/reservation.js";
import type { Timers } from "../src/timers.js";

const RELAY_PEER_ID = "12D3KooWRelayFakeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RELAY_ADDR = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${RELAY_PEER_ID}`;
const CIRCUIT_ADDR = `${RELAY_ADDR}/p2p-circuit/p2p/12D3KooWSelfFakeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

/**
 * A clock the test advances by hand.
 *
 * Not vitest's fake timers: this supervisor takes its timers through the
 * `Timers` seam precisely so that a browser can pass `worker-timers` later,
 * and a test that reached past the seam to patch the globals would prove the
 * seam is unused. `now` moves with the clock, so `lostSince` and the grace
 * period are measured on the same time line as the scheduling.
 */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; every: number | null; run: () => void }>();

  const timers: Timers = {
    setTimeout(handler, delayMs) {
      const id = nextId++;
      pending.set(id, { at: now + delayMs, every: null, run: handler });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") pending.delete(handle);
    },
    setInterval(handler, delayMs) {
      const id = nextId++;
      pending.set(id, { at: now + delayMs, every: delayMs, run: handler });
      return id;
    },
    clearInterval(handle) {
      if (typeof handle === "number") pending.delete(handle);
    },
  };

  return {
    timers,
    now: () => now,
    /** Move the clock, firing everything due, then let queued promises settle. */
    async advance(byMs: number): Promise<void> {
      const until = now + byMs;
      for (;;) {
        let dueId: number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of pending) {
          if (entry.at <= until && entry.at < dueAt) {
            dueAt = entry.at;
            dueId = id;
          }
        }
        if (dueId == null) break;
        const entry = pending.get(dueId);
        if (entry == null) break;
        now = dueAt;
        if (entry.every != null) entry.at = now + entry.every;
        else pending.delete(dueId);
        entry.run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

/** Let every already-queued microtask and `await` chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface FakeNode {
  node: Libp2p;
  /** What `getMultiaddrs()` reports. Set to `[]` to mean "libp2p dropped the reservation". */
  addrs: string[];
  emit(event: string): void;
  dials: number;
}

function fakeNode(addrs: string[] = [CIRCUIT_ADDR]): FakeNode {
  const listeners = new Map<string, Array<() => void>>();
  const state: FakeNode = {
    addrs: [...addrs],
    dials: 0,
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    node: {
      getMultiaddrs: () => state.addrs.map((a) => ({ toString: () => a })),
      addEventListener: (event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      removeEventListener: (event: string, listener: () => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== listener),
        );
      },
      dial: async () => {
        state.dials++;
        return {};
      },
    } as unknown as Libp2p,
  };
  return state;
}

function recorder(): { log: RelayLog; events: RelayReservationEvent[]; lines: string[] } {
  const events: RelayReservationEvent[] = [];
  const lines: string[] = [];
  return {
    events,
    lines,
    log: (message, detail) => {
      lines.push(message);
      events.push(detail.event);
    },
  };
}

const granting = (ttlMs: number) => {
  let calls = 0;
  const verify = async (): Promise<RelayReservationGrant> => {
    calls++;
    return { expiresAt: Date.now() + ttlMs, ttlMs };
  };
  return { verify, calls: () => calls };
};

describe("renewalIntervalMs", () => {
  it("is a quarter of the TTL the relay reported", () => {
    // The relay this project runs: two hours (apps/relay/src/limits.ts).
    expect(renewalIntervalMs(2 * 60 * 60_000)).toBe(30 * 60_000);
    expect(renewalIntervalMs(40 * 60_000)).toBe(10 * 60_000);
  });

  it("never stretches past half an hour, however long the TTL", () => {
    expect(renewalIntervalMs(24 * 60 * 60_000)).toBe(MAX_RENEWAL_INTERVAL_MS);
  });

  it("never drops below a minute, however short the TTL", () => {
    expect(renewalIntervalMs(5_000)).toBe(MIN_RENEWAL_INTERVAL_MS);
  });

  it.each([[null], [undefined], [0], [-1]])(
    "falls back to the blind interval when the relay said %s",
    (ttl) => {
      expect(renewalIntervalMs(ttl)).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
    },
  );
});

describe("renewalDelayMs", () => {
  it("jitters into the interval's upper quarter, never past it", () => {
    expect(renewalDelayMs(30 * 60_000, () => 0)).toBe(22.5 * 60_000);
    expect(renewalDelayMs(30 * 60_000, () => 1)).toBe(30 * 60_000);
    // Against the two-hour TTL this is the 22.5-30 minute band the design
    // asks for, and it can never exceed the quarter-TTL deadline itself.
    expect(renewalDelayMs(30 * 60_000, () => 0.5)).toBeLessThanOrEqual(30 * 60_000);
  });
});

describe("reservationHealthy", () => {
  it("is true while reserved", () => {
    expect(reservationHealthy({ status: "reserved", lostSince: null })).toBe(true);
  });

  it("stays true inside the grace period and flips after it", () => {
    const lostSince = 1_000_000;
    expect(
      reservationHealthy({ status: "lost", lostSince }, RESERVATION_LOSS_GRACE_MS, lostSince + 1),
    ).toBe(true);
    expect(
      reservationHealthy(
        { status: "lost", lostSince },
        RESERVATION_LOSS_GRACE_MS,
        lostSince + RESERVATION_LOSS_GRACE_MS,
      ),
    ).toBe(false);
  });

  it("is false once stopped", () => {
    expect(reservationHealthy({ status: "stopped", lostSince: null })).toBe(false);
  });
});

describe("superviseRelay", () => {
  it("renews on the schedule the relay's TTL implies", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    const relay = granting(2 * 60 * 60_000);
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: relay.verify,
      timers: clock.timers,
      now: clock.now,
      // The jitter's top of range: the longest the supervisor may ever wait.
      random: () => 1,
      log: () => {},
    });

    // The first request is prompt, so the cadence can be derived from a real
    // TTL rather than guessed at.
    await clock.advance(1_000);
    expect(relay.calls()).toBe(1);
    expect(supervisor.state().verifiedAt).toBe(clock.now());

    // Then every thirty minutes -- a quarter of the two-hour TTL.
    await clock.advance(29 * 60_000);
    expect(relay.calls()).toBe(1);
    await clock.advance(60_000);
    expect(relay.calls()).toBe(2);
    expect(supervisor.state().renewals).toBe(2);
    supervisor.stop();
  });

  it("does NOT decide 'reserved' from the address list: the relay refusing is a loss", async () => {
    const clock = fakeClock();
    // The incident's shape exactly: the circuit address is there the whole
    // time, and it means nothing.
    const node = fakeNode([CIRCUIT_ADDR]);
    const log = recorder();
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: async () => {
        throw new Error("reservation failed with status NO_RESERVATION");
      },
      restore: async () => {
        /* a restore that "works" locally and changes nothing at the relay */
      },
      renewalIntervalMs: 1_000,
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      log: log.log,
    });

    await clock.advance(1_500);
    expect(node.addrs).toEqual([CIRCUIT_ADDR]);
    expect(supervisor.state().status).toBe("lost");
    expect(supervisor.state().lostSince).not.toBeNull();
    expect(supervisor.state().lastError).toContain("NO_RESERVATION");
    expect(log.events).toContain("renewal-failed");
    expect(log.events).toContain("lost");
    supervisor.stop();
  });

  it("backs off, and keeps `lostSince` at the FIRST loss across repeated failures", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: async () => {
        throw new Error("relay unreachable");
      },
      restore: async () => {
        throw new Error("dial failed");
      },
      // The production cadence, so what this measures is the RESTORE backoff
      // and nothing else. (A renewal that fires while a restore is backing off
      // is one extra failed request every half hour -- real, and negligible
      // next to the retry it sits beside.)
      renewalIntervalMs: 30 * 60_000,
      minRetryDelayMs: 1_000,
      maxRetryDelayMs: 30_000,
      checkIntervalMs: 10_000,
      timers: clock.timers,
      now: clock.now,
      random: () => 1,
      log: () => {},
    });

    await clock.advance(30 * 60_000);
    const firstLoss = supervisor.state().lostSince;
    expect(firstLoss).not.toBeNull();

    await clock.advance(120_000);
    const state = supervisor.state();
    expect(state.status).toBe("lost");
    // A loss that is still a loss is one outage, not many: the health signal
    // measures how long the hub has been unreachable, so this must not creep.
    expect(state.lostSince).toBe(firstLoss);
    expect(state.consecutiveFailures).toBeGreaterThan(1);
    // Backoff, not a hot loop: the retries double to a 30 s ceiling, so two
    // minutes cannot hold more than a handful of them.
    expect(state.consecutiveFailures).toBeLessThan(12);
    supervisor.stop();
  });

  it("comes back, and only the relay's own answer says so", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    let relayHasIt = false;
    const log = recorder();
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: async () => {
        if (!relayHasIt) throw new Error("reservation failed with status NO_RESERVATION");
        return { expiresAt: clock.now() + 7_200_000, ttlMs: 7_200_000 };
      },
      restore: async () => {
        relayHasIt = true;
      },
      renewalIntervalMs: 1_000,
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      log: log.log,
    });

    await clock.advance(3_000);
    const state = supervisor.state();
    // It passed THROUGH lost -- the log below proves it -- and came back
    // within one retry, because the restore runs the moment the loss is seen.
    expect(state.status).toBe("reserved");
    expect(state.lostSince).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.restores).toBe(1);
    expect(log.events).toEqual(
      expect.arrayContaining(["renewal-failed", "lost", "restoring", "restored"]),
    );
    supervisor.stop();
  });

  it("treats a circuit address that has GONE as proof of a loss, at once", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    const log = recorder();
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      // No renewal at all: this is the one thing the old address check got right.
      verify: false,
      restore: async () => {
        node.addrs = [CIRCUIT_ADDR];
      },
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      log: log.log,
    });

    node.addrs = [];
    node.emit("connection:close");
    await settle();
    expect(supervisor.state().status).toBe("lost");

    await clock.advance(10);
    expect(supervisor.state().status).toBe("reserved");
    expect(log.events).toContain("lost");
    supervisor.stop();
  });

  it("logs one line per transition, naming the relay", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    const log = recorder();
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: async () => ({ expiresAt: clock.now() + 7_200_000, ttlMs: 7_200_000 }),
      renewalIntervalMs: 1_000,
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      log: log.log,
    });

    await clock.advance(1_100);
    supervisor.stop();

    expect(log.events).toEqual(["reserved", "renewed", "stopped"]);
    for (const line of log.lines) expect(line).toContain(RELAY_PEER_ID);
  });

  it("stops meaning stopped: no further timers, and an unhealthy state", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    const relay = granting(7_200_000);
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: relay.verify,
      renewalIntervalMs: 1_000,
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      log: () => {},
    });

    await clock.advance(1_100);
    expect(relay.calls()).toBe(1);
    supervisor.stop();
    await clock.advance(60_000);
    expect(relay.calls()).toBe(1);
    expect(supervisor.state().status).toBe("stopped");
    expect(reservationHealthy(supervisor.state())).toBe(false);
  });

  it("poke() renews now instead of waiting out the backoff", async () => {
    const clock = fakeClock();
    const node = fakeNode();
    const relay = granting(7_200_000);
    const supervisor = superviseRelay({
      node: node.node,
      relayAddr: RELAY_ADDR,
      verify: relay.verify,
      renewalIntervalMs: 60_000,
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      log: () => {},
    });

    supervisor.poke();
    await settle();
    expect(relay.calls()).toBe(1);
    supervisor.stop();
  });
});

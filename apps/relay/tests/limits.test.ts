import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATA_LIMIT_BYTES,
  DEFAULT_DURATION_LIMIT_MS,
  MAX_RESERVATIONS,
  RESERVATION_TTL_MS,
  relayServerInit,
} from "../src/limits.js";

// The library defaults, read from @libp2p/circuit-relay-v2 4.2.11.
const LIBRARY_DEFAULT_MAX_RESERVATIONS = 15;
const LIBRARY_DEFAULT_DATA_LIMIT = 1n << 17n; // 128 KiB
const LIBRARY_DEFAULT_DURATION_LIMIT = 2 * 60 * 1000; // 2 minutes

describe("relayServerInit", () => {
  it("raises the reservation cap above the library's demo default", () => {
    expect(MAX_RESERVATIONS).toBeGreaterThan(LIBRARY_DEFAULT_MAX_RESERVATIONS);
    expect(relayServerInit().reservations?.maxReservations).toBe(MAX_RESERVATIONS);
  });

  it("applies limits, so the relay is not an unbounded open proxy", () => {
    expect(relayServerInit().reservations?.applyDefaultLimit).toBe(true);
  });

  // WHY GENEROUS. NAT traversal is negotiated per peer pair, so within one mesh
  // some pairs go direct and others fall back to the circuit -- and for those
  // the circuit IS the data path. libp2p resets the stream when a reservation's
  // budget is spent, so a cap tight enough to matter against abuse is tight
  // enough to truncate a real session, and that failure is invisible at both
  // ends: it surfaces as broken images with nothing to explain them.
  it("gives a real session far more room than the library's signalling-sized defaults", () => {
    expect(DEFAULT_DATA_LIMIT_BYTES).toBeGreaterThan(LIBRARY_DEFAULT_DATA_LIMIT * 1000n);
    expect(DEFAULT_DURATION_LIMIT_MS).toBeGreaterThan(LIBRARY_DEFAULT_DURATION_LIMIT * 10);
  });

  it("is a ceiling, not a budget: gigabytes and hours", () => {
    expect(DEFAULT_DATA_LIMIT_BYTES).toBeGreaterThanOrEqual(1n << 30n); // >= 1 GiB
    expect(DEFAULT_DURATION_LIMIT_MS).toBeGreaterThanOrEqual(60 * 60 * 1000); // >= 1 h
  });

  it("declares both figures, since applyDefaultLimit is all-or-nothing", () => {
    const r = relayServerInit().reservations ?? {};
    expect(r.defaultDataLimit).toBe(DEFAULT_DATA_LIMIT_BYTES);
    expect(r.defaultDurationLimit).toBe(DEFAULT_DURATION_LIMIT_MS);
  });

  it("still bounds the relay by reservation count and lifetime", () => {
    const r = relayServerInit().reservations ?? {};
    expect(r.reservationTtl).toBe(RESERVATION_TTL_MS);
    expect(r.reservationClearInterval).toBeDefined();
  });
});

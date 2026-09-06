import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATA_LIMIT_BYTES,
  DEFAULT_DURATION_LIMIT_MS,
  MAX_RESERVATIONS,
  relayServerInit,
} from "../src/limits.js";

// The library defaults, read from @libp2p/circuit-relay-v2 4.2.11:
//   maxReservations 15, defaultDurationLimit 120_000, defaultDataLimit BigInt(1 << 17).
const LIBRARY_DEFAULT_MAX_RESERVATIONS = 15;
const LIBRARY_DEFAULT_DURATION_LIMIT_MS = 120_000;
const LIBRARY_DEFAULT_DATA_LIMIT_BYTES = BigInt(1 << 17);

describe("relayServerInit", () => {
  it("raises the reservation cap above the library's demo default", () => {
    expect(MAX_RESERVATIONS).toBeGreaterThan(LIBRARY_DEFAULT_MAX_RESERVATIONS);
    expect(relayServerInit().reservations?.maxReservations).toBe(MAX_RESERVATIONS);
  });

  // The caps only exist if they are applied. With applyDefaultLimit false the
  // duration and data constants become decorative, which is the failure this
  // asserts against.
  it("applies the default limit, without which the other caps do nothing", () => {
    expect(relayServerInit().reservations?.applyDefaultLimit).toBe(true);
  });

  it("keeps per-connection limits bounded -- the circuit carries signalling, not bulk data", () => {
    const { reservations } = relayServerInit();
    expect(reservations?.defaultDurationLimit).toBe(DEFAULT_DURATION_LIMIT_MS);
    expect(reservations?.defaultDataLimit).toBe(DEFAULT_DATA_LIMIT_BYTES);

    // Raised enough to absorb a slow handshake...
    expect(DEFAULT_DURATION_LIMIT_MS).toBeGreaterThan(LIBRARY_DEFAULT_DURATION_LIMIT_MS);
    expect(DEFAULT_DATA_LIMIT_BYTES).toBeGreaterThan(LIBRARY_DEFAULT_DATA_LIMIT_BYTES);
    // ...and no further. A relay with bulk-transfer limits is a free CDN.
    expect(DEFAULT_DATA_LIMIT_BYTES).toBeLessThanOrEqual(BigInt(4 * 1024 * 1024));
  });

  it("states every cap explicitly, so a library default change is visible here", () => {
    const { reservations } = relayServerInit();
    expect(reservations?.reservationTtl).toBeDefined();
    expect(reservations?.reservationClearInterval).toBeDefined();
  });
});

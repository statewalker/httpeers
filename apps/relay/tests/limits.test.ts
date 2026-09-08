import { describe, expect, it } from "vitest";
import { MAX_RESERVATIONS, RESERVATION_TTL_MS, relayServerInit } from "../src/limits.js";

// The library defaults, read from @libp2p/circuit-relay-v2 4.2.11.
const LIBRARY_DEFAULT_MAX_RESERVATIONS = 15;

describe("relayServerInit", () => {
  it("raises the reservation cap above the library's demo default", () => {
    expect(MAX_RESERVATIONS).toBeGreaterThan(LIBRARY_DEFAULT_MAX_RESERVATIONS);
    expect(relayServerInit().reservations?.maxReservations).toBe(MAX_RESERVATIONS);
  });

  // THE POINT OF THIS FILE NOW. A relayed circuit is not only a signalling
  // path: when a peer pair cannot establish WebRTC -- which is negotiated per
  // pair, so it happens to some pairs and not others in the same mesh -- the
  // circuit IS the data path. A per-connection cap there does not degrade
  // gracefully; libp2p resets the stream and the application sees a truncated
  // response with nothing anywhere saying why. That shipped as broken images
  // on a phone, and a fresh tab "fixed" it because a new connection got a new
  // budget.
  it("applies no limit at all, so nothing is silently truncated", () => {
    expect(relayServerInit().reservations?.applyDefaultLimit).toBe(false);
  });

  // `applyDefaultLimit: false` leaves the reservation's `limit` undefined, so
  // BOTH the data and the duration caps are gone -- not just the data one.
  // Setting either value alongside it would imply a ceiling that is not
  // enforced, which is worse than no ceiling: it reads as protection.
  it("declares no data or duration figures that would not be enforced", () => {
    const r = relayServerInit().reservations ?? {};
    expect(r.defaultDataLimit).toBeUndefined();
    expect(r.defaultDurationLimit).toBeUndefined();
  });

  it("still bounds the relay by reservation count and lifetime, which do apply", () => {
    const r = relayServerInit().reservations ?? {};
    expect(r.maxReservations).toBeGreaterThan(0);
    expect(r.reservationTtl).toBe(RESERVATION_TTL_MS);
    expect(r.reservationClearInterval).toBeDefined();
  });
});

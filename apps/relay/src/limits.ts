/**
 * The relay's reservation caps -- what bounds this relay, and how the numbers
 * were arrived at.
 *
 * WHY A LIMIT EXISTS AT ALL. Circuit Relay **v2** is a *limited* relay by
 * design: v1 relays were unlimited, got treated as free public infrastructure,
 * and people stopped running them. A cap buys three things -- bounded egress
 * (a relay spends its own bandwidth carrying traffic between two third
 * parties), not being an open proxy for arbitrary libp2p traffic, and pressure
 * on peers to upgrade to a direct connection rather than settle for the
 * circuit.
 *
 * WHY THE STOCK NUMBERS ARE WRONG HERE. The library defaults -- 128 KiB and
 * two minutes -- are sized for an identify exchange plus hole-punch
 * coordination, on the assumption that the circuit is only ever a signalling
 * path. It is not. NAT traversal is negotiated PER PEER PAIR, so within one
 * mesh some pairs go direct and others fall back -- and for those, the circuit
 * IS the data path. libp2p resets the stream when a reservation's budget is
 * spent, so the application sees a truncated response and nothing anywhere
 * says why.
 *
 * That is not hypothetical: this relay ran with a 1 MiB cap, and a phone
 * loading an image gallery got roughly 1 MiB through before every remaining
 * image broke. Opening one of them in a fresh tab "worked" -- a new
 * connection, a new budget -- which reads as random corruption rather than a
 * quota. (The truncation that finally explained that gallery turned out to
 * live elsewhere, in `webrun-streams-libp2p`'s close path. This cap was not
 * the culprit there. It would have been the next one.)
 *
 * SO: GENEROUS, NOT ABSENT. The numbers below are ceilings against a runaway
 * or malicious peer, not budgets a real session can reach. The rule to keep:
 * any ceiling tight enough to matter against abuse is tight enough to truncate
 * somebody's gallery, and that failure is invisible at both ends. If bandwidth
 * ever becomes the problem, measure egress first and set the ceiling above
 * real usage rather than below it.
 */
import type { CircuitRelayServerInit } from "@libp2p/circuit-relay-v2";

/** Library default is 15 -- a demo number. */
export const MAX_RESERVATIONS = 512;

/** Library default (7 200 000 ms = 2 h), restated explicitly so a library change is visible here. A peer must refresh to keep its slot. */
export const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Library default (300 000 ms), restated explicitly for the same reason. */
export const RESERVATION_CLEAR_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 1 GiB per relayed connection -- 8192x the library's 128 KiB.
 *
 * Chosen to sit far above any real session (a measured browser-to-browser
 * gallery moved 63 MB across eighteen concurrent transfers) while still being
 * a number rather than infinity. `bigint` because that is what the library's
 * reservation limit takes.
 */
export const DEFAULT_DATA_LIMIT_BYTES = 1n << 30n;

/** 6 hours per relayed connection -- 180x the library's 2 minutes. Long enough that no session ends because of it. */
export const DEFAULT_DURATION_LIMIT_MS = 6 * 60 * 60 * 1000;

/**
 * `applyDefaultLimit` is all-or-nothing: it either attaches both figures to the
 * reservation or leaves the reservation's `limit` undefined and drops both. So
 * both are declared here -- declaring one and omitting the other would imply a
 * ceiling that is not enforced, which reads as a protection that exists.
 */
export function relayServerInit(): CircuitRelayServerInit {
  return {
    reservations: {
      maxReservations: MAX_RESERVATIONS,
      reservationTtl: RESERVATION_TTL_MS,
      reservationClearInterval: RESERVATION_CLEAR_INTERVAL_MS,
      applyDefaultLimit: true,
      defaultDataLimit: DEFAULT_DATA_LIMIT_BYTES,
      defaultDurationLimit: DEFAULT_DURATION_LIMIT_MS,
    },
  };
}

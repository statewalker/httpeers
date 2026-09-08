/**
 * The relay's reservation caps -- what bounds this relay, and what deliberately
 * does not.
 *
 * NO PER-CONNECTION LIMIT IS APPLIED. This is a reversal, and the reasoning it
 * replaces is worth keeping because it was plausible and wrong.
 *
 * The original argument: a circuit carries WebRTC signalling and then gets out
 * of the way, so a small per-connection data cap costs nothing and stops the
 * relay becoming a free CDN. That holds only while every peer pair completes
 * its WebRTC upgrade. NAT traversal is negotiated PER PAIR, so in one mesh some
 * pairs go direct and others fall back to the circuit -- and for those, the
 * circuit is not signalling, it IS the data path.
 *
 * How it failed: a phone loading a gallery got roughly 1 MiB through and then
 * every remaining image was broken. libp2p resets the stream when a
 * reservation's data budget is spent, so the application sees a truncated
 * response and nothing anywhere says why. Opening one image in a fresh tab
 * "worked", because a new connection got a new budget -- which reads as random
 * corruption rather than a quota.
 *
 * The duration limit had the same shape: a relayed connection open longer than
 * the cap would have been cut off just as silently. Both are gone.
 *
 * `applyDefaultLimit: false` is all-or-nothing -- it leaves the reservation's
 * `limit` undefined, dropping BOTH data and duration. So no data or duration
 * figure is declared below: a number that is configured but not enforced is
 * worse than none, because it reads as a protection that exists.
 *
 * WHAT STILL BOUNDS THIS RELAY: `maxReservations` and the reservation TTL. A
 * peer must hold one of a limited number of reservations, and must keep
 * refreshing it. There is no byte ceiling and no time ceiling on a relayed
 * connection.
 *
 * RESTORING IT. If this relay's bandwidth ever becomes a problem, set
 * `applyDefaultLimit: true` and give `defaultDataLimit` and
 * `defaultDurationLimit` generous values -- gigabytes and hours, not the 1 MiB
 * and 5 minutes that caused this -- so a runaway peer meets a ceiling while a
 * real session never does. Anything tight enough to matter for abuse is tight
 * enough to truncate somebody's gallery, and that failure is invisible at both
 * ends.
 */
import type { CircuitRelayServerInit } from "@libp2p/circuit-relay-v2";

/** Library default is 15 -- a demo number. With no per-connection limits this is now the main thing bounding the relay. */
export const MAX_RESERVATIONS = 512;

/** Library default (7 200 000 ms = 2 h), restated explicitly so a library change is visible here. A peer must refresh to keep its slot. */
export const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Library default (300 000 ms), restated explicitly for the same reason. */
export const RESERVATION_CLEAR_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `applyDefaultLimit: false` -- see the module comment. Deliberately declares no
 * `defaultDataLimit` or `defaultDurationLimit`: neither would be applied, and a
 * configured-but-unenforced number is a false assurance.
 */
export function relayServerInit(): CircuitRelayServerInit {
  return {
    reservations: {
      maxReservations: MAX_RESERVATIONS,
      reservationTtl: RESERVATION_TTL_MS,
      reservationClearInterval: RESERVATION_CLEAR_INTERVAL_MS,
      applyDefaultLimit: false,
    },
  };
}

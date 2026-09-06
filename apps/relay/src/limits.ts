/**
 * The relay's reservation and connection caps -- the abuse ceiling, in one
 * place, as reviewed values rather than as a tuning knob.
 *
 * WHY NOT THE DEFAULTS. `circuitRelayServer()`'s own defaults are what stops
 * a relay becoming a free CDN, and for a local demo they are exactly right.
 * For a public relay one of them is simply too small: `maxReservations: 15`
 * caps the mesh at fifteen simultaneously-reachable peers, which is a demo
 * number, not a deployment.
 *
 * WHY THE OTHERS STAY SMALL, which is the non-obvious half. In this design a
 * circuit carries WebRTC signalling and then gets out of the way -- peers
 * exchange SDP over the relay and move their actual data to a direct
 * connection. So the per-connection duration and data limits do not need to
 * accommodate bulk transfer, and making them generous would convert the
 * relay into the bandwidth-funded free CDN the defaults exist to prevent.
 * They are raised from the defaults only enough to absorb a slow handshake
 * and a retry.
 *
 * THE TRADE-OFF THIS ENCODES, stated because it will eventually bite: a peer
 * that cannot establish WebRTC falls back to carrying its data over the
 * circuit, and for that peer these limits are a hard ceiling -- it will be
 * cut off mid-transfer. That is deliberate. A relay that silently absorbs
 * every failed WebRTC upgrade is a relay whose bandwidth bill is set by other
 * people's NAT configurations.
 *
 * Every field name below is verified against @libp2p/circuit-relay-v2 4.2.11's
 * `ServerReservationStoreInit`, not assumed.
 */
import type { CircuitRelayServerInit } from "@libp2p/circuit-relay-v2";

/** Library default is 15 -- a demo number. This is the mesh's simultaneous-peer ceiling. */
export const MAX_RESERVATIONS = 512;

/** Library default (7 200 000 ms = 2 h), restated explicitly so a library change is visible here. */
export const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Library default (300 000 ms), restated explicitly for the same reason. */
export const RESERVATION_CLEAR_INTERVAL_MS = 5 * 60 * 1000;

/** Library default is 120 000 ms. Raised to absorb a slow signalling handshake plus a retry. */
export const DEFAULT_DURATION_LIMIT_MS = 5 * 60 * 1000;

/** Library default is 128 KiB (`BigInt(1 << 17)`). Raised to 1 MiB -- enough for signalling, far short of bulk transfer. */
export const DEFAULT_DATA_LIMIT_BYTES = BigInt(1024 * 1024);

/**
 * The complete server configuration. `applyDefaultLimit` must stay `true`:
 * with it false the duration and data limits above are never applied to a
 * reservation and the two constants become decorative.
 */
export function relayServerInit(): CircuitRelayServerInit {
  return {
    reservations: {
      maxReservations: MAX_RESERVATIONS,
      reservationTtl: RESERVATION_TTL_MS,
      reservationClearInterval: RESERVATION_CLEAR_INTERVAL_MS,
      applyDefaultLimit: true,
      defaultDurationLimit: DEFAULT_DURATION_LIMIT_MS,
      defaultDataLimit: DEFAULT_DATA_LIMIT_BYTES,
    },
  };
}

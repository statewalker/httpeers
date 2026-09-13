/**
 * Dialing the relay, and waiting for the reservation it grants afterwards.
 *
 * TRANSPORT-NEUTRAL ON PURPOSE, AND THAT IS WHY IT LIVES HERE. Both halves
 * of this module touch nothing but `Libp2p.dial` and `Libp2p.getMultiaddrs`,
 * so they are identical for a browser node (`browser/node-profile.ts`), a
 * Node hub (`hub/node-profile.ts`) and a test peer (`tests/e2e/harness.ts`).
 * They used to live in `browser/node-profile.ts`, whose top-level imports
 * include `@libp2p/webrtc` -- which is why `tests/e2e/harness.ts` grew a
 * second, hand-copied poll loop rather than import them (Task 14 reported
 * that duplication as a finding). `@libp2p/webrtc` now loads under Node
 * (its `node-datachannel` binary is installed, Task 20 Step 1), so the
 * import would work today; the copy is still gone because ONE poll loop
 * with one timing contract is the point, not because importing was
 * impossible.
 *
 * READINESS IS POLLED, NOT AWAITED (design note 17 §4). `node.dial(relay)`
 * resolving means the connection to the relay opened -- it says nothing
 * about whether the relay has finished granting a reservation. That
 * reservation lands asynchronously afterwards, so `waitForCircuitReservation`
 * polls `getMultiaddrs()` until a `p2p-circuit` address actually appears, on
 * the same schedule (250 ms x 40 attempts = 10 s ceiling) the validated
 * relay test used (`prototypes/16-.../src/relay.test.ts`). Treating `dial`'s
 * resolution as "ready" is exactly the race that note documents this project
 * already got bitten by once.
 */
import { multiaddr } from "@multiformats/multiaddr";
import { lastPeerIdOf } from "./multiaddr-parts.js";
import type { Libp2p } from "@libp2p/interface";

/** Dial the relay named by `relayAddr` (`httpeers.json`'s `relayAddrs[0]`). Resolving means the link is up -- NOT that a circuit reservation exists yet; see `waitForCircuitReservation`. */
export async function dialRelay(node: Libp2p, relayAddr: string): Promise<void> {
  await node.dial(multiaddr(relayAddr));
}

/** How often `waitForCircuitReservation` re-checks `getMultiaddrs()`. */
export const RESERVATION_POLL_INTERVAL_MS = 250;
/** How many times it checks before giving up -- 40 x 250 ms = 10 s, the ceiling the validated relay test (`relay.test.ts`) used. */
export const RESERVATION_POLL_ATTEMPTS = 40;

export interface WaitForCircuitReservationInit {
  intervalMs?: number;
  attempts?: number;
}

/**
 * Poll `node.getMultiaddrs()` until a `p2p-circuit` address appears,
 * returning it as a string. See this module's own "READINESS IS POLLED,
 * NOT AWAITED" note for why this exists instead of trusting `dialRelay`'s
 * resolution: the reservation is granted by the relay asynchronously,
 * after the dial itself has already resolved.
 */
export async function waitForCircuitReservation(
  node: Libp2p,
  init: WaitForCircuitReservationInit = {},
): Promise<string> {
  const intervalMs = init.intervalMs ?? RESERVATION_POLL_INTERVAL_MS;
  const attempts = init.attempts ?? RESERVATION_POLL_ATTEMPTS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = node.getMultiaddrs().find((addr) => addr.toString().includes("p2p-circuit"));
    if (found != null) return found.toString();
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `reservation: no p2p-circuit reservation appeared within ${attempts * intervalMs}ms of dialing the relay -- ` +
      "the relay may be unreachable, or its reservation limits already exhausted.",
  );
}

export interface SuperviseRelayInit {
  node: Libp2p;
  /**
   * The same string `dialRelay` was given. Its last `/p2p/<id>` names the
   * relay whose reservation counts; with a custom `restore`, `/p2p/<id>`
   * alone is enough.
   */
  relayAddr: string;
  /**
   * How to get the reservation back. Defaults to dialling `relayAddr` and
   * waiting for libp2p to reserve on it, which is right for a relay libp2p
   * DISCOVERED (a `/p2p-circuit` listen address). A CONFIGURED relay -- a
   * member's reservation on its hub -- is never re-reserved by libp2p, so its
   * restore has to ask again itself; see `./hub-link.ts`.
   */
  restore?: () => Promise<void>;
  /** The first retry after a failed attempt. */
  minRetryDelayMs?: number;
  /** The ceiling the backoff grows to. */
  maxRetryDelayMs?: number;
}

export interface RelaySupervisor {
  /** Re-check now, and if the reservation is gone try at once rather than wait out the backoff. */
  poke(): void;
  stop(): void;
}

/** How long one restore attempt waits for the reservation after its dial resolved -- 20 x 250 ms = 5 s. */
const RESTORE_POLL_ATTEMPTS = 20;

/** The backstop check, for a loss no event reported. */
const SUPERVISOR_CHECK_INTERVAL_MS = 10_000;

/**
 * Keep this node's reservation on the relay at `relayAddr`, re-dialling
 * whenever it is lost. Call once the first reservation has landed.
 */
export function superviseRelay(init: SuperviseRelayInit): RelaySupervisor {
  const { node, relayAddr } = init;
  const minDelayMs = init.minRetryDelayMs ?? 1_000;
  const maxDelayMs = init.maxRetryDelayMs ?? 30_000;
  const relayPeerId = lastPeerIdOf(multiaddr(relayAddr));

  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoring = false;
  let stopped = false;

  const reserved = (): boolean =>
    node.getMultiaddrs().some((addr) => {
      const s = addr.toString();
      return relayPeerId == null
        ? s.includes("/p2p-circuit")
        : s.includes(`/p2p/${relayPeerId}/p2p-circuit`);
    });

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      timer = undefined;
      void restore();
    }, delayMs);
  };

  async function restore(): Promise<void> {
    if (stopped || restoring || reserved()) return;
    restoring = true;
    try {
      if (init.restore != null) {
        await init.restore();
        if (!reserved()) throw new Error("reservation: restore resolved without a reservation");
      } else {
        await dialRelay(node, relayAddr);
        await waitForCircuitReservation(node, { attempts: RESTORE_POLL_ATTEMPTS });
      }
      failures = 0;
    } catch {
      if (!stopped) schedule(retryDelayMs(failures++, minDelayMs, maxDelayMs));
    } finally {
      restoring = false;
    }
  }

  const check = (): void => {
    if (stopped || restoring || timer != null) return;
    if (reserved()) {
      failures = 0;
      return;
    }
    schedule(0);
  };

  node.addEventListener("connection:close", check);
  node.addEventListener("self:peer:update", check);
  const interval = setInterval(check, SUPERVISOR_CHECK_INTERVAL_MS);

  return {
    poke() {
      if (stopped) return;
      clearTimeout(timer);
      timer = undefined;
      failures = 0;
      check();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      clearInterval(interval);
      node.removeEventListener("connection:close", check);
      node.removeEventListener("self:peer:update", check);
    },
  };
}

/**
 * The wait before retry number `failures` (0-based): doubling from
 * `minDelayMs`, capped at `maxDelayMs`, then jittered into its upper half
 * so a relay restart does not bring every peer back in the same instant.
 */
export function retryDelayMs(
  failures: number,
  minDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxDelayMs, minDelayMs * 2 ** failures);
  return base / 2 + (random() * base) / 2;
}

/** The circuit addresses a node currently holds, split by kind. */
export interface CircuitAddrs {
  /** `/…/p2p-circuit/p2p/<self>` — reachable through the relay, no WebRTC. */
  bare?: string;
  /** `/…/p2p-circuit/webrtc/p2p/<self>` — the relay carries only the handshake. */
  webrtc?: string;
}

/**
 * Which of a node's addresses a peer should actually be told.
 *
 * After reserving, a node carries several multiaddrs at once and they are NOT
 * interchangeable: its own transport address is not reachable through a relay
 * at all, the bare circuit relays every byte, and the `/webrtc` circuit uses
 * the relay for the handshake only and then talks directly. Handing out the
 * wrong one is a connection that fails for a reason nobody can read from the
 * error.
 *
 * Each assembly in the prototype picked one inline, and differently — the kind
 * of triplication the extraction exists to end.
 */
export function circuitAddrs(node: Libp2p): CircuitAddrs {
  const found: CircuitAddrs = {};
  for (const addr of node.getMultiaddrs()) {
    const value = addr.toString();
    // Not a circuit: the node's own transport address. A dialler reaching it
    // needs no relay, so it does not belong in either field.
    if (!value.includes("/p2p-circuit")) continue;
    // Order matters: every webrtc circuit also contains `/p2p-circuit`, so the
    // narrower test comes first or every address lands in `bare`.
    if (value.includes("/webrtc")) found.webrtc ??= value;
    else found.bare ??= value;
  }
  return found;
}

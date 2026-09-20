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

import type { Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { type RelayReservationGrant, requestRelayReservation } from "./hop-reserve.js";
import { lastPeerIdOf } from "./multiaddr-parts.js";
import { globalTimers, type TimerHandle, type Timers } from "./timers.js";

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

/**
 * WHAT `superviseRelay` NOW DOES, AND WHY IT IS NOT WHAT IT USED TO DO.
 *
 * The supervisor below used to answer "am I reserved?" from
 * `node.getMultiaddrs()` -- the node's OWN belief, held by libp2p's transport
 * reservation store. On 2026-09-19 that belief was wrong for hours: the relay
 * held no reservation for the hub, the websocket to it was still ESTABLISHED,
 * every member got `NO_RESERVATION`, and the supervisor saw a perfectly good
 * `/p2p-circuit` address and did nothing. Only a container restart fixed it,
 * and the root cause on the relay's side was never found -- which is the
 * argument for repairing the CLASS of fault rather than that one cause.
 *
 * So the relay decides now. On a schedule well inside the reservation's TTL
 * the supervisor asks the relay for a reservation over the connection it
 * already holds (`./hop-reserve.ts`, which explains the wire-level choice).
 * That single request is both the question and the repair: a relay's
 * reservation store is keyed by peer, so the answer is OK whether it renewed
 * an entry or created a missing one. The incident therefore heals on the next
 * tick without anything having to notice it first -- and if the relay instead
 * REFUSES, or cannot be asked at all, that is a loss, with the backoff and
 * `restore` path below.
 *
 * THE LOCAL ADDRESS LIST STILL EARNS ITS KEEP, in one direction only: an
 * address that has GONE is proof of a loss (libp2p removes it when the relay
 * connection closes), and reacting to it turns a dropped link into a restore
 * in milliseconds rather than at the next renewal. An address that is PRESENT
 * proves nothing and can no longer put the supervisor back into `reserved` --
 * `tests/reservation-supervisor.test.ts` pins exactly that asymmetry.
 *
 * NOTHING IS SWALLOWED. Every transition logs one line naming the relay and
 * the reason. The old implementation had a bare `catch {}` around the whole
 * restore, which is why the incident left no trace in the hub's own output.
 */

/** Where a supervised reservation stands. `stopped` is terminal. */
export type RelayReservationStatus = "reserved" | "lost" | "stopped";

/** Every transition the supervisor logs. There is no "gave up": it retries forever, with a capped backoff, and the health signal is what escalates. */
export type RelayReservationEvent =
  | "reserved"
  | "renewed"
  | "renewal-failed"
  | "lost"
  | "restoring"
  | "restored"
  | "restore-failed"
  | "stopped";

/** A supervisor's current view, as `GET /hub/api/relay` reports it. */
export interface RelayReservationState {
  status: RelayReservationStatus;
  relayAddr: string;
  /** The relay's peer id, or `null` when `relayAddr` names none. */
  relayPeerId: string | null;
  /** When the RELAY last confirmed the reservation (ms since the epoch); `null` until it first has. */
  verifiedAt: number | null;
  /** When the relay says the reservation expires (ms since the epoch); `null` when it did not say. */
  expiresAt: number | null;
  /** When the loss was first noticed (ms since the epoch); `null` while reserved. */
  lostSince: number | null;
  /** Renewals or restores that have failed in a row. Zero the moment the relay says OK. */
  consecutiveFailures: number;
  /** Relay-confirmed renewals since this supervisor started. */
  renewals: number;
  /** Recoveries completed since this supervisor started. */
  restores: number;
  /** The most recent failure, verbatim; kept after recovery so an operator can see what happened. */
  lastError: string | null;
}

/** One line, plus the structured form of the same thing. */
export type RelayLog = (
  message: string,
  detail: { event: RelayReservationEvent; state: RelayReservationState },
) => void;

export interface SuperviseRelayInit {
  node: Libp2p;
  /**
   * The same string `dialRelay` was given. Its last `/p2p/<id>` names the
   * relay whose reservation counts; with a custom `restore`, `/p2p/<id>`
   * alone is enough. Without any `/p2p/<id>` there is nobody to ask, and
   * proactive renewal is off.
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
  /**
   * Ask the relay itself. Defaults to a circuit-relay v2 HOP `RESERVE` over
   * the connection this node already holds (`requestRelayReservation`).
   * `false` turns proactive renewal off entirely, which leaves only the
   * address-disappeared detector -- i.e. the behaviour that missed the
   * incident. It exists for tests, not for production.
   */
  verify?: ((options: { signal?: AbortSignal }) => Promise<RelayReservationGrant>) | false;
  /**
   * How long between renewals. Defaults to a quarter of the TTL the relay
   * itself reported in its last grant -- see `renewalIntervalMs`.
   */
  renewalIntervalMs?: number;
  /** The backstop check for a loss no event reported. */
  checkIntervalMs?: number;
  /** Defaults to the global timers; a browser tab should pass `worker-timers` (see `./timers.ts`). */
  timers?: Timers;
  /** Defaults to one `console.log` per transition. A silent supervisor is what hid the incident. */
  log?: RelayLog;
  now?: () => number;
  random?: () => number;
}

export interface RelaySupervisor {
  /** Re-check now, and if the reservation is gone try at once rather than wait out the backoff. */
  poke(): void;
  /** What the relay last said, and when. Safe to call at any time; a copy, not the live object. */
  state(): RelayReservationState;
  stop(): void;
}

/** How long one restore attempt waits for the reservation after its dial resolved -- 20 x 250 ms = 5 s. */
const RESTORE_POLL_ATTEMPTS = 20;

/** The backstop check, for a loss no event reported. */
const SUPERVISOR_CHECK_INTERVAL_MS = 10_000;

/** How soon after starting the supervisor first asks the relay. See `scheduleRenewal`. */
const INITIAL_VERIFY_DELAY_MS = 1_000;

/**
 * The floor and ceiling on the renewal cadence, and the cadence used when the
 * relay has not told us a TTL yet.
 *
 * A QUARTER OF THE TTL is the rule (`renewalIntervalMs`). Against the relay
 * this project runs -- `apps/relay/src/limits.ts`, TTL two hours, restated
 * there precisely so a library change is visible -- that is thirty minutes,
 * and it means three consecutive renewals can fail before the reservation
 * would lapse on its own. A half would leave room for one, which is no margin
 * at all; an eighth would double the traffic for a margin nobody needs.
 *
 * The CEILING is the same thirty minutes, so a relay that one day advertises a
 * longer TTL does not stretch the cadence with it: the incident was not a
 * reservation that expired, it was one that vanished, and how fast that is
 * repaired is bounded by this number, not by the TTL. The FLOOR keeps a relay
 * with an implausibly short TTL from being asked every few seconds.
 */
export const MIN_RENEWAL_INTERVAL_MS = 60_000;
export const MAX_RENEWAL_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_RENEWAL_INTERVAL_MS = 20 * 60_000;

/** The renewal cadence for a reservation the relay says lasts `ttlMs`. See the constants above. */
export function renewalIntervalMs(ttlMs: number | null | undefined): number {
  if (ttlMs == null || !(ttlMs > 0)) return DEFAULT_RENEWAL_INTERVAL_MS;
  return Math.min(Math.max(ttlMs / 4, MIN_RENEWAL_INTERVAL_MS), MAX_RENEWAL_INTERVAL_MS);
}

/**
 * The actual wait before the next renewal: `intervalMs` jittered DOWN into its
 * upper quarter, never up.
 *
 * Down, because the interval is already the deadline -- stretching it past a
 * quarter of the TTL would spend the margin the quarter exists to buy. The
 * spread is what keeps a fleet of hubs that started together, or came back
 * together after a relay restart, from asking the relay in the same instant
 * for ever after.
 */
export function renewalDelayMs(intervalMs: number, random: () => number = Math.random): number {
  return intervalMs * 0.75 + intervalMs * 0.25 * random();
}

/**
 * How long a lost reservation may go unrepaired before the hub should call
 * itself unhealthy.
 *
 * TWO MINUTES. A restore normally completes in seconds: the loss is noticed
 * either at once (the address disappears) or at the next renewal, the restore
 * dials and waits at most five seconds for the reservation, and the retry
 * backoff caps at thirty. Two minutes is therefore at least four attempts
 * including capped retries -- long enough that a relay restart or a dropped
 * link never shows up as an unhealthy appliance, short enough to be a small
 * fraction of the two-hour TTL, so a hub that truly cannot get back is
 * reported long before members would notice on their own.
 */
export const RESERVATION_LOSS_GRACE_MS = 120_000;

/** Is this state healthy -- reserved, or lost for less than `graceMs`? See `RESERVATION_LOSS_GRACE_MS`. */
export function reservationHealthy(
  state: Pick<RelayReservationState, "status" | "lostSince">,
  graceMs: number = RESERVATION_LOSS_GRACE_MS,
  now: number = Date.now(),
): boolean {
  if (state.status === "reserved") return true;
  if (state.status === "stopped") return false;
  return state.lostSince != null && now - state.lostSince < graceMs;
}

/**
 * Keep this node's reservation on the relay at `relayAddr`: renew it against
 * the relay on a schedule, and re-dial whenever it is lost. Call once the
 * first reservation has landed.
 */
export function superviseRelay(init: SuperviseRelayInit): RelaySupervisor {
  const { node, relayAddr } = init;
  const minDelayMs = init.minRetryDelayMs ?? 1_000;
  const maxDelayMs = init.maxRetryDelayMs ?? 30_000;
  const relayPeerId = lastPeerIdOf(multiaddr(relayAddr)) ?? null;
  const timers = init.timers ?? globalTimers;
  const now = init.now ?? Date.now;
  const random = init.random ?? Math.random;
  const log = init.log ?? defaultRelayLog;
  const verify =
    init.verify === false
      ? undefined
      : (init.verify ??
        (relayPeerId != null
          ? (options: { signal?: AbortSignal }) =>
              requestRelayReservation(node, relayPeerId, options)
          : undefined));

  const state: RelayReservationState = {
    status: "reserved",
    relayAddr,
    relayPeerId,
    verifiedAt: null,
    expiresAt: null,
    lostSince: null,
    consecutiveFailures: 0,
    renewals: 0,
    restores: 0,
    lastError: null,
  };

  let retryTimer: TimerHandle;
  let renewalTimer: TimerHandle;
  let restoring = false;
  let renewing = false;
  let stopped = false;

  const snapshot = (): RelayReservationState => ({ ...state });

  const report = (event: RelayReservationEvent, reason?: string): void => {
    const where = relayPeerId ?? relayAddr;
    log(
      `relay: ${event} on ${where}${reason != null ? ` -- ${reason}` : ""}` +
        ` (failures=${state.consecutiveFailures}, renewals=${state.renewals}, restores=${state.restores})`,
      { event, state: snapshot() },
    );
  };

  /**
   * The address check, used ONLY to prove a loss. `true` here means nothing:
   * it is precisely the belief that was wrong during the incident.
   */
  const addressGone = (): boolean =>
    !node.getMultiaddrs().some((addr) => {
      const s = addr.toString();
      return relayPeerId == null
        ? s.includes("/p2p-circuit")
        : s.includes(`/p2p/${relayPeerId}/p2p-circuit`);
    });

  const markReserved = (grant: RelayReservationGrant, event: RelayReservationEvent): void => {
    state.status = "reserved";
    state.verifiedAt = now();
    state.expiresAt = grant.expiresAt;
    state.lostSince = null;
    state.consecutiveFailures = 0;
    if (event === "renewed") state.renewals++;
    if (event === "restored") state.restores++;
    report(event);
  };

  const markLost = (reason: string): void => {
    state.lastError = reason;
    if (state.status === "lost") return;
    state.status = "lost";
    state.lostSince = now();
    report("lost", reason);
  };

  const scheduleRetry = (delayMs: number): void => {
    timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      void restore();
    }, delayMs);
  };

  /**
   * THE FIRST RENEWAL IS PROMPT, the rest are on the TTL's cadence.
   *
   * A supervisor is started the moment a reservation lands, so one request a
   * second later costs a two-byte round trip and buys two things the caller
   * cannot get otherwise: the relay's own expiry -- which is what every later
   * interval is derived from, instead of the blind `DEFAULT_RENEWAL_INTERVAL_MS`
   * -- and a `verifiedAt` an operator can read straight after a restart rather
   * than twenty minutes into one.
   */
  const scheduleRenewal = (first = false): void => {
    if (stopped || verify == null) return;
    timers.clearTimeout(renewalTimer);
    const interval = init.renewalIntervalMs ?? renewalIntervalMs(ttlOf(state, now()));
    const delayMs =
      first && init.renewalIntervalMs == null
        ? INITIAL_VERIFY_DELAY_MS
        : renewalDelayMs(interval, random);
    renewalTimer = timers.setTimeout(() => {
      renewalTimer = undefined;
      void renew();
    }, delayMs);
  };

  /**
   * One relay-verified renewal. This is the whole point of the module: the
   * request renews a reservation that is there and re-creates one that is not,
   * so the ordinary case never reaches `restore` at all.
   */
  async function renew(): Promise<void> {
    if (stopped || verify == null || renewing || restoring) {
      scheduleRenewal();
      return;
    }
    renewing = true;
    try {
      const grant = await verify({});
      if (stopped) return;
      markReserved(grant, state.status === "reserved" ? "renewed" : "restored");
    } catch (error) {
      if (stopped) return;
      state.consecutiveFailures++;
      const reason = messageOf(error);
      state.lastError = reason;
      report("renewal-failed", reason);
      markLost(reason);
      scheduleRetry(0);
    } finally {
      renewing = false;
      scheduleRenewal();
    }
  }

  /**
   * Get the reservation back the hard way: re-dial (or the caller's `restore`),
   * then ASK THE RELAY. A restore that only re-listens has proved nothing --
   * that is the same local belief that failed before -- so when a `verify` is
   * available, its answer is what ends the outage.
   */
  async function restore(): Promise<void> {
    if (stopped || restoring) return;
    restoring = true;
    report("restoring", state.lastError ?? undefined);
    try {
      if (init.restore != null) {
        await init.restore();
      } else {
        await dialRelay(node, relayAddr);
        await waitForCircuitReservation(node, { attempts: RESTORE_POLL_ATTEMPTS });
      }
      if (stopped) return;
      if (verify != null) {
        markReserved(await verify({}), "restored");
      } else {
        if (addressGone()) throw new Error("restore resolved without a reservation");
        markReserved({ expiresAt: null, ttlMs: null }, "restored");
      }
    } catch (error) {
      if (stopped) return;
      state.consecutiveFailures++;
      const reason = messageOf(error);
      state.lastError = reason;
      markLost(reason);
      report("restore-failed", reason);
      scheduleRetry(retryDelayMs(state.consecutiveFailures - 1, minDelayMs, maxDelayMs, random));
    } finally {
      restoring = false;
    }
  }

  /** The fast loss detector: an address that has gone is proof; one that is there is not. */
  const check = (): void => {
    if (stopped || restoring || renewing || retryTimer != null) return;
    if (!addressGone()) return;
    markLost("the node's own circuit address is gone (the relay connection closed)");
    scheduleRetry(0);
  };

  node.addEventListener("connection:close", check);
  node.addEventListener("self:peer:update", check);
  const interval = timers.setInterval(check, init.checkIntervalMs ?? SUPERVISOR_CHECK_INTERVAL_MS);
  report("reserved");
  scheduleRenewal(true);

  return {
    poke() {
      if (stopped) return;
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
      state.consecutiveFailures = 0;
      if (verify != null) void renew();
      else check();
    },
    state: snapshot,
    stop() {
      if (stopped) return;
      stopped = true;
      state.status = "stopped";
      timers.clearTimeout(retryTimer);
      timers.clearTimeout(renewalTimer);
      retryTimer = undefined;
      renewalTimer = undefined;
      timers.clearInterval(interval);
      node.removeEventListener("connection:close", check);
      node.removeEventListener("self:peer:update", check);
      report("stopped");
    },
  };
}

/** What is left of the reservation the relay last granted, for the next renewal's cadence. */
function ttlOf(state: RelayReservationState, nowMs: number): number | null {
  return state.expiresAt != null ? state.expiresAt - nowMs : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** One line per transition on stdout. Replaceable, but never absent — see the module comment. */
const defaultRelayLog: RelayLog = (message) => {
  console.log(message);
};

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

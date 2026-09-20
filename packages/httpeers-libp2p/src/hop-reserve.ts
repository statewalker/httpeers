/**
 * Asking the RELAY whether this node is still reserved -- and renewing the
 * reservation in the same breath.
 *
 * THE QUESTION THIS MODULE EXISTS TO ANSWER. `node.getMultiaddrs()` reports
 * what the node's own transport reservation store believes, and in the
 * 2026-09-19 incident that belief was wrong for hours: the relay held no
 * reservation, the websocket was still up, every member got
 * `NO_RESERVATION`, and the hub saw nothing to repair. The only authority on
 * "is there a reservation" is the relay, so this asks it, over the wire.
 *
 * WHY NOT LIBP2P'S OWN CALL. `@libp2p/circuit-relay-v2`'s transport keeps a
 * `ReservationStore` whose `addRelay(peer, type)` is the renewal entry point,
 * and it is unusable as a probe for three separate reasons:
 *
 *   1. It SHORT-CIRCUITS. If it still holds an entry, the connection is open
 *      and the recorded expiry is more than ten minutes away, it returns the
 *      cached entry without sending a byte -- so a proactive call answers from
 *      the very belief we are trying to check.
 *   2. It is NOT REACHABLE. The store is a private component of the transport;
 *      nothing on `Libp2p` exposes it.
 *   3. Its failure paths are SURPRISING. A dial or protocol failure puts the
 *      relay in a "previously invalid" cuckoo filter (`relayFilter`) so later
 *      attempts are refused locally, and a discovered reservation can be
 *      refused with `HadEnoughRelaysError` when no pending slot is free.
 *
 * So we speak HOP ourselves. A `RESERVE` request on the relay's own protocol
 * is two bytes, and the answer is the relay's, not ours.
 *
 * IT REUSES THE SLOT, IT DOES NOT LEAK A SECOND ONE. The relay's reservation
 * store is keyed by peer id: `reserve()` finds the existing entry, resets its
 * expiry signal in place and returns OK (see `server/reservation-store.js` in
 * the installed 4.2.11). A peer cannot hold two reservations on one relay, so
 * "renew" and "re-reserve" are the same request -- which is also why this one
 * call both DETECTS a loss and REPAIRS it.
 *
 * IT DOES NOT DISTURB LIVE CIRCUITS. It opens one short-lived stream on a
 * connection that already exists; already-established circuits are separate
 * connections and are untouched, and the relay's refresh path does not close
 * anything.
 *
 * THE CODEC IS HAND-WRITTEN, four fields wide, because it has to be:
 * `@libp2p/circuit-relay-v2` publishes only `.` in its `exports` map, so its
 * generated `pb/index.js` cannot be imported, and vendoring protons to
 * regenerate a message we send ONE variant of would be more code than this.
 * The wire format is pinned by `tests/hop-reserve.test.ts` against bytes taken
 * from that generated encoder, and end to end by `tests/reservation-renewal.test.ts`
 * against a real relay -- which is the check that actually matters, since a
 * codec that agrees only with its own tests proves nothing.
 */

import { RELAY_V2_HOP_CODEC } from "@libp2p/circuit-relay-v2";
import type { Connection, Libp2p, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { pbStream } from "@libp2p/utils";

/** circuit-relay v2 `Status`, by number. The relay answers one of these. */
export const HOP_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "UNUSED",
  100: "OK",
  200: "RESERVATION_REFUSED",
  201: "RESOURCE_LIMIT_EXCEEDED",
  202: "PERMISSION_DENIED",
  203: "CONNECTION_FAILED",
  204: "NO_RESERVATION",
  400: "MALFORMED_MESSAGE",
  401: "UNEXPECTED_MESSAGE",
};

/** `Status.OK`. */
export const HOP_STATUS_OK = 100;

/**
 * `HopMessage{ type: RESERVE }` on the wire: field 1, varint, value 0.
 *
 * protobuf3 would normally omit a zero-valued field; protons generates
 * `if (obj.type != null) { w.uint32(8); ... }` for this `optional` field, so
 * the tag IS written and a relay that requires it (go-libp2p does) sees it.
 * Constant, because every request this module sends is this one.
 */
const RESERVE_REQUEST = Uint8Array.from([0x08, 0x00]);

/** How long one RESERVE round trip may take, matching libp2p's own `DEFAULT_RESERVATION_COMPLETION_TIMEOUT`. */
export const HOP_RESERVE_TIMEOUT_MS = 5_000;

/** What the relay granted. `expiresAt` is `null` when the relay sent no reservation body. */
export interface RelayReservationGrant {
  /** ms since the epoch, from the relay's own `Reservation.expire` (Unix seconds). */
  expiresAt: number | null;
  /** `expiresAt` minus now, at the moment the answer arrived. `null` when unknown. */
  ttlMs: number | null;
}

/** The relay answered, and the answer was not OK. `status` is its own `Status` number. */
export class RelayReservationRefusedError extends Error {
  constructor(
    readonly relayPeerId: string,
    readonly status: number,
  ) {
    super(
      `hop: the relay (${relayPeerId}) refused a reservation with ` +
        `${HOP_STATUS_NAMES[status] ?? `status ${status}`}`,
    );
    this.name = "RelayReservationRefusedError";
  }
}

/** There is no connection this node could ask the relay over. Not a refusal: nothing was asked. */
export class RelayNotConnectedError extends Error {
  constructor(readonly relayPeerId: string) {
    super(
      `hop: no open, unlimited connection to the relay (${relayPeerId}) to ask for a reservation over`,
    );
    this.name = "RelayNotConnectedError";
  }
}

/** The subset of `HopMessage` this module reads. Everything else is skipped. */
export interface HopAnswer {
  /** `HopMessage.Type`: 0 RESERVE, 1 CONNECT, 2 STATUS. */
  type?: number;
  status?: number;
  /** `Reservation.expire`, Unix SECONDS as the relay sent it. */
  expire?: number;
}

/**
 * Read the fields of a `HopMessage` this module needs, skipping the rest.
 *
 * Deliberately lenient about everything it does not use -- an unknown field,
 * a voucher, a limit -- because a decoder that throws on a field a future
 * relay adds would turn a healthy relay into a lost reservation.
 */
export function decodeHopAnswer(data: Uint8Array | { subarray(): Uint8Array }): HopAnswer {
  const bytes = data instanceof Uint8Array ? data : data.subarray();
  const answer: HopAnswer = {};
  const reader = new Reader(bytes);
  while (reader.hasMore()) {
    const tag = reader.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) answer.type = reader.varint();
    else if (field === 5 && wire === 0) answer.status = reader.varint();
    else if (field === 3 && wire === 2) {
      const reservation = new Reader(reader.bytes());
      while (reservation.hasMore()) {
        const innerTag = reservation.varint();
        if (innerTag >>> 3 === 1 && (innerTag & 7) === 0) answer.expire = reservation.varint();
        else reservation.skip(innerTag & 7);
      }
    } else reader.skip(wire);
  }
  return answer;
}

/**
 * Request (or renew) this node's reservation on `relayPeerId`, and return what
 * the relay granted. Throws `RelayReservationRefusedError` on any non-OK
 * status, `RelayNotConnectedError` when there is nothing to ask over, and
 * whatever the stream threw otherwise. Every one of those means "not reserved
 * as far as the relay is concerned", which is the only judgement the caller
 * needs.
 */
export async function requestRelayReservation(
  node: Libp2p,
  relayPeerId: string,
  options: { signal?: AbortSignal } = {},
): Promise<RelayReservationGrant> {
  const connection = openConnectionTo(node, relayPeerId);
  if (connection == null) throw new RelayNotConnectedError(relayPeerId);

  const signal = options.signal ?? AbortSignal.timeout(HOP_RESERVE_TIMEOUT_MS);
  const stream = await connection.newStream(RELAY_V2_HOP_CODEC, { signal });
  let answer: HopAnswer;
  try {
    const hop = pbStream(framed(stream)).pb<HopAnswer>({
      encode: () => RESERVE_REQUEST,
      decode: decodeHopAnswer,
    });
    await hop.write({}, { signal });
    answer = await hop.read({ signal });
  } catch (error) {
    stream.abort(error as Error);
    throw error;
  }
  // Closing the write end is enough and is not awaited past its own timeout:
  // the answer is already in hand, and a relay that is slow to acknowledge the
  // close must not turn a granted reservation into a reported loss.
  await stream.close({ signal }).catch(() => stream.abort(new Error("hop: close failed")));

  if (answer.status !== HOP_STATUS_OK) {
    throw new RelayReservationRefusedError(relayPeerId, answer.status ?? 0);
  }
  const expiresAt = answer.expire != null ? answer.expire * 1_000 : null;
  return { expiresAt, ttlMs: expiresAt != null ? expiresAt - Date.now() : null };
}

/**
 * A ONE-VERSION TYPE GAP, NOT A RUNTIME ONE.
 *
 * This workspace pins `@libp2p/interface` at 3.2.5 everywhere, and
 * `@libp2p/utils` requires `^3.3.0` — whose `MessageStream` grew a
 * `readableEnded` property. `pbStream` therefore refuses a 3.2.5 `Stream` by
 * type while accepting it perfectly at runtime: the property is implemented by
 * `AbstractMessageStream`, which every real libp2p stream extends, and
 * `stream-utils.js` never reads it in the first place (checked in the
 * installed 7.4.1). The narrow cast is the honest statement of that; widening
 * the pin across seven packages to satisfy one call site would be a much
 * larger change for the same behaviour.
 */
function framed(stream: Stream): Parameters<typeof pbStream>[0] {
  return stream as unknown as Parameters<typeof pbStream>[0];
}

/**
 * A connection to the relay a reservation may be requested over: open, and not
 * itself relayed.
 *
 * NOT RELAYED, because a relay refuses to reserve over a circuit
 * (libp2p calls it `DoubleRelayError` on its own side), and a limited
 * connection would in any case be spent on the attempt. `limits != null` is
 * how libp2p marks one.
 */
function openConnectionTo(node: Libp2p, relayPeerId: string): Connection | undefined {
  let peerId: ReturnType<typeof peerIdFromString>;
  try {
    peerId = peerIdFromString(relayPeerId);
  } catch {
    return undefined;
  }
  return node
    .getConnections(peerId)
    .find((connection) => connection.status === "open" && connection.limits == null);
}

/** A protobuf reader for the handful of field types `HopMessage` uses. */
class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  hasMore(): boolean {
    return this.pos < this.buf.length;
  }

  /**
   * An unsigned varint, as a `number`.
   *
   * Assembled with multiplication rather than `<<`, because `<<` is a 32-bit
   * operation in JavaScript and `Reservation.expire` is a uint64 of Unix
   * seconds -- a shift would wrap it into a negative number and turn a valid
   * expiry into nonsense. Ten bytes is the maximum a uint64 can occupy.
   */
  varint(): number {
    let value = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      if (!this.hasMore()) throw new Error("hop: truncated varint");
      const byte = this.buf[this.pos++];
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
    throw new Error("hop: varint longer than 10 bytes");
  }

  /** A length-delimited field's payload. */
  bytes(): Uint8Array {
    const length = this.varint();
    const end = this.pos + length;
    if (end > this.buf.length) throw new Error("hop: truncated length-delimited field");
    const slice = this.buf.subarray(this.pos, end);
    this.pos = end;
    return slice;
  }

  /** Step over a field of the given wire type. */
  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2:
        this.bytes();
        return;
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`hop: unsupported protobuf wire type ${wire}`);
    }
  }
}

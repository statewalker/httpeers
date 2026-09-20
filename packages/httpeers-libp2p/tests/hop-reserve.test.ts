/**
 * The hand-written HOP codec.
 *
 * WHAT PINS THE WIRE FORMAT IS NOT THIS FILE. A codec checked only against
 * byte strings its own author wrote agrees with itself and proves nothing;
 * what proves it is `reservation-renewal.test.ts`, where a real
 * `circuitRelayServer` parses the request this module encodes and this module
 * parses the reservation it grants. If the two bytes below were wrong the
 * relay would answer `MALFORMED_MESSAGE` and that suite would go red.
 *
 * So what is here is the decoder's EDGES, which a happy-path round trip never
 * reaches: fields we do not read, wire types we have to step over, a uint64
 * expiry too large for a 32-bit shift, and truncated input.
 */

import { describe, expect, it } from "vitest";
import { decodeHopAnswer, HOP_STATUS_NAMES, HOP_STATUS_OK } from "../src/hop-reserve.js";

/** A protobuf tag byte: `(field << 3) | wireType`. */
const tag = (field: number, wire: number): number => (field << 3) | wire;

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

/** `Reservation { expire = <seconds> }` as a length-delimited field 3 of `HopMessage`. */
function reservation(expireSeconds: number, extra: number[] = []): number[] {
  const body = [...[tag(1, 0)], ...varint(expireSeconds), ...extra];
  return [tag(3, 2), ...varint(body.length), ...body];
}

describe("decodeHopAnswer", () => {
  it("reads the status a relay answers with", () => {
    // HopMessage { type: STATUS, status: OK }
    const message = bytes([tag(1, 0), 2], [tag(5, 0)], varint(HOP_STATUS_OK));
    expect(decodeHopAnswer(message)).toEqual({ type: 2, status: HOP_STATUS_OK });
  });

  it("reads a refusal, and every status has a name", () => {
    for (const status of [200, 201, 202, 203, 204, 400, 401]) {
      const message = bytes([tag(1, 0), 2], [tag(5, 0)], varint(status));
      expect(decodeHopAnswer(message).status).toBe(status);
      expect(HOP_STATUS_NAMES[status]).toBeTypeOf("string");
    }
  });

  it("reads the expiry out of the nested reservation", () => {
    // A Unix second count far past 2^31: `1 << 31` is NEGATIVE in JavaScript,
    // so a decoder built on shifts turns a valid expiry into a date in 1901
    // and every renewal after it into a panic.
    const expire = 4_000_000_000;
    const message = bytes([tag(1, 0), 2], reservation(expire), [tag(5, 0)], varint(HOP_STATUS_OK));
    const answer = decodeHopAnswer(message);
    expect(answer.expire).toBe(expire);
    expect((answer.expire ?? 0) * 1000).toBeGreaterThan(Date.now());
  });

  it("steps over everything it does not read", () => {
    const message = bytes(
      [tag(1, 0), 2],
      // field 2, Peer: length-delimited, skipped
      [tag(2, 2), 3, 1, 2, 3],
      reservation(1_800_000_000, [
        // an addr inside the reservation, and a voucher: both skipped
        ...[tag(2, 2), 2, 9, 9],
        ...[tag(3, 2), 1, 7],
      ]),
      // field 4, Limit: skipped
      [tag(4, 2), 2, 8, 1],
      // a field this version has never heard of, in each wire type we allow
      [tag(9, 0)],
      varint(300),
      [tag(10, 5), 1, 2, 3, 4],
      [tag(11, 1), 1, 2, 3, 4, 5, 6, 7, 8],
      [tag(5, 0)],
      varint(HOP_STATUS_OK),
    );
    expect(decodeHopAnswer(message)).toEqual({
      type: 2,
      expire: 1_800_000_000,
      status: HOP_STATUS_OK,
    });
  });

  it("reports an absent status rather than inventing one", () => {
    // A relay that answers a message with no status at all is not saying OK.
    expect(decodeHopAnswer(bytes([tag(1, 0), 2])).status).toBeUndefined();
  });

  it("throws on truncated input instead of returning a partial answer", () => {
    // Half a length-delimited field. Silently returning `{}` here would read
    // as "no status", which is the right outcome by luck rather than design --
    // and the same silence would hide a genuine framing bug.
    expect(() => decodeHopAnswer(bytes([tag(3, 2), 8, 1, 2]))).toThrow(/truncated/);
    expect(() => decodeHopAnswer(bytes([tag(1, 0), 0x80, 0x80]))).toThrow(/truncated/);
  });

  it("accepts a Uint8ArrayList-shaped input, which is what the stream hands it", () => {
    const inner = bytes([tag(5, 0)], varint(HOP_STATUS_OK));
    expect(decodeHopAnswer({ subarray: () => inner })).toEqual({ status: HOP_STATUS_OK });
  });
});

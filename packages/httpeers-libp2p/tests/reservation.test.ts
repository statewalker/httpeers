/**
 * `retryDelayMs`: the relay supervisor's backoff.
 *
 * The integration suite (`e2e/relay-supervisor.test.ts`) proves the
 * supervisor keeps trying and comes back; it cannot see HOW OFTEN it tries.
 * That is what this pins: a supervisor retrying at a fixed short interval
 * still passes every e2e case while hammering a relay that is down -- and
 * every peer of every mesh would be doing it at once.
 */
import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../src/reservation.js";

const MIN = 1_000;
const MAX = 30_000;
const low = (): number => 0;
const high = (): number => 1;

describe("retryDelayMs", () => {
  it.each([
    // failures, shortest, longest
    [0, 500, 1_000],
    [1, 1_000, 2_000],
    [4, 8_000, 16_000],
    [5, 15_000, 30_000], // 32 s, capped at 30 s
    [50, 15_000, 30_000], // stays capped, no overflow
  ])("after %i failures waits between %i and %i ms", (failures, shortest, longest) => {
    expect(retryDelayMs(failures, MIN, MAX, low)).toBe(shortest);
    expect(retryDelayMs(failures, MIN, MAX, high)).toBe(longest);
  });
});

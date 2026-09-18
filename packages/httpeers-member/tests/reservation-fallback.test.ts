/**
 * Which refused reservations `startMember` survives by dropping to relay mode.
 *
 * The end-to-end proof -- a real hub with a full store, a member that still
 * joins -- is the conformance suite's `member-reservation-fallback.test.ts`.
 * This pins the POLICY for every refusal kind, including the ones a live hub
 * cannot be made to produce on demand, so a kind added later has to be decided
 * here rather than falling through.
 */
import { HubReservationError, type HubReservationRefusal } from "@statewalker/httpeers-libp2p";
import { describe, expect, it } from "vitest";
import { fallsBackToRelay } from "../src/start-member.js";

const HUB = "12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN";

function refused(refusal: HubReservationRefusal, status: string | null): HubReservationError {
  return new HubReservationError(HUB, status, refusal, { cause: new Error("libp2p") });
}

describe("fallsBackToRelay", () => {
  it.each([
    // The hub has no slot, or did not answer: nothing about this member, and
    // relay mode serves everything the member itself does.
    ["store-full", "RESERVATION_REFUSED", true],
    ["resource-limit", "RESOURCE_LIMIT_EXCEEDED", true],
    ["no-answer", null, true],
    // The hub disagrees with what it just told us, or is deployed wrong:
    // a real fault, reported rather than papered over.
    ["not-a-member", "PERMISSION_DENIED", false],
    ["no-relay", null, false],
    ["other", "MALFORMED_MESSAGE", false],
  ] as const)("%s (%s) -> %s", (refusal, status, expected) => {
    expect(fallsBackToRelay(refused(refusal, status))).toBe(expected);
  });

  it("does not fall back on an error that is not a refusal", () => {
    expect(fallsBackToRelay(new Error("listening on the hub produced no reserved address"))).toBe(
      false,
    );
  });
});

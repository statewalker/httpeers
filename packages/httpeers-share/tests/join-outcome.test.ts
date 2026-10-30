/**
 * The errors are the ones measured against httpeers-member 0.1.6 over a real
 * mesh (apps/peershare-protos rung 10), reproduced here as values.
 */
import { MemberJoinError } from "@statewalker/httpeers-member";
import { describe, expect, it } from "vitest";
import { joinOutcome } from "../src/join-outcome.js";

const refused = (hubAnswer: string) =>
  new MemberJoinError("invitation-refused", "the hub would not accept that invitation.", {
    cause: new Error(`join: invitation redemption failed (403 ): ${hubAnswer}`),
  });

describe("joinOutcome", () => {
  it("invite-used: the hub says already-redeemed", () => {
    expect(joinOutcome(refused('{"error":"invitation already-redeemed"}'))).toBe("invite-used");
  });

  it("invite-expired: the hub says expired", () => {
    expect(joinOutcome(refused('{"error":"invitation expired"}'))).toBe("invite-expired");
  });

  it("machine-offline: the relay holds no reservation for the Sharer", () => {
    const offline = new Error(
      "startMember: the hub could not be reached over WebRTC (failed to connect via relay with status NO_RESERVATION)",
    );
    expect(joinOutcome(offline)).toBe("machine-offline");
  });
});

/**
 * `reserveOnHub`'s error: WHICH refusal it was, read from what libp2p said.
 *
 * libp2p reports every failed reservation the same way -- the transport
 * manager's "Some configured addresses failed to be listened on", with the
 * real cause only in its text. `reserveOnHub` used to replace that with one
 * blanket message naming PERMISSION_DENIED and UnsupportedProtocolError
 * whatever had happened, so a hub whose reservation store was full
 * (`RESERVATION_REFUSED`) read as "this peer is not a member" -- measured in
 * production, where it sent the diagnosis the wrong way.
 *
 * THE TEXTS BELOW ARE LIBP2P'S, as `transport-manager.js` composes them in
 * libp2p 3.3.8 (the inner error's stack, indented, under the address). The
 * conformance suite's `member-reservation-fallback.test.ts` gets the same
 * refusals from a real hub, so a libp2p upgrade that changes the wording
 * fails there and not only here.
 */
import type { Libp2p } from "@libp2p/interface";
import { describe, expect, it } from "vitest";
import { HubReservationError, reserveOnHub } from "../src/hub-link.js";

const HUB = "12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN";

/** The transport manager's wrapper around one failed listen, as libp2p 3.3.8 words it. */
function listenFailure(inner: string): Error {
  return Object.assign(
    new Error(
      "Some configured addresses failed to be listened on, you may need to remove one or more " +
        "listen addresses from your configuration or set `transportManager.faultTolerance` to " +
        `NO_FATAL:\n\n  /p2p/${HUB}/p2p-circuit: ${inner.split("\n").join("\n  ")}\n`,
    ),
    { name: "UnsupportedListenAddressesError" },
  );
}

/** A node whose only relevant part -- the transport manager -- fails with `err`. */
function refusingNode(err: Error): Libp2p {
  return {
    components: { transportManager: { listen: async () => Promise.reject(err) } },
    getMultiaddrs: () => [],
  } as unknown as Libp2p;
}

async function refusal(inner: string): Promise<HubReservationError> {
  const err = await reserveOnHub(refusingNode(listenFailure(inner)), HUB).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HubReservationError);
  return err as HubReservationError;
}

describe("reserveOnHub's refusal", () => {
  it("RESERVATION_REFUSED: says the hub's reservation store is full, and nothing about membership", async () => {
    const err = await refusal(
      "Error: reservation failed with status RESERVATION_REFUSED\n    at ReservationStore.createReservation (reservation-store.js:340:15)",
    );
    expect(err.status).toBe("RESERVATION_REFUSED");
    expect(err.refusal).toBe("store-full");
    expect(err.message).toContain(HUB);
    expect(err.message).toContain("reservation store is full");
    expect(err.message).not.toContain("PERMISSION_DENIED");
    expect(err.message).not.toContain("not a member");
    expect(err.message).not.toContain("UnsupportedProtocolError");
  });

  it("RESOURCE_LIMIT_EXCEEDED: a capacity refusal too, named as such", async () => {
    const err = await refusal("Error: reservation failed with status RESOURCE_LIMIT_EXCEEDED");
    expect(err.status).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(err.refusal).toBe("resource-limit");
    expect(err.message).toContain("resource limit");
    expect(err.message).not.toContain("not a member");
  });

  it("PERMISSION_DENIED: says the hub does not count this peer as a member", async () => {
    const err = await refusal("Error: reservation failed with status PERMISSION_DENIED");
    expect(err.status).toBe("PERMISSION_DENIED");
    expect(err.refusal).toBe("not-a-member");
    expect(err.message).toContain("not a member");
    expect(err.message).not.toContain("full");
  });

  it("UnsupportedProtocolError: says the hub does not relay at all", async () => {
    const err = await refusal(
      "UnsupportedProtocolError: Protocol selection failed - could not negotiate /libp2p/circuit/relay/0.2.0/hop",
    );
    expect(err.status).toBeNull();
    expect(err.refusal).toBe("no-relay");
    expect(err.message).toContain("does not relay");
  });

  it("no status at all (a timeout, a dropped link): says the hub gave no answer, and quotes the cause", async () => {
    const err = await refusal("TimeoutError: The operation was aborted due to timeout");
    expect(err.status).toBeNull();
    expect(err.refusal).toBe("no-answer");
    expect(err.message).toContain("The operation was aborted due to timeout");
    expect(err.message).not.toContain("not a member");
  });

  it("any other status: named verbatim, not guessed at", async () => {
    const err = await refusal("Error: reservation failed with status MALFORMED_MESSAGE");
    expect(err.status).toBe("MALFORMED_MESSAGE");
    expect(err.refusal).toBe("other");
    expect(err.message).toContain("MALFORMED_MESSAGE");
  });

  it("keeps libp2p's error as the cause", async () => {
    const inner = listenFailure("Error: reservation failed with status RESERVATION_REFUSED");
    const err = await reserveOnHub(refusingNode(inner), HUB).catch((e: unknown) => e);
    expect((err as Error).cause).toBe(inner);
  });
});

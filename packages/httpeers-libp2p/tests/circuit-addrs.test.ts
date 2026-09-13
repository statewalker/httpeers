/**
 * `circuitAddrs` — which of a node's addresses a peer should actually be told.
 *
 * A node that has reserved on a relay carries several multiaddrs at once: the
 * relay's own transport address, the bare circuit, and the circuit with
 * `/webrtc` appended. They are not interchangeable, and handing out the wrong
 * one is a connection that fails for reasons nobody can read.
 *
 * NEW SYMBOL, NOT A MOVE. The prototype's assemblies each picked an address
 * inline, differently, which is exactly the kind of triplication the
 * extraction exists to end — so this one has a red test before it has an
 * implementation.
 */

import { describe, expect, it } from "vitest";
import { circuitAddrs } from "../src/reservation.js";

const RELAY = "12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SELF = "12D3KooWSelfBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** What `node.getMultiaddrs()` looks like after a reservation. */
const ADDRS = [
  `/ip4/1.2.3.4/tcp/9090/p2p/${RELAY}/p2p-circuit/p2p/${SELF}`,
  `/ip4/1.2.3.4/tcp/9090/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${SELF}`,
];

describe("circuitAddrs", () => {
  it("separates the bare circuit from the webrtc one", () => {
    const found = circuitAddrs({ getMultiaddrs: () => ADDRS.map(fakeAddr) } as never);

    expect(found.bare).toBe(ADDRS[0]);
    expect(found.webrtc).toBe(ADDRS[1]);
  });

  it("returns undefined for a kind the node does not have", () => {
    // A node that reserved but has no WebRTC transport has a bare circuit and
    // nothing else. Reporting the bare one as `webrtc` would send a dialler
    // down a path the node cannot answer.
    const onlyBare = circuitAddrs({ getMultiaddrs: () => [fakeAddr(ADDRS[0] as string)] } as never);

    expect(onlyBare.bare).toBe(ADDRS[0]);
    expect(onlyBare.webrtc).toBeUndefined();
  });

  it("ignores addresses that are not circuits at all", () => {
    // A listening node advertises its own transport address too. It is not
    // reachable THROUGH a relay, so it is not a circuit address.
    const direct = `/ip4/127.0.0.1/tcp/4001/p2p/${SELF}`;
    const found = circuitAddrs({
      getMultiaddrs: () => [direct, ADDRS[0] as string].map(fakeAddr),
    } as never);

    expect(found.bare).toBe(ADDRS[0]);
    expect(found.webrtc).toBeUndefined();
  });

  it("has nothing to report before a reservation exists", () => {
    expect(circuitAddrs({ getMultiaddrs: () => [] } as never)).toEqual({});
  });
});

/** Minimal stand-in: `circuitAddrs` only ever reads the string form. */
function fakeAddr(value: string): { toString(): string } {
  return { toString: () => value };
}

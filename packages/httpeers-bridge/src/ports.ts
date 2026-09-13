/**
 * A `PeerLink` over MessagePorts — for tests, and for transports that are
 * already point-to-point.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. libp2p establishes who the far side
 * is with a Noise handshake, and the bridge binds that answer to every inbound
 * request. A raw `MessagePort` establishes nothing at all: whoever holds the
 * port is whoever holds the port. So the identities here are ASSERTED at
 * construction — `pairedLinks(a, b)` says "this channel connects exactly these
 * two", and each side reports the other.
 *
 * That is sound for a test harness and for an in-process or same-origin
 * transport where the channel itself is the trust boundary. It is NOT a peer
 * transport you can deploy across a network, and it lives behind its own entry
 * point so that it cannot be mistaken for one.
 *
 * ONE PORT PER CALL, which is what `PortMux` is for: `openPort()` yields a
 * fresh port, `onPort` receives the far side's, and `duplexOverPort` turns
 * each into the `Duplex` the bridge speaks. Multiplexing a single pipe into
 * many ports is `multiplexPort`'s job in `@statewalker/webrun-rpc`, so a
 * WebSocket or worker transport reuses all of this and supplies only the pipe.
 */

import type { PeerIdStr, ProvenPeer } from "@statewalker/httpeers-core";
import type { Duplex } from "@statewalker/webrun-streams";
import { duplexOverPort, serveDuplexOverPort } from "@statewalker/webrun-rpc";
import type { PeerConnection, PeerLink } from "./index.js";

/**
 * The parts of `MessagePort` this uses, named structurally.
 *
 * Node's `MessagePort` and the DOM's are different types that agree on exactly
 * these members; naming them here keeps the package off the DOM lib without
 * pretending either implementation is the canonical one.
 */
export interface PortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/** How a pair of connected ports is made. Injected so this file names no global. */
export type ChannelFactory = () => { port1: PortLike; port2: PortLike };

export interface PairedLinksInit {
  /**
   * Defaults to the platform's `MessageChannel`, which exists in browsers,
   * workers and Node 15+. Supply one to run over something else.
   */
  channel?: ChannelFactory;
}

declare const MessageChannel: { new (): { port1: PortLike; port2: PortLike } };

/**
 * Two links joined back to back: whatever `a` opens, `b` accepts.
 *
 * A socketpair, in other words. Each `open()` creates a fresh channel and
 * hands the far end to the other side's listener, so the bridge's "one duplex
 * per call" holds exactly as it does over libp2p.
 */
export function pairedLinks(
  peerA: PeerIdStr,
  peerB: PeerIdStr,
  init: PairedLinksInit = {},
): [PeerLink, PeerLink] {
  const makeChannel = init.channel ?? (() => new MessageChannel());

  /** Inbound listeners, one per side, registered by `serve`. */
  const inbound = new Map<PeerIdStr, (from: ProvenPeer, port: PortLike) => void>();

  const linkFor = (self: PeerIdStr, other: PeerIdStr): PeerLink => ({
    async open(peerId: PeerIdStr): Promise<PeerConnection> {
      if (peerId !== other) {
        // A point-to-point link reaches exactly one peer. Saying so is better
        // than opening a channel nobody is listening on and timing out.
        throw new Error(
          `pairedLinks: ${self} is linked only to ${other}, cannot open to ${peerId}`,
        );
      }
      const accept = inbound.get(other);
      if (accept === undefined) {
        throw new Error(`pairedLinks: ${other} is not serving`);
      }
      const { port1, port2 } = makeChannel();
      port1.start?.();
      // The far side is told who opened it — the assertion this link is built
      // on, and the only identity claim it can make.
      accept(self, port2);
      return {
        call: duplexOverPort(port1 as never) as Duplex,
        async close() {
          port1.close?.();
        },
      };
    },

    async serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>> {
      const open: Array<{ port: PortLike; stop: () => void }> = [];
      inbound.set(self, (from, port) => {
        port.start?.();
        // `serveDuplexOverPort` is the serving half of `duplexOverPort` and
        // owns the wiring that makes a duplex server work at all: a handler's
        // OUTPUT depends on its INPUT, so feeding one to the other by hand is
        // circular and simply hangs. (It did, on the first attempt here --
        // three tests timed out rather than failed, which is what that mistake
        // looks like.)
        const stop = serveDuplexOverPort(port as never, handlerFor(from));
        open.push({ port, stop });
      });
      return async () => {
        inbound.delete(self);
        for (const entry of open) {
          entry.stop();
          entry.port.close?.();
        }
      };
    },
  });

  return [linkFor(peerA, peerB), linkFor(peerB, peerA)];
}

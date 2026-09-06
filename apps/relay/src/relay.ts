/**
 * The relay process: a stock libp2p Circuit Relay v2 server over WebSockets,
 * and nothing else.
 *
 * NO APPLICATION CODE. This process does not serve discovery, does not
 * announce itself as a member of any mesh, and holds no directory. This is
 * the one component in the system that is genuinely infrastructure, and it is
 * also the only one containing no project logic; that those two facts
 * coincide is the design working, not an oversight to "complete" by adding a
 * directory here too.
 *
 * TLS IS NOT TERMINATED HERE. The reverse proxy holds the certificate and
 * this speaks plain `ws` on an internal network -- which is why `announce`
 * exists and why it is not optional in production. See `addresses.ts`.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p, type Libp2p } from "libp2p";
import { assertAnnounceAddr, DEFAULT_RELAY_PORT, listenAddrs } from "./addresses.js";
import { relayServerInit } from "./limits.js";

export interface StartRelayInit {
  /** The relay's identity. Obtained via `key.ts`; never generated here. */
  privateKey: Ed25519PrivateKey;
  /** The port to bind. Defaults to 9090. */
  port?: number;
  /**
   * Addresses peers should dial, when they differ from what is bound --
   * i.e. always, behind a proxy. Empty means "advertise what I listen on",
   * which is correct only for a local run.
   */
  announce?: string[];
}

export interface Relay {
  node: Libp2p;
  stop: () => Promise<void>;
}

export async function startRelay(init: StartRelayInit): Promise<Relay> {
  const port = init.port ?? DEFAULT_RELAY_PORT;
  const announce = init.announce ?? [];
  for (const addr of announce) assertAnnounceAddr(addr);

  const node = await createLibp2p({
    privateKey: init.privateKey,
    addresses: {
      listen: listenAddrs(port),
      ...(announce.length > 0 ? { announce } : {}),
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer(relayServerInit()),
    },
  });

  return {
    node,
    async stop() {
      await node.stop();
    },
  };
}

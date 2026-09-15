/**
 * The hub's libp2p node, and how it gets onto the relay.
 *
 * BUILT LIKE THE CONFORMANCE HARNESS'S `hubNode`, minus TCP: a daemon in a
 * container has no same-host peers to dial directly.
 *
 *   - `webSockets()` -- how the hub DIALS the relay (`/tls/ws` in production).
 *   - `circuitRelayTransport()` -- how the reservation is held; `/p2p-circuit`
 *     is what makes libp2p reserve on the relay it dials.
 *   - `webRTC()` -- the upgrade a member performs to reach the hub. The hub can
 *     only ANSWER it with this transport and a `/webrtc` listen address. On a
 *     Docker bridge network the upgrade fails and members fall back to a kept
 *     relay circuit, which is why the daemon serves on limited connections.
 *
 * NO DIAL GATER OVERRIDE. libp2p's Node gater already permits loopback and
 * private addresses (only the browser build denies them), so a loopback relay
 * in a test and a compose-internal one need nothing extra.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import {
  dialRelay,
  hubRelayService,
  type IsMember,
  membershipGater,
  type RelaySupervisor,
  superviseRelay,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { createLibp2p } from "libp2p";

export interface CreateHubNodeInit {
  privateKey: Ed25519PrivateKey;
  /**
   * A THUNK, because the member store does not exist until `createHub` runs,
   * which is after the node. `membershipGater` reads it at decision time.
   */
  isMember: () => IsMember;
}

export async function createHubNode(init: CreateHubNodeInit): Promise<Libp2p> {
  return createLibp2p({
    privateKey: init.privateKey,
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [webSockets(), circuitRelayTransport(), webRTC()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: membershipGater(init.isMember),
    services: { identify: identify(), relay: hubRelayService() },
  });
}

/** How long the relay document may take. The daemon has nothing to do until it arrives. */
const RELAY_DOC_TIMEOUT_MS = 15_000;

/** Fetch `{ relayAddrs: string[] }` from `url`. */
export async function readRelayDoc(url: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(RELAY_DOC_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `relay: could not fetch the relay document ${url}: ${(error as Error).message}`,
    );
  }
  if (!response.ok) throw new Error(`relay: ${url} answered ${response.status}`);
  const doc = (await response.json().catch(() => null)) as { relayAddrs?: unknown } | null;
  const addrs = doc?.relayAddrs;
  if (
    !Array.isArray(addrs) ||
    addrs.length === 0 ||
    !addrs.every((a): a is string => typeof a === "string")
  ) {
    throw new Error(`relay: ${url} has no relayAddrs; expected { "relayAddrs": ["/dns4/..."] }`);
  }
  return addrs;
}

export interface RelayConnection {
  relayAddr: string;
  supervisor: RelaySupervisor;
}

/**
 * Reserve on the first relay address that works, and keep the reservation.
 * The addresses are tried in order; the error names every one that failed.
 */
export async function connectRelay(node: Libp2p, relayAddrs: string[]): Promise<RelayConnection> {
  const failures: string[] = [];
  for (const relayAddr of relayAddrs) {
    try {
      await dialRelay(node, relayAddr);
      await waitForCircuitReservation(node);
      return { relayAddr, supervisor: superviseRelay({ node, relayAddr }) };
    } catch (error) {
      failures.push(`${relayAddr}: ${(error as Error).message}`);
    }
  }
  throw new Error(`relay: no reservation on any relay address\n  ${failures.join("\n  ")}`);
}

/**
 * The browser libp2p profile.
 *
 * A browser cannot listen for inbound TCP the way `../hub/main.ts` /
 * `../relay/main.ts` do (`transport-duplex.ts`'s `createNode`, TCP-only,
 * is Node-side and stays Node-side). Instead this node reserves a relayed
 * address on the deployment's relay and accepts a WebRTC upgrade brokered
 * over it -- WebSockets to dial the relay in the first place,
 * Circuit-Relay-v2 for the reservation and for dialling other peers'
 * relayed addresses, WebRTC for the peer-to-peer upgrade once a relayed
 * connection exists. `addresses.listen: ['/p2p-circuit', '/webrtc']` and
 * this transport list are the exact configuration design note 17 §4 (the
 * relay prototype) and the validated browser-WebRTC prototype (repo notes,
 * `httpeers-plan/prototypes/21-browser-webrtc-prototype-validated/app.ts`)
 * both landed on -- not a guess assembled from the libp2p docs.
 *
 * DIALING THE RELAY AND WAITING FOR THE RESERVATION LIVE IN
 * `../reservation.ts`, re-exported below so this module still reads as the
 * one place a page asks "how do I get a browser node onto the mesh". They
 * moved there in Task 20 because they touch nothing transport-specific and
 * three callers now need them -- this file, `../hub/main.ts`, and
 * `tests/e2e/harness.ts`, the last of which had hand-copied the poll loop
 * rather than import it through this module's `@libp2p/webrtc` dependency.
 *
 * IDENTITY PERSISTS PER ORIGIN, IN INDEXEDDB -- and it lives in
 * `./identity.ts` now, re-exported below. It moved there in Task 24
 * because the hub page needs the key itself, not just a node built from
 * it: `createLibp2p` never hands a generated key back out, and the hub must
 * pass the very same key to `createPeer` so its `mintToken` closure signs
 * as the mesh. See that module for the format contract and for why
 * per-origin identities are deliberate.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { createLibp2p, type ServiceFactoryMap } from "libp2p";
import { hubRelayService, type IsMember, membershipGater } from "@statewalker/httpeers-libp2p";
import { loadOrCreateIdentity } from "./identity.js";

/**
 * Re-exported from `./identity.ts`, which is where they live now -- see
 * this module's own note on the move. A page that imports
 * `IDENTITY_STORAGE_KEY` from here keeps working.
 */
export {
  clearIdentity,
  decodeIdentity,
  encodeIdentity,
  IDENTITY_STORAGE_KEY,
  loadOrCreateIdentity,
  peerIdOf,
} from "./identity.js";

/**
 * Does dialing this address need the permissive gater?
 *
 * libp2p's browser default refuses to dial loopback and private-range
 * addresses. `dev` used to be derived from the PAGE's hostname
 * (`localhost`/`127.0.0.1`), which asks the wrong question: what the gater
 * objects to is the address being DIALLED, not where the page came from. Open
 * the same page at `http://192.168.1.5:5177` and the hostname test says
 * "production" while `httpeers.json` still names a loopback relay -- so every
 * address in the dial is denied and the failure surfaces as
 * `DialDeniedError`, whose message blames the relay for being unreachable
 * when the relay is running perfectly well.
 *
 * Asking it of the address fixes both that case and the LAN one (a page on
 * `192.168.1.5` dialling a relay on `192.168.1.5`, also a private address,
 * also denied). A public relay address returns false and the gater stays at
 * its default, which is the behaviour a deployment wants.
 */
export function dialNeedsPermissiveGater(addr: string): boolean {
  const ip = /\/ip4\/([0-9.]+)/.exec(addr)?.[1];
  if (ip == null) return /\/dns4?\/localhost(\/|$)/.test(addr);
  if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  return m != null && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

export interface CreateBrowserNodeInit {
  /**
   * Relaxes the libp2p connection gater to allow insecure (`ws://`) and
   * private/loopback dials. libp2p 3.x's browser-only default gater denies
   * BOTH on its own (`libp2p/dist/src/config/connection-gater.browser.js`)
   * -- fine in production, where a real deployment's relay is `wss://` on
   * a real DNS name (`../setup/main.ts`'s `relayAddrFamily`), but fatal in
   * local development, where the relay is `ws://127.0.0.1:<port>/ws`: with
   * the default gater EVERY dial this node makes -- to the relay itself,
   * and to every derived `/p2p-circuit/webrtc/p2p/...` peer address -- is
   * denied before any handshake even starts. Precedent:
   * `workspaces/webrun-wire/apps/p2p-demo/lib/browser-node.ts`, which
   * applies exactly this relaxation gated on `import.meta.env.DEV`.
   * Required here (no default), rather than silently inferred from
   * `import.meta.env.DEV`, because THIS file has no bundler-injected `env`
   * of its own to read -- inferring it here would mean guessing at a value
   * only the caller (a Vite-built page, see `../static-server/main.ts`'s
   * "DIST DIRECTORY LAYOUT" note) actually knows.
   */
  dev: boolean;
  /**
   * This node's signing key. Defaults to this origin's persisted identity
   * (`./identity.ts`'s `loadOrCreateIdentity`) -- which is what both
   * ordinary pages want and neither has to say.
   *
   * SUPPLIED BY A CALLER THAT NEEDS THE KEY FOR SOMETHING ELSE TOO, which
   * today means the hub page: `createLibp2p` never gives a key back out,
   * and the hub must hand the SAME key to `createPeer` (`mintToken` signs
   * with it, and a mesh whose hub node and hub signer were different keys
   * would mint tokens no peer could match to the hub it is talking to).
   * Loading it once and passing it here is the only way to guarantee they
   * are the same key rather than two reads that happen to agree.
   */
  privateKey: Ed25519PrivateKey;
  /**
   * Makes this node a HUB: it relays signalling for the peers this answers
   * true for, and for nobody else. See `../hub-relay.ts`. Only the hub page
   * passes it.
   */
  isMember?: IsMember;
}

/**
 * Build this origin's browser libp2p node -- identity loaded/generated,
 * transports and encryption wired, NOT yet dialled anywhere. See
 * `dialRelay` / `waitForCircuitReservation` for the next two steps, kept
 * separate so a caller (`peer-runtime.ts`) can report distinct lifecycle
 * states for "connecting to the relay" and "waiting for the reservation"
 * rather than one opaque await.
 */
export async function createBrowserNode(init: CreateBrowserNodeInit): Promise<Libp2p> {
  // REQUIRED now. It used to fall back to `loadOrCreateIdentity()`, which
  // reached for IndexedDB from a function a Node member also calls — see
  // `./kv.js`. The caller holds the key; this only starts a node with it.
  const privateKey = init.privateKey;

  return createLibp2p({
    privateKey,
    // ONLY A HUB RESERVES ON THE PUBLIC RELAY. A member is reached through
    // its hub (`../hub-link.ts`), so it listens for WebRTC upgrades and
    // nothing else; a `/p2p-circuit` entry here would make libp2p reserve on
    // the first relay it meets -- the public one -- and spend its capacity.
    addresses: { listen: init.isMember != null ? ["/p2p-circuit", "/webrtc"] : ["/webrtc"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      ...(init.dev ? { denyDialMultiaddr: async () => false } : {}),
      // The thunk is read at DECISION time, so it closes the ordering cycle:
      // this node must exist before the hub that answers `isMember` does.
      ...(init.isMember != null ? membershipGater(() => init.isMember as IsMember) : {}),
    },
    services: nodeServices(init.isMember),
  });
}

/** The relay service only on a hub, and only behind its membership test. */
function nodeServices(isMember: IsMember | undefined): ServiceFactoryMap {
  return isMember != null
    ? { identify: identify(), relay: hubRelayService() }
    : { identify: identify() };
}

/**
 * Re-exported from `../reservation.ts`, which is where they live now -- see
 * this module's own note on the move. A page that imports them from here
 * keeps working, and a reader looking for "what happens after
 * `createBrowserNode`" still finds the answer named in this file.
 */
export {
  dialRelay,
  RESERVATION_POLL_ATTEMPTS,
  RESERVATION_POLL_INTERVAL_MS,
  type WaitForCircuitReservationInit,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";

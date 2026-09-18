/**
 * A real mesh, built only from the extracted packages.
 *
 * WHAT THIS IS FOR. Everything else in this package is a COMPILE check: it
 * proves the API is sufficient to express the prototypes. It cannot prove the
 * packages actually work together, and the difference is not academic — the
 * runtime-import test found a published entry point that could not be imported
 * at all while every type check was green.
 *
 * So this stands up the deployment shape for real: a Circuit Relay v2 server,
 * a hub that reserves through it and relays for its own members, and members
 * that dial the relay, reach the hub over a WebRTC circuit, redeem an
 * invitation and reserve on the hub. No stubs, no fakes, one process.
 *
 * MODELLED ON THE PROTOTYPE'S `tests/e2e/harness.ts`, deliberately. That
 * harness is the proven recipe for getting these five components to meet, and
 * the differences here are exactly the extraction's claim: the prototype
 * needed `buildTestPeer` plus a hand-rolled heartbeat loop plus `startHub`;
 * this needs `startMember`, which does all of it.
 *
 * PORT 0 EVERYWHERE. A suite that binds a fixed port fails on any machine
 * already running the stack, and nothing here depends on the number — the
 * relay's address is passed explicitly to everyone who needs it.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Connection, Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import {
  type RuleSet,
  ruleSet,
  selfCertifyingKeys,
  withAccess,
} from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, type FetchHandler, lookupPeer, type Mounts } from "@statewalker/httpeers-core";
import {
  createHub,
  type Hub,
  memoryStorage,
  usesTransportIdentity,
} from "@statewalker/httpeers-hub";
import {
  circuitAddrs,
  dialRelay,
  hubRelayService,
  membershipGater,
  type Peer,
  servePeer,
  signerOf,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { startRelay } from "@statewalker/httpeers-relay";
import { createLibp2p } from "libp2p";

/**
 * The mesh's rules.
 *
 * `app:read` for an ordinary member, and nothing for anyone else — enough to
 * tell "a member calling a member" from "a stranger calling a member", which
 * is the only distinction these tests make.
 */
export const MESH_RULES: RuleSet = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: ['allow if capability("app:read");'],
});

/** Short, because these tests wait on it. Still well above the heartbeat interval below. */
export const PRESENCE_TTL_MS = 8_000;
export const HEARTBEAT_INTERVAL_MS = 800;

export interface Mesh {
  relayAddr: string;
  hubPeerId: string;
  /** The hub's libp2p node, for a test that must act as the hub below `hubPeer`. */
  hubNode: Libp2p;
  hub: Hub;
  hubPeer: Peer;
  /** Mint an invitation for `roles` and return its id. */
  invite(roles?: string[]): Promise<string>;
  stop(): Promise<void>;
}

/**
 * The transports a Node participant needs, and why each one.
 *
 * This is the prototype's hub profile, which it arrived at by failing at
 * runtime first: a node with only `tcp()` could not dial the relay's `/ws`
 * address at all ("The dial request has no valid addresses for peer").
 *
 *   - `webSockets()` — how anything DIALS the relay, which listens on `/ws`.
 *   - `circuitRelayTransport()` — how a reservation is held and how a relayed
 *     address is dialled.
 *   - `webRTC()` — the upgrade a member performs to reach the hub, and the one
 *     two members use to reach each other. The hub can only ANSWER that dial
 *     if it carries this transport and listens on `/webrtc`.
 *   - `tcp()` — same-host direct dials.
 */
function transports() {
  return [webSockets(), circuitRelayTransport(), webRTC(), tcp()];
}

/**
 * The hub's node: listens for circuits and WebRTC upgrades, and relays for its own members.
 * Without `webRTC`, it has no WebRTC transport at all, so it cannot answer the
 * upgrade's signalling -- the in-process stand-in for a hub WebRTC cannot reach.
 */
async function hubNode(
  privateKey: Ed25519PrivateKey,
  isMember: () => (id: string) => boolean,
  webRTCUpgrade: boolean,
  maxRelayReservations: number | undefined,
) {
  return createLibp2p({
    privateKey,
    addresses: {
      listen: webRTCUpgrade
        ? ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"]
        : ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit"],
    },
    transports: webRTCUpgrade ? transports() : [webSockets(), circuitRelayTransport(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      // Loopback and `ws://` are fine here; Node's default gater permits them
      // already, and this states the intent rather than relying on that.
      denyDialMultiaddr: async () => false,
      // A THUNK, because the member store does not exist until after the node
      // does. `membershipGater` reads it at decision time, which is what closes
      // that ordering cycle.
      ...membershipGater(() => isMember()),
    },
    services: {
      identify: identify(),
      // The hub's own relay service unless a test must fill its reservation
      // store; then the same service with a smaller store.
      relay:
        maxRelayReservations == null
          ? hubRelayService()
          : circuitRelayServer({
              reservations: { applyDefaultLimit: true, maxReservations: maxRelayReservations },
            }),
    },
  });
}

/** Run a teardown step, ignoring whatever it throws and whether it is async at all. */
async function quietly(step: () => void | Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    /* teardown */
  }
}

export interface StartMeshInit {
  /**
   * Serve the hub's protocol on LIMITED connections too -- what a hub that
   * members may reach only over a relay circuit needs. Off by default, so
   * every other suite keeps libp2p's refusal.
   */
  serveOnLimitedConnection?: boolean;
  /** Extra hub mounts, behind the same access checks as the hub's own. */
  extraMounts?: Record<string, FetchHandler>;
  /**
   * Whether a member's WebRTC upgrade to the hub can complete. Default `true`.
   * `false` builds the hub with no WebRTC transport, so the upgrade fails at
   * signalling -- fast, where a real unreachable hub fails on an ICE timeout.
   */
  webRTCUpgrade?: boolean;
  /**
   * How many reservations the hub's relay grants before it answers
   * `RESERVATION_REFUSED`. Default: the hub's own (`hubRelayService`). A small
   * number stands in for a production hub whose store has filled up.
   */
  maxRelayReservations?: number;
}

export async function startMesh(init: StartMeshInit = {}): Promise<Mesh> {
  const relayKey = await generateKeyPair("Ed25519");
  const relay = await startRelay({ privateKey: relayKey, port: 0 });

  const relayAddr = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .find((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  if (relayAddr == null) {
    throw new Error(
      `mesh-harness: the relay reported no loopback address; got ${relay.node.getMultiaddrs().join(", ")}`,
    );
  }

  const hubKey = await generateKeyPair("Ed25519");
  // The member store is built below and read through this box — see the thunk
  // note in `hubNode`.
  let memberCheck: (id: string) => boolean = () => false;
  const node = await hubNode(
    hubKey,
    () => memberCheck,
    init.webRTCUpgrade ?? true,
    init.maxRelayReservations,
  );
  const hubPeerId = node.peerId.toString();

  // THE HUB RESERVES ON THE PUBLIC RELAY BEFORE ANY MEMBER JOINS, which is
  // what makes this the deployment shape rather than a loopback approximation
  // of it: by the time a member dials, the hub is reachable the way a page
  // reaches it.
  await dialRelay(node, relayAddr);
  await waitForCircuitReservation(node);

  // THE SAME KEY SIGNS AND SPEAKS, and `signerOf` is the seam that guarantees
  // it: a node built from one key while the hub minted with another would
  // produce tokens whose `mesh` claim named a peer nobody was talking to.
  // `generateSigner()` would have made a SECOND key and looked fine.
  const signer = signerOf(hubKey);
  const hub = await createHub({
    selfPeerId: hubPeerId,
    policies: MESH_RULES,
    storage: memoryStorage(),
    presenceTtlMs: PRESENCE_TTL_MS,
    mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 60_000 }),
    extraMounts: init.extraMounts,
  });
  memberCheck = (id) => hub.isMember(id);

  const hubPeer = await servePeer({
    node,
    mounts: hub.mounts,
    access: withAccess({
      issuer: hubPeerId,
      rules: MESH_RULES,
      selfPeer: hubPeerId,
      keys: selfCertifyingKeys(),
      provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
      // The bootstrap routes MINT THE VERY TOKENS THEY CANNOT REQUIRE, so
      // they are admitted on transport identity alone. Still not open: a
      // request with no proven peer is refused 401 regardless.
      bootstrap: usesTransportIdentity(),
    }),
    serveOnLimitedConnection: init.serveOnLimitedConnection,
  });

  return {
    relayAddr,
    hubPeerId,
    hubNode: node,
    hub,
    hubPeer,
    async invite(roles = ["member"]) {
      const created = await hub.invitations.create(roles, 60_000);
      return created.id;
    },
    async stop() {
      // Every teardown swallows: a suite that fails to stop a node must report
      // the assertion that failed, not the cleanup that followed it.
      // `Libp2p.stop()` is `void | Promise<void>`, hence the wrapper.
      await quietly(() => hubPeer.stop());
      await quietly(() => hub.stop());
      await quietly(() => node.stop());
      await quietly(() => relay.stop());
    },
  };
}

/**
 * Wait until the HUB holds its end of a member's limited circuit.
 *
 * A member's end of a circuit comes up first; the hub registers the inbound end
 * a moment later. Calling the member from the hub before then fails with
 * `NoValidAddressesError` (measured: every time, without this) -- which would
 * make "the member refused" pass for the wrong reason.
 */
export async function hubHoldsCircuitTo(live: Mesh, memberId: string): Promise<Connection> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const held = live.hubNode
      .getConnections()
      .find((c) => c.remotePeer.toString() === memberId && c.status === "open" && c.limits != null);
    if (held != null) return held;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the hub never registered its end of the member's circuit");
}

/** A member's node, built the way `nodePlatform` builds one but with a loopback TCP listener too. */
export async function memberNode(privateKey?: Ed25519PrivateKey): Promise<Libp2p> {
  return createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"] },
    transports: transports(),
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: async () => false },
    services: { identify: identify() },
  });
}

/** What `startMember` needs of a platform here: a node, and nothing else. A Node member mounts no edge and gets no wake events. */
export const testPlatform = {
  createNode: async ({ privateKey }: { privateKey?: Ed25519PrivateKey }) => memberNode(privateKey),
};

export { circuitAddrs, type Mounts };

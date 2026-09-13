/**
 * A hub in a tab — composed from the packages, not provided by one.
 *
 * WHY THIS IS APP CODE. `httpeers-hub` deliberately has no transport: a hub is
 * membership and a mount table, and keeping the wire out is exactly what lets
 * it run somewhere that has no wire of its own. Putting the lifecycle in that
 * package would mean a `httpeers-hub` → `httpeers-libp2p` dependency and
 * would undo the property it exists for. So the composition lives here, the
 * same way the Node hub's `main.ts` composes it there.
 *
 * `httpeers-conformance`'s `rung12_browserHub` compiles this arrangement as a
 * consumer, so if the packages ever stop being sufficient for it, a test says
 * so before this page breaks.
 *
 * SEVEN PIECES, NO NEW MECHANISM:
 *   `createBrowserNode` with a membership gater · `dialRelay` ·
 *   `waitForCircuitReservation` · `circuitAddrs` · `createHub` · `servePeer` ·
 *   `createEdgeDispatch` behind `mountEdge`.
 */

import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import {
  type RuleSet,
  roleNames,
  selfCertifyingKeys,
  withAccess,
} from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import {
  ANONYMOUS,
  forwardLocalOnly,
  lookupPeer,
  type PeerIdStr,
} from "@statewalker/httpeers-core";
import { createHub, type Hub, usesTransportIdentity } from "@statewalker/httpeers-hub";
// The IndexedDB store is behind the hub's BROWSER entry, which is the whole
// point of that split: the root stays runnable where there is no IndexedDB.
import { idbStorage } from "@statewalker/httpeers-hub/browser";
import {
  circuitAddrs,
  dialRelay,
  type Peer,
  servePeer,
  signerOf,
  superviseRelay,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { createEdgeDispatch } from "@statewalker/httpeers-member";
import { createBrowserNode, mountEdge } from "@statewalker/httpeers-member/browser";

/** Coarse lifecycle states the page renders progress against; ordered, each passed once. */
export type HubState =
  | "connecting-relay"
  | "awaiting-reservation"
  | "starting-hub"
  | "mounting-edge"
  | "ready"
  | "stopped";

export interface StartHubInit {
  key: string;
  /**
   * Services this hub serves itself, and the advertisements that make them
   * discoverable.
   *
   * The prototype HARD-MOUNTED a demo `/search` inside the hub's own
   * endpoints, which made the hub's package carry an application's service and
   * -- worse -- mounted it without advertising it, so it was served, gated and
   * INVISIBLE. `createHub` takes both halves as parameters now, and supplying
   * them together here is what keeps them in step.
   */
  extraMounts?: Record<string, (request: Request) => Promise<Response>>;
  ownAdvertisements?: Array<{ id: string; kind: string; title: string }>;
  /** This hub's signing key. Its peerId IS the mesh — see `signerOf`. */
  privateKey: Ed25519PrivateKey;
  relayAddrs: string[];
  rules: RuleSet;
  /** Relax libp2p's dial gater for a loopback relay. Decided from the ADDRESS, not the hostname. */
  dev?: boolean;
  onState?: (state: HubState) => void;
}

export interface HubHandle {
  /** This hub's peerId — and therefore the mesh's name. */
  peerId: PeerIdStr;
  relayAddr: string;
  /** The `/p2p-circuit/webrtc` address a joining page must be told. */
  circuitAddr: string;
  /** Where this page's own `fetch()` reaches the mesh. */
  baseUrl: string;
  hub: Hub;
  peer: Peer;
  node: Libp2p;
  roles(): string[];
  stop(): Promise<void>;
}

export async function startHub(init: StartHubInit): Promise<HubHandle> {
  const onState = init.onState ?? ((): void => {});
  const relayAddr = init.relayAddrs[0];
  if (relayAddr == null) throw new Error("startHub: no relay address");

  onState("connecting-relay");

  // A THUNK, because the member store does not exist until the hub is built,
  // which is after the node. `membershipGater` reads it at decision time,
  // which is what closes that ordering cycle.
  let isMember = (_peerId: string): boolean => false;
  const node = await createBrowserNode({
    privateKey: init.privateKey,
    dev: init.dev ?? false,
    isMember: (peerId) => isMember(peerId),
  });

  const unwind: Array<() => Promise<void>> = [async () => await node.stop()];
  const fail = async (): Promise<never> => {
    for (const step of [...unwind].reverse()) await step().catch(() => {});
    throw new Error("startHub: failed");
  };

  try {
    await dialRelay(node, relayAddr);
    onState("awaiting-reservation");
    const reserved = await waitForCircuitReservation(node);
    // BOTH VARIANTS COME BACK AND ONLY ONE WORKS: the bare `/p2p-circuit` is a
    // LIMITED connection on which libp2p silently refuses the protocol.
    const addrs = circuitAddrs(node);
    const supervisor = superviseRelay({ node, relayAddr });
    unwind.push(async () => supervisor.stop());

    onState("starting-hub");
    // THE SAME KEY SIGNS AND SPEAKS. A node built from one key while the hub
    // minted with another would produce tokens whose `mesh` claim named a peer
    // nobody is talking to.
    const signer = signerOf(init.privateKey);
    const hub = await createHub({
      selfPeerId: node.peerId.toString(),
      policies: init.rules,
      // Survives a reload: members and spent invitation ids are the hub's
      // durable state, and a hub that forgot them on refresh would re-admit
      // every spent code.
      storage: idbStorage(),
      extraMounts: init.extraMounts,
      ownAdvertisements: init.ownAdvertisements,
      mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 5 * 60_000 }),
    });
    isMember = (peerId) => hub.isMember(peerId);
    unwind.push(async () => await hub.stop());

    const selfPeerId = node.peerId.toString();
    const peer = await servePeer({
      node,
      mounts: hub.mounts,
      allowForward: forwardLocalOnly,
      access: withAccess({
        issuer: selfPeerId,
        rules: init.rules,
        selfPeer: selfPeerId,
        keys: selfCertifyingKeys(),
        provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
        // The bootstrap routes MINT the very tokens they cannot require.
        bootstrap: usesTransportIdentity(),
      }),
    });
    unwind.push(async () => await peer.stop());

    onState("mounting-edge");
    // The hub mints a token FOR ITSELF: its own endpoints sit behind the same
    // guard as everyone else's, so a hub with no token could not read its own
    // mesh view through its own edge.
    const selfToken = await mintToken({
      signer,
      sub: selfPeerId,
      roles: ["admin"],
      ttlMs: 5 * 60_000,
    });
    const edge = await mountEdge({
      key: init.key,
      dispatch: createEdgeDispatch({
        key: init.key,
        dispatch: peer.dispatch,
        token: () => selfToken,
      }),
    });
    unwind.push(async () => await edge.stop());

    onState("ready");
    return {
      peerId: selfPeerId,
      relayAddr,
      circuitAddr: addrs.webrtc ?? reserved,
      baseUrl: edge.baseUrl,
      hub,
      peer,
      node,
      // Read off the RULES, never a hard-coded list: a role added to the policy
      // appears in the UI with no second place to update.
      roles: () => roleNames(hub.rules),
      async stop() {
        onState("stopped");
        for (const step of [...unwind].reverse()) await step().catch(() => {});
      },
    };
  } catch {
    return await fail();
  }
}

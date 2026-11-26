/**
 * A hub in a browser runtime, assembled without an edge: a page, an
 * extension's offscreen document, or a runtime with no WebRTC at all.
 *
 * WHY THIS LIVES HERE. `httpeers-hub` has no transport on purpose: a hub is
 * membership and a mount table. Its browser composition (node, relay,
 * reservation, hub, `servePeer`) was app code (`apps/demos`' `hub-runtime.ts`),
 * which every host copied. This is that composition, minus `mountEdge`: a
 * page that wants a same-origin URL mounts one on `peer.dispatch` itself
 * (`./edge`), and an extension's own service worker is its edge.
 *
 * RELAY-ONLY MODE. A runtime without `RTCPeerConnection` (an extension
 * service worker) cannot upgrade a member to WebRTC, so every member stays on
 * the relayed, LIMITED connection, on which libp2p refuses protocols by
 * default and the join dies (`PeerStreamResetError`). `serveOnLimitedConnection:
 * true` serves there too. Every byte then crosses the relay (its per-connection
 * limits apply), and no member can reserve on the hub. Use it only where
 * WebRTC is missing; an offscreen document has WebRTC and should not need it.
 *
 * NOTHING HERE REACHES `@statewalker/webrun-http-browser`.
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
  type FetchHandler,
  forwardLocalOnly,
  lookupPeer,
  type PeerIdStr,
} from "@statewalker/httpeers-core";
import {
  createHub,
  type Hub,
  type KeyValueStorage,
  usesTransportIdentity,
} from "@statewalker/httpeers-hub";
import { idbStorage } from "@statewalker/httpeers-hub/browser";
import {
  circuitAddrs,
  dialRelay,
  type IceServer,
  type Peer,
  servePeer,
  signerOf,
  superviseRelay,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { createBrowserNode } from "./browser-profile.js";

/** Lifecycle states, in order, each reported once. */
export type BrowserHubState =
  | "connecting-relay"
  | "awaiting-reservation"
  | "starting-hub"
  | "ready"
  | "stopped";

export interface StartBrowserHubInit {
  /** The hub's signing key. Its peerId IS the mesh; keep it (IndexedDB) to keep the mesh. */
  privateKey: Ed25519PrivateKey;
  /** The relay to reserve on; the first is used. */
  relayAddrs: readonly string[];
  rules: RuleSet;
  /**
   * Where members and spent invitation ids persist. Default:
   * `idbStorage(storageName)`. Pass `memoryStorage()` for a throwaway hub.
   */
  storage?: KeyValueStorage;
  /**
   * The IndexedDB database `idbStorage` uses when `storage` is omitted.
   * Default `"httpeers-hub"`. Two hubs in one origin (one per mesh in one
   * offscreen document) need two names, or two `storageKey`s.
   */
  storageName?: string;
  /** The key the hub's state is saved under in its storage. Default: `createHub`'s. */
  storageKey?: string;
  /** Services the hub serves itself, and the advertisements that make them discoverable. */
  extraMounts?: Record<string, FetchHandler>;
  ownAdvertisements?: Array<{ id: string; kind: string; title: string }>;
  /** Lifetime of the membership tokens it mints. Default five minutes. */
  tokenTtlMs?: number;
  /** Relay-only mode, for a runtime without WebRTC: see the module comment. Default false. */
  serveOnLimitedConnection?: boolean;
  /** Relax libp2p's dial gater for a loopback relay. Off in production. */
  dev?: boolean;
  /** WebRTC's STUN/TURN servers; unset keeps `@libp2p/webrtc`'s default. */
  iceServers?: readonly IceServer[];
  onState?: (state: BrowserHubState) => void;
}

export interface BrowserHubHandle {
  /** This hub's peerId, and therefore the mesh's name. */
  peerId: PeerIdStr;
  relayAddr: string;
  /** The `/p2p-circuit/webrtc` address a joining member is told (the bare circuit one without WebRTC). */
  circuitAddr: string;
  hub: Hub;
  /** `peer.dispatch` is what an edge mounts. */
  peer: Peer;
  node: Libp2p;
  /** Mint a token for this hub itself (its own endpoints sit behind the same guard). */
  mintSelfToken(roles?: readonly string[]): Promise<string>;
  /** The roles the rules know, read off the rules. */
  roles(): string[];
  stop(): Promise<void>;
}

const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

export async function startBrowserHub(init: StartBrowserHubInit): Promise<BrowserHubHandle> {
  const onState = init.onState ?? ((): void => {});
  const relayAddr = init.relayAddrs[0];
  if (relayAddr == null) throw new Error("startBrowserHub: no relay address");
  const ttlMs = init.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;

  onState("connecting-relay");
  // A THUNK: the member store does not exist until the hub is built, after the node.
  let isMember = (_peerId: string): boolean => false;
  const node = await createBrowserNode({
    privateKey: init.privateKey,
    dev: init.dev ?? false,
    isMember: (peerId) => isMember(peerId),
    ...(init.iceServers != null ? { iceServers: init.iceServers } : {}),
  });

  const unwind: Array<() => Promise<void>> = [async () => await node.stop()];
  const unwindAll = async (): Promise<void> => {
    for (const step of [...unwind].reverse()) await step().catch(() => {});
  };

  try {
    await dialRelay(node, relayAddr);
    onState("awaiting-reservation");
    const reserved = await waitForCircuitReservation(node);
    const addrs = circuitAddrs(node);
    const supervisor = superviseRelay({ node, relayAddr });
    unwind.push(async () => supervisor.stop());

    onState("starting-hub");
    // THE SAME KEY SIGNS AND SPEAKS: the token's mesh is the peer members talk to.
    const signer = signerOf(init.privateKey);
    const selfPeerId = node.peerId.toString();
    const hub = await createHub({
      selfPeerId,
      policies: init.rules,
      storage: init.storage ?? idbStorage(init.storageName),
      ...(init.storageKey != null ? { storageKey: init.storageKey } : {}),
      extraMounts: init.extraMounts,
      ownAdvertisements: init.ownAdvertisements,
      maxTokenTtlMs: ttlMs,
      mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs }),
    });
    isMember = (peerId) => hub.isMember(peerId);
    unwind.push(async () => await hub.stop());

    const peer = await servePeer({
      node,
      mounts: hub.mounts,
      allowForward: forwardLocalOnly,
      ...(init.serveOnLimitedConnection ? { serveOnLimitedConnection: true } : {}),
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

    onState("ready");
    let stopped = false;
    return {
      peerId: selfPeerId,
      relayAddr,
      circuitAddr: addrs.webrtc ?? reserved,
      hub,
      peer,
      node,
      mintSelfToken: async (roles = ["admin"]) =>
        mintToken({ signer, sub: selfPeerId, roles: [...roles], ttlMs }),
      roles: () => roleNames(hub.rules),
      async stop() {
        if (stopped) return;
        stopped = true;
        onState("stopped");
        await unwindAll();
      },
    };
  } catch (error) {
    await unwindAll();
    throw error;
  }
}

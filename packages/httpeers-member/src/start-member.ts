/**
 * `startMember` — the candidate `member` package's entry point.
 *
 * THIS IS `src/browser/peer-runtime.ts`'s `startBrowserPeer` WITH THREE
 * COUPLINGS LIFTED OUT, and nothing else changed. Every step of the join is
 * the proven one, imported from the stack rather than reimplemented:
 * `dialRelay`, `reachHub`, `createPeer`, `resumeMembership`,
 * `redeemInvitation`, `reserveOnHub`, `superviseHubReservation`,
 * `leaveRelay`, `startJoin`, `createRouteEnsurer`, `createEdgeDispatch`.
 * If this file had to re-implement any of them, the seam would be in the
 * wrong place and the rung would have failed.
 *
 * The three couplings, and why each is a platform boundary rather than a
 * preference:
 *
 *   1. `createNode` — `createBrowserNode` hard-codes the browser transport
 *      set (webSockets + webRTC + circuitRelay) and reads the identity key
 *      out of IndexedDB. Node needs `tcp` as well, and its key comes from a
 *      file. The LISTEN ADDRESSES ARE NOT A PLATFORM CHOICE and are kept
 *      identical: a member listens on `/p2p-circuit` + `/webrtc` because it
 *      reserves on its hub, which is what `feat/hub-relay` established.
 *   2. `mountEdge` — the ServiceWorker is how a *page* turns `fetch()` into
 *      a mesh call. Node has no ServiceWorker and needs none: the dispatch
 *      handler IS the edge, callable in process. So the edge is optional,
 *      and `MemberHandle.fetch` is always present — on both platforms it is
 *      the same `createEdgeDispatch` handler, which is the whole isomorphism
 *      claim in one field.
 *   3. `watchWake` — `page-wake.ts` listens on `window`/`document`. A Node
 *      process has no such events; the supervisor's own backstop timer is
 *      what covers it, so the default is a no-op rather than a stub.
 *
 * `rules` replaces `policies`: `peer-runtime.ts` calls the app's `appRules`,
 * which bakes `APP_RULES` — an application's vocabulary — into what ought to
 * be library code. The caller passes a built `RuleSet` instead.
 */

import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { RuleSet } from "@statewalker/httpeers-access";
import { RevocationCache, withAccess } from "@statewalker/httpeers-access";
import type { FetchHandler, MeshView, Mounts, PeerIdStr } from "@statewalker/httpeers-core";
import { ANONYMOUS, forwardLocalOnly, lookupPeer } from "@statewalker/httpeers-core";
import {
  dialRelay,
  leaveRelay,
  reachHub,
  reserveOnHub,
  servePeer,
  superviseHubReservation,
} from "@statewalker/httpeers-libp2p";
import { type ConnectionKind, classifyConnection } from "./connection-kind.js";
import { createEdgeDispatch, type EdgeDispatchInit } from "./edge-dispatch.js";
import type { AdvertisementInput, PresenceRefusal } from "./join.js";
import {
  createRouteEnsurer,
  nextInitialSeq,
  REVOCATION_MAX_STALENESS_MS,
  redeemInvitation,
  resumeMembership,
  startJoin,
} from "./join.js";

/** The mesh a member joins: exactly `httpeers.json`'s two fields. */
export interface MeshConfig {
  relayAddrs: string[];
  hubPeerId: string;
}

/** What a platform's edge gives back. The browser's `mountEdge` already returns this shape. */
export interface MemberEdge {
  /** Where this peer's own `fetch()` reaches the mesh, e.g. `https://origin/peers/`. */
  baseUrl: string;
  stop(): Promise<void>;
}

/** The platform adapters — one per thing that genuinely differs between Node and a page. */
export interface MemberPlatform {
  /** Build the libp2p node. Browser: `createBrowserNode`. Node: `createNodeMemberNode` (`./node.ts`). */
  createNode(init: { privateKey?: Ed25519PrivateKey }): Promise<Libp2p>;
  /**
   * Publish `dispatch` at a local URL. Browser: the ServiceWorker edge, via
   * `@statewalker/webrun-http-browser`'s `SwHttpAdapter`. Omitted under Node,
   * where `MemberHandle.fetch` is the edge.
   */
  mountEdge?(init: { key: string; dispatch: FetchHandler }): Promise<MemberEdge>;
  /** Fires when the host wakes (online / visible / resumed) so the supervisor retries at once. Browser: `watchPageWake`. */
  watchWake?(onWake: () => void): () => void;
}

export interface StartMemberInit {
  /** Mount-prefix first segment, and the ServiceWorker adapter key where there is one. */
  key: string;
  /** This peer's own mount table, served to other members and through its own edge. */
  mounts: Mounts;
  /** This peer's rule set, already built. Replaces `peer-runtime.ts`'s `policies` + `appRules`. */
  rules: RuleSet;
  /** The mesh to join. A page may read it from `httpeers.json`; that fetch is the caller's, not this function's. */
  config: MeshConfig;
  platform: MemberPlatform;
  invitationId?: string;
  privateKey?: Ed25519PrivateKey;
  advertisements?: () => AdvertisementInput[];
  onPresenceRefused?: (refusal: PresenceRefusal) => void;
  onState?: (state: MemberState) => void;
  heartbeatIntervalMs?: number;
  keepaliveIntervalMs?: number;
}

export type MemberState =
  | "connecting-relay"
  | "starting-peer"
  | "dialing-hub"
  | "resuming"
  | "joining"
  | "awaiting-reservation"
  | "mounting-edge"
  | "ready"
  | "stopped";

export type JoinMethod = "resumed" | "redeemed";

export interface MemberHandle {
  peerId: PeerIdStr;
  hubPeerId: string;
  relayAddr: string;
  joinedBy: JoinMethod;
  /**
   * This member's edge, in process. The SAME handler the ServiceWorker
   * serves in a page — `createEdgeDispatch`'s — so a Node caller writes
   * `member.fetch(new Request(\`http://local/${key}/${peer}/x\`))` where a
   * page writes `fetch(\`${baseUrl}${peer}/x\`)`, and both take the identical
   * path from there on.
   */
  fetch: FetchHandler;
  /** Present only where the platform mounted an edge (a page). */
  baseUrl?: string;
  meshView(): MeshView | null;
  token(): string;
  connectionKind(peerId: string): ConnectionKind;
  /**
   * The libp2p node, as an escape hatch.
   *
   * `startBrowserPeer` does not expose it and a page never needs it. It is
   * here because everything that OBSERVES OR PERTURBS THE TRANSPORT has to
   * reach it: `connectionKind` above is already such a thing, and claim 7
   * of this rung — drop the hub link and watch the supervisor restore it —
   * cannot be written without it. A library that hides the node entirely
   * makes its own recovery behaviour untestable from outside.
   */
  node: Libp2p;
  stop(): Promise<void>;
}

export class MemberJoinError extends Error {
  constructor(
    readonly reason:
      | "not-a-member"
      | "duplicate-identity"
      | "presence-refused"
      | "invitation-refused",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MemberJoinError";
  }
}

export async function startMember(init: StartMemberInit): Promise<MemberHandle> {
  const onState = init.onState ?? ((): void => {});
  const relayAddr = init.config.relayAddrs[0];
  if (relayAddr == null) throw new Error("startMember: config.relayAddrs is empty.");
  const hubPeerId = init.config.hubPeerId;

  onState("connecting-relay");
  const node = await init.platform.createNode({ privateKey: init.privateKey });

  const unwind: Array<() => Promise<void>> = [async () => await node.stop()];
  const startFailed = async (): Promise<void> => {
    for (const step of [...unwind].reverse()) await step().catch(() => {});
  };

  try {
    await dialRelay(node, relayAddr);

    onState("starting-peer");
    const revocationCache = new RevocationCache({ maxStalenessMs: REVOCATION_MAX_STALENESS_MS });
    // `createPeer` in the prototype did transport + binding + policy + router
    // in one closed function. Here the three are separate packages that meet
    // at a `FetchHandler`: `servePeer` owns the wire and the router,
    // `withAccess` owns who may do what, and neither imports the other.
    const peer = await servePeer({
      node,
      mounts: init.mounts,
      // WITHOUT THIS A MEMBER CANNOT CALL ANOTHER MEMBER AT ALL. The edge
      // hands `/{peerId}/{path}` to `peer.dispatch`, and the router refuses to
      // forward unless asked — deny by default, which is right (R-2: relaying
      // is its own capability). `createPeer` in the prototype supplied this
      // policy; the extraction split it into `servePeer` + `withAccess` and
      // dropped it, and every type check stayed green because a missing
      // optional callback is not a type error. A real mesh found it in one
      // call: 403 `this peer does not relay for you`, from the CALLER's own
      // router.
      allowForward: forwardLocalOnly,
      access: withAccess({
        issuer: hubPeerId,
        rules: init.rules,
        selfPeer: node.peerId.toString(),
        // What the TRANSPORT proved. `serveTransport` registers it on the
        // request before dispatch, so reading it back here is the same fact,
        // not a second opinion.
        provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
        revocation: revocationCache,
      }),
    });
    unwind.push(async () => await peer.stop());

    onState("dialing-hub");
    await reachHub(node, relayAddr, hubPeerId);

    onState("resuming");
    const seq = nextInitialSeq();
    const resume = await resumeMembership({
      peer,
      hubPeerId,
      addrs: node.getMultiaddrs().map((addr) => addr.toString()),
      advertisements: init.advertisements?.(),
      seq,
    });

    let initialToken: string;
    let joinedBy: JoinMethod;
    if (resume.status === "resumed") {
      initialToken = resume.token;
      joinedBy = "resumed";
    } else if (resume.refusal.kind === "duplicate-identity") {
      throw new MemberJoinError(
        "duplicate-identity",
        `another live peer is already using this identity (${peer.peerId}) on this mesh.`,
      );
    } else if (resume.refusal.kind !== "not-a-member") {
      throw new MemberJoinError(
        "presence-refused",
        `the hub (${hubPeerId}) refused this peer's first heartbeat: ${resume.refusal.message}`,
      );
    } else if (init.invitationId == null) {
      throw new MemberJoinError(
        "not-a-member",
        `the hub (${hubPeerId}) does not list this peer (${peer.peerId}) as a member, and no ` +
          "invitation was supplied.",
      );
    } else {
      onState("joining");
      try {
        const redemption = await redeemInvitation(peer, hubPeerId, init.invitationId);
        initialToken = redemption.token;
        joinedBy = "redeemed";
      } catch (err) {
        throw new MemberJoinError(
          "invitation-refused",
          `the hub (${hubPeerId}) would not accept that invitation. ${String(err)}`,
          { cause: err },
        );
      }
    }

    // A MEMBER RESERVES ON ITS HUB, NOT ON THE PUBLIC RELAY, and only once
    // the hub has accepted it — `hub-relay.ts`'s membership gater refuses
    // everyone else. This is the ordering `feat/hub-relay` established.
    onState("awaiting-reservation");
    await reserveOnHub(node, hubPeerId);

    const supervisor = superviseHubReservation({ node, relayAddr, hubPeerId });
    const unwatchWake = init.platform.watchWake?.(() => supervisor.poke()) ?? ((): void => {});
    unwind.push(async () => {
      unwatchWake();
      supervisor.stop();
    });

    await leaveRelay(node, relayAddr).catch(() => {});

    const join = startJoin({
      peer,
      node,
      hubPeerId,
      relayAddr,
      initialToken,
      initialSeq: seq,
      revocationCache,
      advertisements: init.advertisements,
      onPresenceRefused: init.onPresenceRefused,
      heartbeatIntervalMs: init.heartbeatIntervalMs,
      keepaliveIntervalMs: init.keepaliveIntervalMs,
    });
    unwind.push(async () => join.stop());

    onState("mounting-edge");
    const dispatchInit: EdgeDispatchInit = {
      dispatch: peer.dispatch,
      key: init.key,
      token: () => join.token(),
      ensureRoute: createRouteEnsurer({
        node,
        relayAddr,
        selfPeerId: peer.peerId,
        hubPeerId,
        meshView: () => join.meshView(),
      }),
    };
    const edgeFetch = createEdgeDispatch(dispatchInit);
    const edge = await init.platform.mountEdge?.({ key: init.key, dispatch: edgeFetch });
    if (edge != null) unwind.push(async () => await edge.stop());

    onState("ready");
    return {
      peerId: peer.peerId,
      hubPeerId,
      relayAddr,
      joinedBy,
      fetch: edgeFetch,
      baseUrl: edge?.baseUrl,
      node,
      meshView: () => join.meshView(),
      token: () => join.token(),
      connectionKind(peerIdStr: string): ConnectionKind {
        try {
          return classifyConnection(
            node
              .getConnections(peerIdFromString(peerIdStr))
              .filter((c) => c.status === "open")
              .map((c) => c.remoteAddr.toString()),
          );
        } catch {
          return "none";
        }
      },
      async stop() {
        for (const step of [...unwind].reverse()) await step().catch(() => {});
        onState("stopped");
      },
    };
  } catch (err) {
    await startFailed();
    throw err;
  }
}

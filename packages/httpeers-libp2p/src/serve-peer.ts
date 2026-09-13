/**
 * A mount table, served to the mesh.
 *
 * THE SEAM THREE ASSEMBLIES COLLAPSE INTO. The prototype builds a peer three
 * times — the Node hub, the browser hub and the test hub — each wiring a node,
 * a reservation, identity registration, a router and mounts in its own order,
 * and the coverage audit found that the one symbol every assembly turns on was
 * exported nowhere. This is it.
 *
 * WHAT IT DOES NOT DO, and the omission is the design. It does not verify a
 * token, evaluate a policy, or know what a hub is. `access` is a middleware
 * the caller supplies — `withAccess` from `@statewalker/httpeers-access`, or
 * nothing at all for a peer that trusts its transport — because this package
 * must not learn about Biscuit and `httpeers-access` must not learn about
 * libp2p. They meet at a `FetchHandler`, which is the only contract either
 * needs.
 *
 * IDENTITY IS REGISTERED BEFORE ANYTHING DOWNSTREAM RUNS. `serveTransport`
 * gives every inbound stream its own `Duplex` closing over that stream's
 * Noise-proven `remotePeer`, and calls `registerPeer` on the request before
 * the handler sees it. That ordering is the whole basis of the binding check:
 * a token's subject is compared against what the TRANSPORT proved, never
 * against anything the caller said.
 */

import type { Libp2p } from "@libp2p/interface";
import type { FetchHandler, Mounts, PeerIdStr } from "@statewalker/httpeers-core";
import { createPeerRouter } from "@statewalker/httpeers-core";
import { createRemote, PROTOCOL, serveTransport } from "./transport.js";

export interface ServePeerInit {
  node: Libp2p;
  /**
   * What this peer serves. A value, or a factory taking the peer's own id —
   * a hub's endpoints need to know which mesh they are, and the alternative
   * is for this package to learn what a hub is.
   */
  mounts: Mounts | ((self: PeerIdStr) => Mounts);
  /**
   * Everything between the transport and the mounts: identity binding and
   * policy. Omitted, requests reach the mounts with only the transport's
   * proof — which is a legitimate shape for a peer whose mounts are public,
   * and a serious mistake for one whose are not.
   *
   * Passed through to the router, which applies it to LOCAL handling only.
   * That distinction is load-bearing and easy to lose: wrapping the whole
   * router instead would run policy over FORWARDED requests too, and an
   * outbound call is not this peer's business to authorize.
   */
  access?: (next: FetchHandler) => FetchHandler;
  /**
   * May this request be forwarded to `target`? **Deny by default**, and the
   * default is inherited rather than restated here.
   *
   * Relaying is a distinct capability, not a side effect of knowing how to
   * route: without it any peer can make this one dial a third party and pump
   * a stream on its behalf. The hole is invisible for a while because it
   * fails CLOSED at the far end — the third party rejects the tokenless
   * request, so every observable outcome looks right. The damage is the work
   * done, not the answer given.
   */
  allowForward?: (request: Request, target: PeerIdStr) => Promise<boolean>;
  protocol?: string;
  /** Forwarded to the transport; see `transport.ts` for what each bounds. */
  maxInboundStreams?: number;
  maxOutboundStreams?: number;
  drainTimeoutMs?: number;
}

export interface Peer {
  peerId: PeerIdStr;
  /** Every multiaddr this node is reachable on, right now. */
  addrs(): string[];
  /** Inbound, after identity binding and policy. Exposed so an edge can reuse it locally. */
  dispatch: FetchHandler;
  /** Call another peer. The request's URL path is what the far side routes on. */
  call(peerId: PeerIdStr, request: Request): Promise<Response>;
  stop(): Promise<void>;
}

export async function servePeer(init: ServePeerInit): Promise<Peer> {
  const peerId = init.node.peerId.toString();
  const protocol = init.protocol ?? PROTOCOL;

  const mounts = typeof init.mounts === "function" ? init.mounts(peerId) : init.mounts;

  const remote = createRemote({
    node: init.node,
    protocol,
    maxOutboundStreams: init.maxOutboundStreams,
  });

  const dispatch = createPeerRouter({
    selfPeerId: peerId,
    mounts,
    remote,
    access: init.access,
    allowForward: init.allowForward,
  });

  const stopServing = await serveTransport({
    node: init.node,
    dispatch,
    protocol,
    maxInboundStreams: init.maxInboundStreams,
    maxOutboundStreams: init.maxOutboundStreams,
    drainTimeoutMs: init.drainTimeoutMs,
  });

  let stopped = false;
  return {
    peerId,
    addrs: () => init.node.getMultiaddrs().map((a) => a.toString()),
    dispatch,
    call: async (target, request) => remote(target, request),
    async stop() {
      // Idempotent: an assembly that tears down twice — a page unloading while
      // a test also cleans up — must not see the second call throw.
      if (stopped) return;
      stopped = true;
      await stopServing();
    },
  };
}

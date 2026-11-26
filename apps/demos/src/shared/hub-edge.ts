/**
 * The hub page's edge: `createEdgeDispatch`, plus the one fact a self-call needs.
 *
 * The edge is a local ingress. It strips any proven-peer header (a page builds
 * the requests that enter it, so a header there is a claim) and attaches the
 * hub's own token, whose subject is the hub. A request the hub serves itself
 * (`/<self>/...`, or no peer prefix at all) then meets `withAccess` with no
 * proven peer, and the token's `check if bound($k), connection_peer($k)` fails:
 * `401 token subject does not match connected peer` on every call the page made
 * to its own hub (statewalker/httpeers#165).
 *
 * THE PAGE IS THE HUB. Its edge is reachable only from its own origin, and
 * what it calls the hub with is the hub's own token, so a request this peer
 * serves itself is bound to the hub's own peer id, after the edge has
 * stripped whatever the caller claimed. A request for another peer stays
 * unbound: the router forwards only local requests (`forwardLocalOnly`), and
 * an outbound call carries no identity of the caller's.
 */

import { type FetchHandler, type PeerIdStr, registerPeer } from "@statewalker/httpeers-core";
import { createEdgeDispatch, targetPeerId } from "@statewalker/httpeers-member";

export interface HubEdgeInit {
  /** The edge's mount key, the first path segment it strips. */
  key: string;
  /** The hub's own peer id. */
  selfPeerId: PeerIdStr;
  /** `servePeer`'s `dispatch`: the router behind `withAccess`. */
  dispatch: FetchHandler;
  /** The hub's token for itself, read per request. */
  token: () => string;
}

export function hubEdgeDispatch(init: HubEdgeInit): FetchHandler {
  const { selfPeerId, dispatch } = init;
  return createEdgeDispatch({
    key: init.key,
    token: init.token,
    dispatch: async (request) => {
      const target = targetPeerId(new URL(request.url).pathname);
      if (target == null || target === selfPeerId) registerPeer(request, selfPeerId);
      return await dispatch(request);
    },
  });
}

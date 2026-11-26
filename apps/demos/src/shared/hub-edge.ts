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
 * ONLY THE HUB PAGE'S OWN CALLS ARE BOUND TO THE HUB. The ServiceWorker takes
 * every same-origin request under the edge's key, navigations included, so
 * any other site can START a request here: a link, an iframe, a form POST, an
 * `<img>`. Binding by path alone would hand those the hub's admin identity.
 * So a request is bound only when its referrer is this page's own origin
 * (`ownOrigin`): the transfer from the ServiceWorker keeps the referrer, and a
 * page rebuilding a request with a cross-origin referrer gets `about:client`
 * instead, so a cross-site request fails closed. Everything else goes through
 * unbound, as before, and is refused where a token is needed.
 *
 * A request for another peer is never bound: the router forwards only local
 * requests (`forwardLocalOnly`), and an outbound call carries no identity of
 * the caller's. The binding happens after the edge has stripped whatever the
 * caller claimed.
 */

import { type FetchHandler, type PeerIdStr, registerPeer } from "@statewalker/httpeers-core";
import { createEdgeDispatch, targetPeerId } from "@statewalker/httpeers-member";

export interface HubEdgeInit {
  /** The edge's mount key, the first path segment it strips. */
  key: string;
  /** The hub's own peer id. */
  selfPeerId: PeerIdStr;
  /** The hub page's origin (`location.origin`): only requests it referred are bound to the hub. */
  ownOrigin: string;
  /** `servePeer`'s `dispatch`: the router behind `withAccess`. */
  dispatch: FetchHandler;
  /** The hub's token for itself, read per request. */
  token: () => string;
}

export function hubEdgeDispatch(init: HubEdgeInit): FetchHandler {
  const { key, selfPeerId, dispatch, token } = init;
  const plain = createEdgeDispatch({ key, token, dispatch });
  // The edge rebuilds the request without its referrer, so the decision is
  // made here, on the request as it arrived, and picks the edge to run.
  const bound = createEdgeDispatch({
    key,
    token,
    dispatch: async (request) => {
      const target = targetPeerId(new URL(request.url).pathname);
      if (target == null || target === selfPeerId) registerPeer(request, selfPeerId);
      return await dispatch(request);
    },
  });
  return async (request) =>
    referredBy(request, init.ownOrigin) ? await bound(request) : await plain(request);
}

/** Whether `request.referrer` is a URL of `origin`. `""`, `about:client` and anything else: no. */
function referredBy(request: Request, origin: string): boolean {
  try {
    return new URL(request.referrer).origin === origin;
  } catch {
    return false;
  }
}

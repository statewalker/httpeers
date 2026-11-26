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
 * ONLY THE HUB PAGE'S OWN CALLS ARE BOUND TO THE HUB, AND THEY SAY SO. The
 * ServiceWorker takes every same-origin request under the edge's key, and
 * navigations too, so another site can START a request here (a link, an
 * iframe, a form POST). Binding by path alone would hand those the hub's admin
 * identity. What another site cannot do is set a header: a cross-site `fetch`
 * or `<img>` never reaches this origin's ServiceWorker, and a navigation
 * carries no custom header. So the page's own calls carry `HUB_SELF_HEADER`
 * (`asHub`), and only a request carrying it is bound. Neither the request's
 * `mode` nor its referrer is usable: `webrun-http-link/2` carries only the
 * url, method and headers from the ServiceWorker to the page.
 *
 * The header is removed before anything is dispatched, so it never reaches the
 * router, a mount, or another peer. A request for another peer is never bound:
 * the router forwards only local requests (`forwardLocalOnly`), and an outbound
 * call carries no identity of the caller's. The binding happens after the edge
 * has stripped whatever the caller claimed.
 */

import {
  bodyOf,
  type FetchHandler,
  type PeerIdStr,
  registerPeer,
} from "@statewalker/httpeers-core";
import { createEdgeDispatch, targetPeerId } from "@statewalker/httpeers-member";

/** Set by the hub page's own calls to its hub through its edge (`asHub`). Never forwarded. */
export const HUB_SELF_HEADER = "x-httpeers-hub-self";

/** `init` for a call the hub page makes to its own hub through its edge. */
export function asHub(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(HUB_SELF_HEADER, "1");
  return { ...init, headers };
}

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
  const { key, selfPeerId, dispatch, token } = init;
  const plain = createEdgeDispatch({ key, token, dispatch });
  const bound = createEdgeDispatch({
    key,
    token,
    dispatch: async (request) => {
      const target = targetPeerId(new URL(request.url).pathname);
      if (target == null || target === selfPeerId) registerPeer(request, selfPeerId);
      return await dispatch(request);
    },
  });
  return async (request) => {
    // Decided on the request as it arrived, then removed on a copy (request
    // headers may be immutable) before either edge sees it.
    const asHubCall = request.headers.get(HUB_SELF_HEADER) === "1";
    const headers = new Headers(request.headers);
    headers.delete(HUB_SELF_HEADER);
    const body = await bodyOf(request);
    const stripped = new Request(request.url, {
      method: request.method,
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
      signal: request.signal,
    });
    return asHubCall ? await bound(stripped) : await plain(stripped);
  };
}

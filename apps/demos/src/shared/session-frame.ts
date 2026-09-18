/**
 * Open a mesh peer's app in a fresh session origin, `<random>.p.httpeers.net`.
 *
 * THIS REPLACES THE SAME-ORIGIN GHOST IFRAME. `httpeers-ghost` rendered a
 * foreign app in an iframe on the VIEWER's own origin, behind the viewer's own
 * ServiceWorker. Measured on 2026-09-15: a hostile app in that frame read the
 * viewer's `localStorage`, enumerated the IndexedDB holding its identity key,
 * and rewrote the viewer's DOM, and the ghost's CSP stopped none of it. An
 * origin is one trust domain, and the frame was inside it.
 *
 * Here the app gets an origin of its own. It keeps what the ghost gave it --
 * one peer, reached through `pinnedPeer`, so it still cannot walk the mesh --
 * and loses what it should never have had: the viewer's storage, DOM and
 * worker are now cross-origin to it. Its only channel back is the port, and
 * every request on it lands in `pinnedPeer`, which can name one peer.
 *
 * AND ROOT-ABSOLUTE URLs NOW WORK. Inside the session, `/app.js` is the
 * session's own path and reaches the app's peer; on the viewer's origin it
 * was the viewer's file -- the escape `contain` existed to stop.
 */

import type { PeerIdStr } from "@statewalker/httpeers-core";
import { pinnedPeer } from "@statewalker/httpeers-ghost";
import { openSession, type Session } from "@statewalker/httpeers-session-shell/client";

export interface OpenAppInit {
  /** The peer serving the app. The only peer the app will be able to reach. */
  peerId: PeerIdStr;
  /** The app's mount on that peer, e.g. `/spa`. */
  appPath: string;
  /** Call a peer through this page's member -- `handle.fetch` behind the edge. */
  call: (peerId: PeerIdStr, request: Request) => Promise<Response>;
  /** This page's membership token, read per request. */
  token: () => string;
  /** Where the visible iframe goes. */
  container: HTMLElement;
}

export interface OpenedApp {
  session: Session;
  frame: HTMLIFrameElement;
  close(): void;
}

export async function openAppInSession(init: OpenAppInit): Promise<OpenedApp> {
  const handler = pinnedPeer({
    landing: { peerId: init.peerId, appPath: init.appPath },
    // The whole session origin is the app's: `/` there is `appPath/` on the peer.
    basePath: "/",
    token: init.token,
    remote: init.call,
  });

  const session = await openSession({ handler, container: init.container });

  const frame = document.createElement("iframe");
  frame.src = session.url("/");
  frame.title = `app from ${init.peerId.slice(0, 16)}… in ${session.origin}`;
  // `allow-same-origin` keeps the session's OWN origin -- without it the frame
  // is opaque, which no ServiceWorker controls. It is safe here, as it is not
  // for a same-origin frame, because that origin is not ours. What the list
  // leaves out is the point: no `allow-top-navigation`, so the app cannot send
  // this tab elsewhere; no `allow-popups`, so it cannot open windows.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals");
  init.container.append(frame);

  return {
    session,
    frame,
    close() {
      frame.remove();
      session.close();
    },
  };
}

/**
 * `call` for a page: route a pinned request through this page's member.
 *
 * `pinnedPeer` hands over a request for `http://peer.local/<appPath>/...`;
 * the member's edge takes `http://local/<edge key>/<peer>/...`.
 *
 * THE BODY IS BUFFERED. Firefox cannot stream a request body at all (it has
 * no `Request.prototype.body`), a demo app's uploads are small, and one path
 * for both browsers beats a stream that only one of them can produce.
 */
export function callThroughMember(
  memberFetch: (request: Request) => Promise<Response>,
  edgeKey: string,
): (peerId: PeerIdStr, request: Request) => Promise<Response> {
  return async (peerId, request) => {
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return memberFetch(
      new Request(`http://local/${edgeKey}/${peerId}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: body != null && body.byteLength > 0 ? body : null,
        signal: request.signal,
      }),
    );
  };
}

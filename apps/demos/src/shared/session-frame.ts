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
 * Here the app gets an origin of its own. Its only channel back is the port,
 * and a session now serves it TWO things on that one connection: the app
 * itself, pinned to the one peer that serves it (`pinnedPeer`, at `/`), and
 * the mesh, mounted at `MESH_PREFIX` (`createGateway`). The app still cannot
 * walk the mesh THROUGH ITS OWN ROOT -- `pinnedPeer` holds that peer id, not
 * the URL -- but it can address any peer the parent can see under `/peers/`,
 * which is the decision spec §3.2 records: the app calls any peer as the
 * viewer, bounded by each target peer's own ingress policy, and never sees
 * the membership token because the parent's edge attaches it after the
 * request has left the app.
 *
 * AND ROOT-ABSOLUTE URLs NOW WORK. Inside the session, `/app.js` is the
 * session's own path and reaches the app's peer; on the viewer's origin it
 * was the viewer's file -- the escape `contain` existed to stop.
 */

import type { FetchHandler, MeshView, PeerIdStr } from "@statewalker/httpeers-core";
import { bodyOf, MESH_CREDENTIAL_HEADERS } from "@statewalker/httpeers-core";
import { pinnedPeer } from "@statewalker/httpeers-ghost";
import { createGateway } from "@statewalker/httpeers-member";
import {
  APP_SERVICE_KEY,
  MESH_PREFIX,
  MESH_SERVICE_KEY,
  openSession,
  type Session,
  type SessionService,
} from "@statewalker/httpeers-session-shell/client";
import { EDGE_KEY } from "./policy.js";

/** What a session needs of this page's membership, read per request. */
export interface MeshMember {
  peerId: PeerIdStr;
  /**
   * The proven edge dispatch: `/{edgeKey}/{peerId}/{path}` in, mesh call out.
   * A READER, not a value -- `session.ts` replaces the whole `MemberHandle`
   * object on every reconnect (a new `startMember()`, a new `fetch` closure
   * bound to a new libp2p node) and sets it to `null` on disconnect. A
   * snapshot taken once, when the session opens, would point at a stopped
   * node for the life of the iframe and never recover, because nothing
   * reassigns it. `null` is how "this page has left the mesh" is expressed.
   */
  fetch: () => FetchHandler | null;
  /** Read per request -- a peer that joined a second ago must be reachable. */
  meshView: () => MeshView | null;
  /** This page's membership token. The app never sees it. */
  token: () => string;
}

export interface OpenMeshAppInit {
  /** The peer serving the app shown at the session's root. */
  peerId: PeerIdStr;
  /** That app's mount on that peer, e.g. `/spa`. */
  appPath: string;
  member: MeshMember;
  /** Where the visible iframe goes. */
  container: HTMLElement;
  /** How long a handler may take before the session gets a 504. Default 20 s. */
  deadlineMs?: number;
}

export interface OpenedApp {
  session: Session;
  frame: HTMLIFrameElement;
  close(): void;
}

/**
 * A bound on how long a session's app may take to answer.
 *
 * The relay has no timeout of its own, so a handler that never settles leaves
 * the iframe waiting forever with nothing to show. The parent is the party
 * that knows what the app is, so the bound lives here.
 */
export function withDeadline(
  handler: (request: Request) => Promise<Response>,
  ms: number,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handler(request),
        new Promise<Response>((resolve) => {
          timer = setTimeout(
            () =>
              resolve(
                new Response(`the app did not answer within ${ms} ms`, {
                  status: 504,
                  headers: { "content-type": "text/plain; charset=utf-8" },
                }),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Ingress for the route the app addresses ITSELF: drop every mesh credential
 * the caller supplied, so the edge attaches the VIEWER's.
 *
 * A session's app is foreign code on that origin. `createGateway` strips the
 * proven-peer header, but the member's edge deliberately does NOT overwrite a
 * membership token a caller already set (a page that wrote one "meant it"), so
 * without this the app chose the credential its call travelled under -- its
 * own bad token (a self-DoS), or, read from anywhere it could reach one, the
 * serving peer's, which would put that peer's membership on the viewer's
 * connection and make the audit trail name the wrong party. `pinnedPeer` has
 * enforced the same rule at the root since it was written ("the page may not
 * choose the mesh credential"), and `docs/security-model.md` §6 claims 1 and 3
 * assert it for every call a session makes.
 *
 * ONLY ON THE MESH PATH, never in `dispatch`. `dispatch` also carries
 * `pinnedPeer`'s requests, and `pinnedPeer` attaches the viewer's token BEFORE
 * they reach it -- a strip there would remove the credential it just set and
 * leave the session's root route unauthenticated.
 */
export function withoutMeshCredentials(handler: FetchHandler): FetchHandler {
  return async (request) => {
    // In place, as `stripPeerBinding` does on this same request one frame
    // down inside `createGateway`: these requests are built by the relay page
    // from a port message, so their headers are mutable.
    for (const name of MESH_CREDENTIAL_HEADERS) request.headers.delete(name);
    return await handler(request);
  };
}

/** What a session serves for a mesh app: the app at `/`, the mesh at `/peers/`. */
export function meshAppServices(init: OpenMeshAppInit): SessionService[] {
  const deadlineMs = init.deadlineMs ?? 20_000;

  // READ PER REQUEST, NEVER CAPTURED. `session.ts` replaces the whole
  // MemberHandle on every reconnect, so a snapshot taken when the session
  // opened points at a stopped node for the life of the iframe -- and would
  // never recover, because nothing reassigns it.
  const dispatch: FetchHandler = async (request) => {
    const live = init.member.fetch();
    if (live == null) {
      return new Response("this page left the mesh", { status: 503 });
    }
    return await live(request);
  };

  const app = pinnedPeer({
    landing: { peerId: init.peerId, appPath: init.appPath },
    basePath: "/",
    token: init.member.token,
    remote: callThroughMember(dispatch, EDGE_KEY),
  });
  const mesh = withoutMeshCredentials(
    createGateway({
      source: {
        peerId: init.member.peerId,
        fetch: dispatch,
        meshView: init.member.meshView,
      },
      // The library does NOT strip the mount prefix, and createGateway strips
      // this one itself -- so the two line up exactly, and stripping here too
      // would send the edge a path with no peer in it.
      basePath: MESH_PREFIX.replace(/\/$/, ""),
      edgeKey: EDGE_KEY,
    }),
  );
  return [
    { key: APP_SERVICE_KEY, path: "/", handler: withDeadline(app, deadlineMs) },
    { key: MESH_SERVICE_KEY, path: MESH_PREFIX, handler: withDeadline(mesh, deadlineMs) },
  ];
}

export async function openMeshApp(init: OpenMeshAppInit): Promise<OpenedApp> {
  const session = await openSession({ services: meshAppServices(init), container: init.container });

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
 * THE BODY IS CORE'S `bodyOf`, NOT A FOURTH COPY OF IT. Firefox has no
 * `Request.prototype.body` at all, so a forwarder that reads `request.body`
 * there sends every POST on empty and silent; `bodyOf` streams where the
 * runtime can and buffers where it cannot. This file hand-rolled the buffered
 * half and streamed nowhere -- the same logic, in a fourth place, with one
 * browser's behaviour baked in for both.
 */
export function callThroughMember(
  memberFetch: (request: Request) => Promise<Response>,
  edgeKey: string,
): (peerId: PeerIdStr, request: Request) => Promise<Response> {
  return async (peerId, request) => {
    const url = new URL(request.url);
    const body = await bodyOf(request);
    return memberFetch(
      new Request(`http://local/${edgeKey}/${peerId}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
        signal: request.signal,
      }),
    );
  };
}

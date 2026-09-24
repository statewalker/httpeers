/**
 * The one module that sits between a page's own `fetch()` and this peer's
 * `dispatch`. Everything a request needs in order to survive the crossing
 * page -> ServiceWorker -> `SwHttpAdapter` -> `peer.dispatch` lives here,
 * and nowhere else -- above all, NOT in the page.
 *
 * IT EXISTS SO THAT A PAGE IS AN ORDINARY HTTP CLIENT. The project's
 * central bet is that application code calls a mesh peer with a plain
 * `fetch()` -- no SDK, no client library. A page that had to hand-assemble
 * a bearer header on every call, strip a mount prefix, or parse an error
 * message string to tell "gone" from "refused" would have an SDK; it would
 * just be an undocumented one, reimplemented per page. This module is the
 * runtime's side of that bet.
 *
 * Kept dependency-free of libp2p AND of `@statewalker/webrun-http-browser`
 * on purpose (only `httpeers.core`, all of it pure): that is what lets
 * every rule below be proven under plain Node in `tests/browser-edge-
 * dispatch.test.ts` rather than deferred to Task 15's Playwright run.
 *
 * THREE JOBS, IN ORDER.
 *
 * 1. STRIP THE EDGE'S OWN MOUNT PREFIX. Verified directly against
 *    `@statewalker/webrun-http-browser@workspace:0.3.3`, not assumed:
 *    `SwHttpAdapter._handleHttpRequest` (`src/sw/http-sw-dispatcher.ts`)
 *    selects a handler by `requestUrl.indexOf(urlPrefix) === 0` and then
 *    calls `handler(request)` with the ORIGINAL, UNMODIFIED request. So a
 *    page fetching `${baseUrl}${peerId}/search` -- where `baseUrl` ends in
 *    `/${key}/`, and `key` must be the first path segment
 *    (`edge-guard.ts`'s `assertKeyMatchesPrefix`; `SwHttpDispatcher` keys
 *    its channel lookup on that segment, so mounting at `/` is not
 *    available) -- reaches `dispatch` with pathname
 *    `/${key}/${peerId}/search`. `httpeers.core`'s router
 *    (`router.ts`'s `route`) reads the FIRST segment and asks
 *    `looksLikePeerId`; `key` is not a peer id, so the request is served
 *    LOCALLY against a path no mount claims -- a 404 whose body says "not
 *    found", three layers away from the mistake. Stripping the prefix here
 *    is what makes the router see `/${peerId}/search`, which is the shape
 *    it documents.
 *
 * 2. ATTACH THE MEMBERSHIP TOKEN (Ruling 59). `peer.call()` turns a
 *    `{ token }` option into a `MESH_TOKEN_HEADER` header (`peer-request.ts`);
 *    `fetch()` has no such option, so without this every mesh call from a
 *    page would arrive at the provider tokenless and be refused 401. The
 *    token is NOT the page's to hold: it rotates on each 5 s heartbeat
 *    inside `startJoin`'s closure (`join.ts`), so a page that read one and
 *    kept it would be sending a stale token within seconds. `token()` is
 *    therefore called per request, never snapshotted.
 *
 * 3. TURN A THROWN `PeerCallError` INTO A RESPONSE (Ruling 60). `remote()`
 *    THROWS T-2's typed error; nothing between it and the page converts it
 *    to a Response, and `SwHttpDispatcher`'s own catch
 *    (`http-sw-dispatcher.ts`) collapses any thrown handler error into a
 *    bare 500 with no body. A page would then see one indistinguishable
 *    500 for a departed peer, a reset stream and a timeout -- precisely the
 *    "no way to tell 'this peer is gone' from 'this peer refused you'
 *    without parsing a message string" that `httpeers.core`'s `errors.ts`
 *    exists to end. The mapping below forwards `kind` in the body so the
 *    page can `switch` on it.
 *
 * WHY THE STATUS TABLE LIVES IN THE APP AND NOT IN `httpeers.core`. Same
 * split the core already uses for `allowForward` (supplied by the caller,
 * never decided in the router): a status code is policy. `errors.ts`
 * anticipated this crossing -- `kind` exists, in its own words, "so a
 * caller can `switch` on it, or forward it across a boundary that cannot
 * carry a class reference" -- but anticipating the crossing is not owning
 * the status choice.
 *
 * 4. MAKE SURE A ROUTE TO THE TARGET PEER EXISTS FIRST (Task 15). Added
 *    after the Playwright suite found that this had NEVER worked: a page
 *    calling ANOTHER PAGE got `peer-unreachable`, every time, while a Node
 *    peer calling that same browser provider over the same relay got a 200.
 *    The cause is not in the provider and not in the transport --
 *    `httpeers.core`'s `remote()` dials by PEER ID, which resolves through
 *    libp2p's peerStore, and a browser peer's peerStore entry for another
 *    browser peer is either absent or a bare `/p2p-circuit` address that
 *    libp2p refuses to open `/httpeers/1.0.0` over. Something has to dial
 *    `<relay>/p2p-circuit/webrtc/p2p/<peer>` explicitly, exactly as
 *    `peer-runtime.ts` already does for the HUB at startup, and the page
 *    cannot be the thing that does it without becoming the SDK this module
 *    exists to prevent. So the edge does it, through the `ensureRoute` hook
 *    below -- a callback, so this module stays libp2p-free and testable
 *    under plain Node (see the note above).
 *
 *    IT NEVER FAILS THE CALL ITSELF. A dial that throws is swallowed and
 *    `dispatch` is attempted anyway: the call that follows produces T-2's
 *    own typed `PeerCallError` -- with the right `kind` for the page to
 *    render -- whereas a rethrow here would surface as an untyped 500 from
 *    `SwHttpDispatcher`'s catch and lose exactly the distinction job 3
 *    exists to preserve.
 *
 * THIS IS A LOCAL INGRESS, AND ONLY THAT. Traffic arriving from other peers
 * over libp2p does NOT come through here -- `serveTransport` dispatches it to
 * `peer.dispatch` directly, which is what keeps our token off it (handing our
 * token to inbound traffic would let any peer that can reach us borrow our
 * membership for a call to a third party).
 *
 * So the first thing this does is STRIP the proven-peer header. A page builds
 * the requests that enter its own edge; a header here is a claim, not a fact,
 * and nothing downstream can tell the difference. An earlier version branched
 * on `lookupPeer(req) !== undefined` to mean "arrived from the network" --
 * correct while that binding was a WeakMap a page could not write, and a
 * forgery hole the moment it became a header. `tests/ingress-forgery.test.ts`
 * holds that shut.
 */
import type { FetchHandler, PeerErrorKind, PeerIdStr } from "@statewalker/httpeers-core";
import {
  bodyOf,
  json,
  MESH_TOKEN_HEADER,
  PeerCallError,
  setMeshToken,
  stripPeerBinding,
} from "@statewalker/httpeers-core";

/**
 * `PeerErrorKind` -> HTTP status, the whole table.
 *
 * A timeout is a 504 (`Gateway Timeout`) because that is literally what
 * happened: this peer, acting as the page's gateway onto the mesh, gave up
 * waiting for the peer behind it. Everything else is a 502 (`Bad Gateway`):
 * the upstream peer could not be reached, does not speak the protocol, reset
 * the stream, blew a relay limit, or offered only a limited connection the
 * call did not opt in to -- all of them "the gateway could not
 * get an answer from upstream", none of them a fault in the request the page
 * made. Deliberately never a 5xx that would blame the page's own request
 * (a 400-family status), and never a 500: a 500 here is reserved for a
 * genuine bug (see `createEdgeDispatch`'s rethrow).
 */
export const PEER_ERROR_STATUS: Readonly<Record<PeerErrorKind, number>> = {
  "request-timeout": 504,
  "peer-unreachable": 502,
  "protocol-unsupported": 502,
  "stream-reset": 502,
  "relay-limit-exceeded": 502,
  "limited-connection": 502,
  unknown: 502,
};

/** The body shape a page reads back from a failed mesh call. `kind` is the discriminant to `switch` on; `error` is for a human, never for a `switch`. */
export interface PeerErrorBody {
  error: string;
  kind: PeerErrorKind;
  peerId: string;
}

export interface EdgeDispatchInit {
  /** This peer's own router -- `peer.dispatch`. Never called with a modified request unless the request originated locally; see the module comment. */
  dispatch: FetchHandler;
  /** The ServiceWorker adapter key. Requests arriving from the page still carry `/${key}` on their path -- job 1 above. */
  key: string;
  /** This peer's current membership token, READ AT CALL TIME -- `JoinHandle.token`. */
  token: () => string;
  /**
   * Establish a usable route to `peerId` before the call rides it -- job 4
   * above. Optional: omitting it restores the pre-Task-15 behaviour, which
   * is correct for a caller whose peers are already connected (every Node
   * suite in this app) and broken for a browser page (see job 4).
   *
   * CALLED FOR EVERY PEER-ID-SHAPED FIRST SEGMENT, INCLUDING THIS PEER'S
   * OWN. This module knows the shape of a peer id (`targetPeerId`) and not
   * which one it is: `createEdgeDispatch` is never told its own peer id, and
   * giving it one only to skip a call would duplicate a check the
   * implementation has to make anyway. `join.ts`'s `createRouteEnsurer` is
   * where "that is us" is recognised and returns immediately. An
   * implementation that does not know its own id must therefore tolerate
   * being asked to route to itself.
   *
   * Called once per outbound request that names a peer; an implementation is
   * expected to be cheap when a route already exists, because it is on the
   * path of every single mesh call the page makes.
   */
  ensureRoute?: (peerId: PeerIdStr) => Promise<void>;
}

/**
 * The peer id an outbound request is addressed to -- the first path segment,
 * when it looks like one -- or `null` for a request this peer serves itself.
 *
 * THE SHAPE TEST IS A COPY, AND IT SHOULD NOT BE. `httpeers.core`'s
 * `router.ts` has exactly this function (`looksLikePeerId`) and it is the
 * one that decides, three layers down, whether the first segment is treated
 * as a peer id at all. It is not exported, so this module cannot share it,
 * and a copy that drifts from it would make `ensureRoute` dial for requests
 * the router serves locally (harmless -- the dial is skipped for a
 * non-member) or, worse, skip the dial for requests the router forwards
 * (the Task 15 bug, back again). Reported to the core package rather than
 * worked around further; see this task's report.
 */
export function targetPeerId(pathname: string): PeerIdStr | null {
  const [, first = ""] = pathname.split("/");
  const looksLikePeerId =
    /^12D3Koo[A-Za-z0-9]{40,}$/.test(first) ||
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(first) ||
    /^k51[a-z0-9]{55,}$/.test(first);
  return looksLikePeerId ? first : null;
}

/**
 * Removes a leading `/${key}` segment from `pathname`, respecting segment
 * boundaries: with `key` `"app"`, `/app/x` -> `/x` and `/app` -> `/`, but
 * `/application/x` is left alone (it is not this prefix, it merely starts
 * with the same characters -- the same trap `httpeers.core`'s own mount
 * matching documents in `router.ts`, "`/test` does NOT match `/testing`").
 *
 * Exported for its own test: this is pure string logic and there is no
 * reason to reach it only through a Request.
 */
export function stripEdgePrefix(pathname: string, key: string): string {
  const prefix = `/${key}`;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/**
 * Wraps `dispatch` with the three jobs above, for mounting on the
 * ServiceWorker edge (`edge.ts`'s `mountEdge`). The result is still a plain
 * `FetchHandler`, so `mountEdge` keeps passing a handler through unchanged
 * and nothing about that contract changes.
 */
export function createEdgeDispatch(init: EdgeDispatchInit): FetchHandler {
  const { dispatch, key } = init;

  return async function edgeDispatch(req: Request): Promise<Response> {
    // THE EDGE IS A LOCAL INGRESS, ALWAYS. Strip any proven-peer header the
    // caller supplied: a page builds the requests that enter its own edge, so
    // a header here is a CLAIM, never a fact, and `withAccess` downstream
    // cannot tell the two apart.
    //
    // This used to return early when a binding was present, on the reading
    // "it arrived from the network, not ours to touch". That was safe while
    // the binding lived in a WeakMap no page could write; with a header it
    // let a page name itself any peer AND skip the token attachment. The
    // branch is removed rather than repaired, because a network request never
    // reaches here anyway -- `serveTransport` dispatches to `peer.dispatch`
    // directly. See `tests/ingress-forgery.test.ts`.
    stripPeerBinding(req);

    const url = new URL(req.url);
    url.pathname = stripEdgePrefix(url.pathname, key);
    // `new Request(url, req)` reads `req.body` off the init object -- and
    // FIREFOX HAS NO `Request.prototype.body` (checked against 155), so that
    // read is `undefined` there and the outbound request loses its body
    // entirely, silently. Rebuilt explicitly through `bodyOf`, the one copy
    // of this logic, exactly as `gateway.ts` and the ghost's `pin.ts` already
    // do for the same reason.
    const body = await bodyOf(req);
    const outbound = new Request(url, {
      method: req.method,
      headers: req.headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
      signal: req.signal,
    });
    // NEVER OVERWRITE A CALLER'S OWN MEMBERSHIP TOKEN. A page that set one
    // deliberately -- calling a peer with a token it was handed out of band,
    // or testing what a provider does with a bad one -- meant it, and
    // silently replacing it would make that call untestable and its failure
    // inexplicable.
    //
    // `Authorization` is not looked at at all. It is the page's header for
    // the application it is calling (LiteLLM's dashboard puts its own key
    // there); when the token lived in it too, a page that set it got no mesh
    // token and the provider refused the application key `malformed-token`.
    if (!outbound.headers.has(MESH_TOKEN_HEADER)) {
      setMeshToken(outbound.headers, init.token());
    }

    // Job 4. Before the call, not after a failure: a retry-on-failure shape
    // would turn every genuinely-unreachable peer into two attempts and a
    // doubled wait, and it would still be wrong for the case that matters
    // (the first call to a peer this page has never dialed, which is most
    // of them).
    const target = targetPeerId(url.pathname);
    if (init.ensureRoute != null && target != null) {
      // Swallowed deliberately -- see job 4's second paragraph.
      await init.ensureRoute(target).catch((err: unknown) => {
        console.warn(`edge: could not establish a route to ${target}:`, err);
      });
    }

    try {
      return await dispatch(outbound);
    } catch (err) {
      // `instanceof` ONLY, and rethrow everything else. A genuine bug in a
      // handler must still surface as `SwHttpDispatcher`'s 500 rather than
      // be dressed up as a network condition the page will politely offer
      // to retry -- the failure mode this mapping exists to prevent, turned
      // inside out.
      if (!(err instanceof PeerCallError)) throw err;
      const body: PeerErrorBody = { error: err.message, kind: err.kind, peerId: err.peerId };
      return json(body, PEER_ERROR_STATUS[err.kind]);
    }
  };
}

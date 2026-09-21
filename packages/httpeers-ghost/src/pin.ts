/**
 * The candidate `ghost` package's core: a forwarder PINNED to one peer.
 *
 * WHAT THE GHOST IS. From the 2026-08-22 notes: not an application, but "the
 * mechanism by which an application hosted by one peer is launched from
 * another" — an invitation, one mount, one reachable peer. The host serves
 * HTML, assets and endpoints under its own peerId; the viewer renders them;
 * no source code travels.
 *
 * WHY A PIN IS NEEDED AT ALL, AND WHAT IS WRONG WITHOUT ONE. The stack's
 * `createEdgeDispatch` reads the target peer out of the FIRST PATH SEGMENT
 * and attaches the viewer's own membership token to whatever it forwards. A
 * page rendered through it can therefore address ANY peer in the mesh, with
 * the viewer's credentials, simply by fetching a different first segment.
 * That is correct for the viewer's own app and wrong for a foreign one: a
 * ghost renders someone else's HTML, and that HTML must not be able to walk
 * the mesh on the viewer's behalf.
 *
 * The pin is therefore not a convenience wrapper over edge-dispatch — it is a
 * DIFFERENT handler that never reads a peer id from the request at all. The
 * peer is supplied once, at mount time, and the path is data.
 */

import type { FetchHandler, PeerIdStr } from "@statewalker/httpeers-core";
import { bodyOf, PEER_ID_HEADER, setMeshToken } from "@statewalker/httpeers-core";

/** Where a ghost points: one peer, one path under it. Signed by the hub in a real deployment. */
export interface Landing {
  peerId: PeerIdStr;
  /** The host's mount for this app, e.g. `/app`. */
  appPath: string;
}

export interface PinnedPeerInit {
  landing: Landing;
  /** Call `peerId`'s handler. In the mesh this is `peer.dispatch` behind the router; in a test, a double. */
  remote: (peerId: PeerIdStr, request: Request) => Promise<Response>;
  /** The viewer's membership token, read per call. Attached to requests bound for the pinned peer, and to nothing else. */
  token: () => string;
  /** Where the ghost is mounted locally, e.g. `/ghost/`. Stripped before the host sees the path. */
  basePath: string;
  /** Establish a route before the call rides it. Optional, exactly as in edge-dispatch. */
  ensureRoute?: (peerId: PeerIdStr) => Promise<void>;
}

/** Refusals this handler emits, so a test can tell a pin refusal from a host 404. */
export const PIN_REFUSED = "x-httpeers-ghost";

/**
 * A handler that reaches exactly one peer.
 *
 * There is no code path from a request to a peer id: `landing.peerId` is the
 * only peer this closure can name. A path that LOOKS like it addresses another
 * peer is treated as a path, and — because a foreign page trying that is the
 * attack this exists to stop — it is refused outright rather than forwarded to
 * the host as an odd-looking path.
 */
export function pinnedPeer(init: PinnedPeerInit): FetchHandler {
  const base = init.basePath.endsWith("/") ? init.basePath : `${init.basePath}/`;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(base)) {
      return refuse("outside the ghost's mount");
    }

    const rest = url.pathname.slice(base.length - 1);

    // A first segment shaped like a peer id is the giveaway: the rendered page
    // is trying to address the mesh the way the viewer's own app would.
    // Refused loudly — and note this is belt and braces, since there is no way
    // for it to take effect even if it were not checked.
    const firstSegment = rest.split("/").filter(Boolean)[0];
    if (firstSegment != null && looksLikePeerId(firstSegment)) {
      return refuse(`a ghost may reach only ${init.landing.peerId}`);
    }

    await init.ensureRoute?.(init.landing.peerId);

    // The host sees its own mount plus the path, and never the viewer's origin.
    const target = new URL(`${init.landing.appPath}${rest}${url.search}`, "http://peer.local");
    const headers = new Headers(request.headers);
    // IDENTITY-FREE ONWARD. The rendered page is someone else's HTML in the
    // viewer's browser, so every header it can set is attacker-controlled --
    // and `new Headers(request.headers)` copies all of them. The host peer
    // rebinds from its own transport at ingress, so a value arriving here is
    // at best noise and at worst a claim.
    headers.delete(PEER_ID_HEADER);
    // The VIEWER's token, replacing any the page wrote: the page may not choose
    // the mesh credential. `Authorization` is the page's own header for its
    // own app and passes through -- the mesh never reads it.
    setMeshToken(headers, init.token());

    const body = await bodyOf(request);
    const forwarded = new Request(target, {
      method: request.method,
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
      signal: request.signal,
    });

    return init.remote(init.landing.peerId, forwarded);
  };
}

function refuse(why: string): Response {
  return new Response(`ghost: ${why}`, { status: 403, headers: { [PIN_REFUSED]: "pinned" } });
}

/**
 * The same shape test `httpeers.core`'s router uses, copied for the third time
 * in this codebase (`router.ts`'s `looksLikePeerId`, `edge-dispatch.ts`'s
 * `targetPeerId`, and now here). The extracted `core` package should export it
 * once; a drifting copy is how a pin stops matching what the router routes.
 */
function looksLikePeerId(segment: string): boolean {
  return segment.length >= 46 && segment.startsWith("12D3Koo");
}

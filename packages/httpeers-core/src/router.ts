/**
 * Block R. Pure, isomorphic, zero transport imports.
 *
 * Addressing: `/{peerId}/rest/of/path` routes to that peer. A path with no
 * peer prefix, or one naming this peer, is served locally.
 *
 * MOUNT SEMANTICS (R-1):
 *  - longest prefix wins, regardless of registration order
 *  - segment boundaries are respected: `/test` does NOT match `/testing`
 *  - the root mount `/` catches everything and loses to any specific mount
 *  - a trailing slash is normalised away: `provide('/api/')` and
 *    `provide('/api')` are the same mount, and both match `/api` and
 *    `/api/x`. An earlier version of this router treated `/api/` and `/api`
 *    as different prefixes — a silent, single-path divergence with nothing
 *    to warn you it had happened. Normalising removes the trap instead of
 *    documenting it.
 */
import { copyPeerBinding } from "./peer-context.js";
import type { FetchHandler, Mounts, PeerIdStr, Remote } from "./types.js";
import { json } from "./types.js";

export interface PeerRouterInit {
  selfPeerId: PeerIdStr;
  mounts: Mounts;
  remote: Remote;
  /** Applied to LOCAL handling only. Outbound requests are not our business. */
  access?: (h: FetchHandler) => FetchHandler;
  /**
   * May this request be forwarded to `target`?
   *
   * DENY BY DEFAULT. Relaying is a distinct capability, not a side effect of
   * knowing how to route: without this, any peer can make us dial a third
   * party and pump a stream on its behalf (R-2).
   *
   * That hole is invisible for a while because it fails CLOSED at the far
   * end — the third party rejects the tokenless request, so every observable
   * outcome looks right. The damage is the work done, not the answer given.
   *
   * The caller supplies the policy. The usual one is "forward requests that
   * originated locally — from our own edge — but never requests that
   * arrived from the network."
   */
  allowForward?: (req: Request, target: PeerIdStr) => Promise<boolean>;
}

/** Peer ids in this system are Ed25519, so base58 `12D3Koo…`, or base36 `k51…`. */
function looksLikePeerId(segment: string): boolean {
  return (
    /^12D3Koo[A-Za-z0-9]{40,}$/.test(segment) ||
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(segment) ||
    /^k51[a-z0-9]{55,}$/.test(segment)
  );
}

export function createPeerRouter(init: PeerRouterInit): FetchHandler {
  const { selfPeerId, mounts, remote } = init;
  const wrap = init.access ?? ((h: FetchHandler) => h);
  const allowForward = init.allowForward ?? (async () => false);

  const local: FetchHandler = async (req) => {
    const { pathname } = new URL(req.url);
    const handler = mounts.match(pathname);
    if (handler == null) return json({ error: "not found", path: pathname }, 404);
    return handler(req);
  };

  const guarded = wrap(local);

  return async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, first = "", ...rest] = url.pathname.split("/");

    if (!looksLikePeerId(first)) {
      return guarded(req); // no peer prefix: serve locally
    }

    const remainder = `/${rest.join("/")}`;

    if (first === selfPeerId) {
      // Addressed to us by name. Strip the prefix and serve locally.
      const stripped = new Request(new URL(remainder + url.search, url.origin), req);
      copyPeerBinding(req, stripped); // the re-creation the WeakMap must survive
      return guarded(stripped);
    }

    // Someone else's peer. Relaying is a capability, so ask first.
    if (!(await allowForward(req, first))) {
      return json({ error: "this peer does not relay for you" }, 403);
    }

    // Forward. Outbound is identity-free by definition.
    //
    // NOTE: there is no hop limit. Two relay-enabled peers can form a cycle.
    // A max-forwards header or a hop count in the envelope is required
    // before any relay ships.
    const forwarded = new Request(new URL(remainder + url.search, url.origin), req);
    return remote(first, forwarded);
  };
}

/** Trim a trailing slash so `/a`, `/a/` and `a` all compare the same way. */
function norm(prefix: string): string {
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

/** Simple longest-prefix mount table. */
export function createMounts(): Mounts & {
  provide: (prefix: string, handler: FetchHandler) => void;
} {
  const table: Array<{ prefix: string; handler: FetchHandler }> = [];
  return {
    provide(prefix, handler) {
      table.push({ prefix: norm(prefix), handler });
      table.sort((a, b) => b.prefix.length - a.prefix.length);
    },
    match(path) {
      const target = norm(path);
      const hit = table.find(
        (m) => m.prefix === "/" || target === m.prefix || target.startsWith(`${m.prefix}/`),
      );
      return hit?.handler ?? null;
    },
  };
}

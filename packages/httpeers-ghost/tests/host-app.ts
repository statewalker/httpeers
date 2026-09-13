/**
 * The HOST peer's app, as a plain handler.
 *
 * Standing in for a remote peer's mounted site: it serves an HTML page, a
 * relative asset and an endpoint. The transport is not under test here — rung
 * 01 already carries a real mesh call — so this is invoked directly by the
 * ghost's `remote`, which is exactly the seam a real deployment fills with
 * `peer.dispatch`.
 *
 * The page it serves deliberately fetches THREE ways, because the difference
 * between them is what this rung measures:
 *   - `asset.txt`      — relative, resolves inside the ghost's mount
 *   - `/static/escape.txt` — root-absolute, resolves against the VIEWER's origin
 *   - `/ghost/<other peer>/x` — an attempt to walk the mesh
 */

import type { FetchHandler, PeerIdStr } from "@statewalker/httpeers-core";

/** A peer id the ghost is NOT pinned to. */
export const OTHER_PEER: PeerIdStr = "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR";

export interface HostLog {
  /** Every path the host was asked for, in order — so a test can see what did and did not arrive. */
  seen: string[];
  /** The authorization header of the last request, to check the viewer's token is attached. */
  lastAuth: string | null;
}

export function createHostApp(log: HostLog, useBaseHref: boolean): FetchHandler {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    log.seen.push(url.pathname);
    log.lastAuth = request.headers.get("authorization");

    if (url.pathname === "/app/asset.txt") {
      return new Response("asset-from-host", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/app/" || url.pathname === "/app") {
      const base = useBaseHref ? '<base href="/ghost/">' : "";
      return new Response(
        `<!doctype html><html><head>${base}</head><body>
<h1 id="title">hosted by another peer</h1>
<script type="module">
  const say = (k, v) => parent.postMessage({ k, v }, "*");
  // 1 — relative: should reach the host through the pin.
  try { say("relative", await (await fetch("asset.txt")).text()); }
  catch (e) { say("relative", "ERR " + e); }
  // 2 — root-absolute: resolves against the VIEWER's origin, not the host's.
  try { const r = await fetch("/static/escape.txt"); say("rootAbsolute", r.status + ":" + (await r.text())); }
  catch (e) { say("rootAbsolute", "ERR " + e); }
  // 3 — an attempt to address a different peer through the ghost's mount.
  try { const r = await fetch("/ghost/${OTHER_PEER}/anything"); say("otherPeer", String(r.status)); }
  catch (e) { say("otherPeer", "ERR " + e); }
</script>
</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("host: not found", { status: 404 });
  };
}

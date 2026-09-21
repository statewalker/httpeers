/**
 * `/spa/...` -- a single-page app the hub serves over the mesh, so that the
 * app page has something to open in a session.
 *
 * WHAT IT SHOWS, BY DESIGN. Every line it renders is a property of the
 * session origin it runs in, not of the app:
 *
 *   - `location.origin` -- a `<random>.p.httpeers.net`, never the viewer's;
 *   - a visit counter in `localStorage` and a cookie -- both start fresh in
 *     every new session, because each session is its own origin;
 *   - `/api/hello`, fetched ROOT-ABSOLUTE -- in a session that is the
 *     session's own path, served by this peer, not a file on the viewer's
 *     origin. It is the escape a same-origin ghost iframe could not contain;
 *   - whether a ServiceWorker controls it, which proves the page came through
 *     the session's worker rather than from the shell's static files;
 *   - THREE CALLS THAT NAME A PEER IN THE PATH, through the session's mesh
 *     mount at `/peers/`: a GET, a POST, and one to a peer that is not in the
 *     mesh. `/api/hello` above is the pinned root -- it reaches the one peer
 *     that serves this app and cannot be steered anywhere else -- so it
 *     proves nothing about addressing the mesh. These do, and they are the
 *     shape a real app uses to call a provider it did not come from.
 *
 * NO BUILD, NO FRAMEWORK. Three strings, so the "app" is exactly what the
 * mesh carries and nothing a bundler added.
 *
 * THIS MODULE MUST STAY FREE OF `node:` IMPORTS: the hub page runs it in a tab.
 */

import type { FetchHandler, PeerIdStr } from "@statewalker/httpeers-core";
import { json } from "@statewalker/httpeers-core";
import { Hono } from "hono";

/** What the hub advertises. The mount is `/${id}`, which is what a viewer opens. */
export const SPA_ADVERTISEMENT = { id: "spa", kind: "app", title: "Session demo app" } as const;

/** What the demo SPA needs of the peer that serves it. */
export interface DemoSpaInit {
  /**
   * The peer that serves this app -- READ PER REQUEST, never captured.
   *
   * The page needs it because a `/peers/<peerId>/...` call has to name a peer,
   * and the only peer a demo can be sure is in the mesh is the one that just
   * answered. A reader rather than a value because the hub's mounts are built
   * before its libp2p node is up: the id derived from the signing key stands
   * in until `startHub` returns the node's own, and they must agree (the same
   * key produced both). If they ever did not, this page's mesh rows would
   * name a peer nobody is talking to -- visible, rather than silent.
   */
  selfPeerId: () => PeerIdStr;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>httpeers · a mesh app in a session</title>
<link rel="stylesheet" href="./style.css" />
<h1>A mesh app, in its own origin</h1>
<dl>
  <dt>origin</dt><dd id="origin">…</dd>
  <dt>visits here</dt><dd id="visits">…</dd>
  <dt>cookies here</dt><dd id="cookies">…</dd>
  <dt>worker</dt><dd id="worker">…</dd>
  <dt>/api/hello</dt><dd id="api">…</dd>
  <dt>GET /peers/&lt;peer&gt;/</dt><dd id="mesh-get">…</dd>
  <dt>POST /peers/&lt;peer&gt;/</dt><dd id="mesh-post">…</dd>
  <dt>/peers/&lt;not a member&gt;/</dt><dd id="mesh-missing">…</dd>
</dl>
<script src="/app.js"></script>
`;

const STYLE_CSS = `body { font: 14px/1.5 system-ui, sans-serif; margin: 1rem; color: #18181b; }
h1 { font-size: 1.05rem; margin: 0 0 .6rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: 0; }
dt { color: #52525b; }
dd { margin: 0; font-family: ui-monospace, monospace; font-size: .85em; word-break: break-all; }
`;

/**
 * The page's whole script.
 *
 * ES5-PLAIN ON PURPOSE (`var`, `function`, no template literals): it is a
 * string served over the mesh, not a compiled module, so nothing type-checks
 * or transpiles it and the browser is the only thing that will ever read it.
 *
 * THE MESH CALLS ARE CHAINED OFF `/api/hello`, because the peer id comes from
 * it. A session's `/peers/` mount is the member's edge shape, so the peer is
 * named in the path -- which is exactly what the pinned root refuses to let
 * the app choose, and exactly what an app talking to a second peer needs.
 */
const APP_JS = `(function () {
  var $ = function (id) { return document.getElementById(id); };
  $("origin").textContent = location.origin;
  var visits = Number(localStorage.getItem("visits") || "0") + 1;
  localStorage.setItem("visits", String(visits));
  $("visits").textContent = String(visits);
  document.cookie = "session-host=" + location.hostname + "; path=/; SameSite=Lax; Secure";
  $("cookies").textContent = document.cookie || "(none)";
  $("worker").textContent = navigator.serviceWorker && navigator.serviceWorker.controller
    ? "controlled by " + new URL(navigator.serviceWorker.controller.scriptURL).pathname
    : "not controlled";

  // Every row settles to SOMETHING, success or failure: a row left at "…" is
  // indistinguishable from a call still in flight, and a checker waiting on it
  // would report a timeout instead of the failure that caused it.
  function fail(id, error) {
    $(id).textContent = "failed: " + error;
  }

  function meshGet(peer) {
    fetch("/peers/" + peer + "/spa/api/hello")
      .then(function (r) { return r.json(); })
      .then(function (body) { $("mesh-get").textContent = body.message + " (at " + body.at + ")"; })
      .catch(function (e) { fail("mesh-get", e); });
  }

  // THE CASE THAT ARRIVED EMPTY IN FIREFOX. There is no Request.prototype.body
  // there, so a gateway that read the body as a stream forwarded nothing and
  // said nothing about it. The echo answers with what it received, and the
  // byte count is reported beside what was sent, so a truncated body is a
  // number that does not match rather than a blank line.
  function meshPost(peer) {
    var sent = JSON.stringify({ from: location.hostname, nonce: String(Date.now()) });
    fetch("/peers/" + peer + "/spa/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sent
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        $("mesh-post").textContent =
          body.echoed + " (" + body.bytes + " bytes of " + sent.length + " sent)";
      })
      .catch(function (e) { fail("mesh-post", e); });
  }

  // REFUSED, NOT HUNG. "nobody" is not a peer id, so nothing is dialled and
  // the answer is a status from this page's own member -- the point being that
  // there IS an answer, and promptly, where a mesh call into the void would
  // otherwise leave the app waiting for the session's 20 s deadline.
  function meshMissing() {
    var started = Date.now();
    fetch("/peers/nobody/spa/api/hello")
      .then(function (r) {
        $("mesh-missing").textContent = r.status + " in " + (Date.now() - started) + " ms";
      })
      .catch(function (e) {
        $("mesh-missing").textContent = "threw after " + (Date.now() - started) + " ms: " + e;
      });
  }

  fetch("/api/hello")
    .then(function (r) { return r.json(); })
    .then(function (body) {
      $("api").textContent = body.message + " (at " + body.at + ")";
      if (!body.peer) {
        var absent = "no peer id in /api/hello";
        $("mesh-get").textContent = absent;
        $("mesh-post").textContent = absent;
        $("mesh-missing").textContent = absent;
        return;
      }
      meshGet(body.peer);
      meshPost(body.peer);
      meshMissing();
    })
    .catch(function (e) {
      fail("api", e);
      fail("mesh-get", "/api/hello did not answer");
      fail("mesh-post", "/api/hello did not answer");
      fail("mesh-missing", "/api/hello did not answer");
    });
})();
`;

function text(body: string, type: string): Response {
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "no-cache" },
  });
}

/** The app, mounted at `/spa`. */
export function createDemoSpa(init: DemoSpaInit): FetchHandler {
  // NOT STRICT: a session's `/` arrives as `/spa/`, and `/spa` must work too.
  const app = new Hono({ strict: false }).basePath(`/${SPA_ADVERTISEMENT.id}`);
  const index = () => text(INDEX_HTML, "text/html; charset=utf-8");
  app.get("/", index);
  app.get("/index.html", index);
  app.get("/style.css", () => text(STYLE_CSS, "text/css; charset=utf-8"));
  app.get("/app.js", () => text(APP_JS, "text/javascript; charset=utf-8"));
  // `peer` IS THE POINT: it is how the page learns which peer to address
  // explicitly under `/peers/`. Whoever answered names themselves.
  app.get("/api/hello", () =>
    json({
      message: "hello from the hub, over the mesh",
      at: new Date().toISOString(),
      peer: init.selfPeerId(),
    }),
  );
  // The body back as it arrived, with its length, so a body that was lost on
  // the way is a mismatch a check can see rather than an empty string nobody
  // looks at (`session-frame.ts`, and `webrun-http-browser`'s Firefox case).
  app.post("/api/echo", async (c) => {
    const echoed = await c.req.text();
    return json({
      echoed,
      bytes: new TextEncoder().encode(echoed).length,
      method: c.req.method,
    });
  });
  return app.fetch as FetchHandler;
}

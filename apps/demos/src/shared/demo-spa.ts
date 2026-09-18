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
 *     the session's worker rather than from the shell's static files.
 *
 * NO BUILD, NO FRAMEWORK. Three strings, so the "app" is exactly what the
 * mesh carries and nothing a bundler added.
 *
 * THIS MODULE MUST STAY FREE OF `node:` IMPORTS: the hub page runs it in a tab.
 */

import type { FetchHandler } from "@statewalker/httpeers-core";
import { json } from "@statewalker/httpeers-core";
import { Hono } from "hono";

/** What the hub advertises. The mount is `/${id}`, which is what a viewer opens. */
export const SPA_ADVERTISEMENT = { id: "spa", kind: "app", title: "Session demo app" } as const;

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
</dl>
<script src="/app.js"></script>
`;

const STYLE_CSS = `body { font: 14px/1.5 system-ui, sans-serif; margin: 1rem; color: #18181b; }
h1 { font-size: 1.05rem; margin: 0 0 .6rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: 0; }
dt { color: #52525b; }
dd { margin: 0; font-family: ui-monospace, monospace; font-size: .85em; word-break: break-all; }
`;

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
  fetch("/api/hello")
    .then(function (r) { return r.json(); })
    .then(function (body) { $("api").textContent = body.message + " (at " + body.at + ")"; })
    .catch(function (e) { $("api").textContent = "failed: " + e; });
})();
`;

function text(body: string, type: string): Response {
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "no-cache" },
  });
}

/** The app, mounted at `/spa`. */
export function createDemoSpa(): FetchHandler {
  // NOT STRICT: a session's `/` arrives as `/spa/`, and `/spa` must work too.
  const app = new Hono({ strict: false }).basePath(`/${SPA_ADVERTISEMENT.id}`);
  const index = () => text(INDEX_HTML, "text/html; charset=utf-8");
  app.get("/", index);
  app.get("/index.html", index);
  app.get("/style.css", () => text(STYLE_CSS, "text/css; charset=utf-8"));
  app.get("/app.js", () => text(APP_JS, "text/javascript; charset=utf-8"));
  app.get("/api/hello", () =>
    json({ message: "hello from the hub, over the mesh", at: new Date().toISOString() }),
  );
  return app.fetch as FetchHandler;
}

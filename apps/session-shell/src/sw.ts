/// <reference lib="webworker" />
/**
 * The session's ServiceWorker: the library's relay, plus the refusals that
 * make a session origin a session rather than a shared scratchpad.
 *
 * WHAT THIS FILE NO LONGER DOES. Registration, the client registry, routing
 * and CONNECT plumbing were hand-rolled here because the library's relay could
 * only serve `/~<key>/`. Since 0.6.0 a service claims a path prefix -- the
 * origin root included -- so all of that is the library's again, and what is
 * left is exactly the part that is httpeers policy.
 *
 * WHY THE NAVIGATION CHECK IS A LISTENER AND NOT AN OPTION. It needs
 * `request.mode` and `request.referrer`, which `exclude` (a URL) and
 * `decorateResponse` (after the answer) cannot see, and it must refuse before
 * the request crosses the port. A ServiceWorker calls fetch listeners in
 * registration order and the first to call `respondWith` owns the request, so
 * this one is registered before the relay's.
 */

import { startRelayServiceWorker } from "@statewalker/webrun-http-browser/relay-worker";
import { sessionErrorPage } from "./errors.js";
import {
  frameAncestorsFor,
  isShellPath,
  navigationAllowed,
  RELAY_PATH,
  withFrameAncestors,
} from "./policy.js";

declare const self: ServiceWorkerGlobalScope;

const FRAME_ANCESTORS = frameAncestorsFor(self.location.hostname);

/** The refusal a session gives a navigation that did not come from its app. */
function refuseNavigation(): Response {
  const body =
    `<!doctype html><meta charset="utf-8"><title>Open this session from its app</title>` +
    `<body style="font:15px/1.6 system-ui,sans-serif;margin:2rem">` +
    `<h1 style="font-size:1.2rem">Open this session from its app</h1>` +
    `<p>A session is shown inside the app that opened it. This page was reached some other ` +
    `way, so it is not served.</p>`;
  return new Response(body, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
      "x-httpeers-session": "shell",
    },
  });
}

// REGISTERED BEFORE THE RELAY'S LISTENER, deliberately -- see the file comment.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The shell's own files come from the network, with Caddy's headers.
  if (isShellPath(url.pathname)) return;
  if (navigationAllowed(request.referrer, self.location.origin)) return;
  event.respondWith(refuseNavigation());
});

startRelayServiceWorker(self, {
  // A root mount claims every path, so the shell's own files must be reserved
  // from it or the session cannot bootstrap at all.
  exclude: (url) => isShellPath(url.pathname),
  // THE NAME OF A SESSION IS NOT A SECRET, so a page on this origin proves
  // nothing by existing: only the relay page may register.
  canRegister: (client) => new URL(client.url).pathname === RELAY_PATH,
  // A live app keeps its session; a second relay page cannot take it over.
  takeover: "first-wins",
  decorateResponse: (response, request) =>
    withFrameAncestors(sessionErrorPage(response, request) ?? response, FRAME_ANCESTORS),
});

/// <reference lib="webworker" />
/**
 * The session's ServiceWorker: every path that is not the shell's own is
 * answered by the ghost app, over the port it handed `relay.html`.
 *
 * WHY NOT THE LIBRARY'S RELAY WORKER. `webrun-http-browser` ships one
 * (`relay-sw`), and this worker speaks its protocol unchanged -- REGISTER,
 * UNREGISTER and CONNECT over `callChannel`, then `sendHttpRequest` -- so the
 * ghost side is the library's own `newRemoteRelayChannel` + `initHttpService`.
 * What differs is ROUTING and REFUSAL, which that worker cannot be told:
 *
 *   - it serves only `/~<key>/...` URLs, and finds `~` anywhere in the URL,
 *     query string included. A session serves an app at its ROOT --
 *     `index.html` is the app's, not the shell's.
 *   - any client may REGISTER a key and silently take it over. Here the first
 *     live registrant keeps it, and only from `relay.html`.
 *   - it serves any navigation. Here a navigation must come from the session
 *     itself or a ghost-app origin (`navigationAllowed`), and every response
 *     carries `frame-ancestors`, which a worker-made response would otherwise
 *     lack entirely.
 */

import {
  callChannel,
  HttpError,
  handleChannelCalls,
  sendHttpRequest,
} from "@statewalker/webrun-http-browser";
import { createStore, del, get, set } from "idb-keyval";
import {
  frameAncestorsFor,
  isShellPath,
  navigationAllowed,
  RELAY_PATH,
  SESSION_SERVICE_KEY,
  withFrameAncestors,
} from "./policy.js";

declare const self: ServiceWorkerGlobalScope;

/** How long the app may take to accept a request before the worker gives up on it. */
const CONNECT_TIMEOUT_MS = 15_000;

const FRAME_ANCESTORS = frameAncestorsFor(self.location.hostname);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  // `initServiceWorker` on the relay page waits until the page is CONTROLLED;
  // without claiming, the first visit would wait for a reload that never comes.
  event.waitUntil(self.clients.claim());
});

/**
 * Which client serves the session: the relay page that registered.
 *
 * IN INDEXEDDB, NOT A VARIABLE. A browser stops an idle worker after about
 * thirty seconds and starts a fresh one on the next fetch; a registration held
 * in memory would be gone, and every request after a pause would find no app.
 */
const store = createStore("httpeers-session-shell", "registry");

async function liveClient(): Promise<Client | undefined> {
  const id = await get<string>(SESSION_SERVICE_KEY, store);
  if (id == null) return undefined;
  const client = await self.clients.get(id);
  if (client == null) await del(SESSION_SERVICE_KEY, store); // the ghost closed or reloaded
  return client ?? undefined;
}

handleChannelCalls(self, "REGISTER", async (event, data) => {
  const source = (event as unknown as ExtendableMessageEvent).source as Client | null;
  const { key } = (data ?? {}) as { key?: string };
  if (source == null) throw new Error("REGISTER from an unknown client");
  if (key !== SESSION_SERVICE_KEY) {
    throw new Error(`a session serves one service, "${SESSION_SERVICE_KEY}"; got "${key}"`);
  }
  if (new URL(source.url).pathname !== RELAY_PATH) {
    throw new Error(`only ${RELAY_PATH} may register the session's app`);
  }
  // FIRST LIVE REGISTRANT WINS. The name is not a secret, so a second relay on
  // this origin is not proof of anything; it must not be able to take over a
  // session whose ghost app is still there. A ghost that reloads loses its
  // relay client, so its own re-registration is not blocked by this.
  const current = await liveClient();
  if (current != null && current.id !== source.id) {
    throw new Error("this session is already connected to an app");
  }
  await set(SESSION_SERVICE_KEY, source.id, store);
  return true;
});

handleChannelCalls(self, "UNREGISTER", async (event) => {
  const source = (event as unknown as ExtendableMessageEvent).source as Client | null;
  const current = await liveClient();
  if (current == null || source == null || current.id !== source.id) return false;
  await del(SESSION_SERVICE_KEY, store);
  return true;
});

/** Open a request channel to the app. Resolves the port, or null if the app declined. */
async function connect(client: Client, data: unknown): Promise<MessagePort | null> {
  const channel = new MessageChannel();
  const accepted = await withTimeout(
    callChannel<boolean>(client, "CONNECT", data, channel.port2),
    CONNECT_TIMEOUT_MS,
  );
  return accepted ? channel.port1 : null;
}

// A CONNECT through the port: the library's `callHttpService`, which lets the
// ghost app call its own session without going through `fetch`.
handleChannelCalls(self, "CONNECT", async (_event, data, port: MessagePort) => {
  const client = await liveClient();
  if (client == null) throw new Error("no app is connected to this session");
  return await callChannel<boolean>(client, "CONNECT", data, port);
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Another origin's resource is the network's business, as in any page.
  if (url.origin !== self.location.origin) return;
  if (isShellPath(url.pathname)) return;

  if (request.mode === "navigate" && !navigationAllowed(request.referrer, self.location.origin)) {
    event.respondWith(
      page(
        403,
        "Open this session from its app",
        "A session is shown inside the app that opened it. This page was reached some other way, so it is not served.",
      ),
    );
    return;
  }

  event.respondWith(forward(request));
});

async function forward(request: Request): Promise<Response> {
  const client = await liveClient();
  if (client == null) {
    return page(
      503,
      "No app is connected",
      "Nothing is serving this session right now. Reopen it from the app that created it.",
    );
  }
  try {
    const port = await connect(client, { type: "http", key: SESSION_SERVICE_KEY });
    if (port == null) return page(403, "Refused", "The app declined this request.");
    return withFrameAncestors(await sendHttpRequest(port, request), FRAME_ANCESTORS);
  } catch (error) {
    const status = error instanceof TimeoutError ? 504 : (HttpError.fromError(error).status ?? 502);
    return page(status, "The app did not answer", String((error as Error)?.message ?? error));
  }
}

/** A small HTML answer for the cases the app never sees. Framing rules apply to it too. */
function page(status: number, title: string, text: string): Response {
  const escapeHtml = (s: string): string =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    );
  const body =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:15px/1.6 system-ui,sans-serif;margin:2rem">` +
    `<h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
      "x-httpeers-session": "shell",
    },
  });
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

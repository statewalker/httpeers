/**
 * The relay page: accept ONE port, from an allowed ghost app, and bridge it to
 * this origin's worker.
 *
 * THE LIBRARY'S RELAY PAGE, WITH TWO CHANGES. `webrun-http-browser`'s
 * `getRelayWindowMessageHandler` registers the worker, waits until it controls
 * the page, and pipes the parent's port to it both ways. This does the same,
 * except:
 *
 *   1. IT CHECKS WHO IS CONNECTING. The library's handler takes a CONNECT from
 *      whoever posts one. `frame-ancestors` already limits who can frame this
 *      page to httpeers.net, but that includes every OTHER session, and a
 *      session must not be drivable by another one. So the sender must be the
 *      parent window, and the parent a ghost-app origin.
 *
 *   2. IT TALKS TO THE ACTIVE WORKER, NOT THE PAGE'S CONTROLLER. Measured in
 *      Firefox 155: the first relay page on an origin is claimed and
 *      controlled, but a later one -- a second tab, or the same ghost app
 *      reloaded -- loads with the worker active and `controller` still null.
 *      The library waits for `controllerchange`, which never comes, and the
 *      ghost's REGISTER is never answered. Posting to `registration.active`
 *      works either way: a worker can answer any client of its origin,
 *      controlled or not.
 *
 * (Calling the library's handler directly was also the first version for a
 * build reason: its default arguments carry `new URL("../", import.meta.url)`,
 * which Vite resolves into a copy of the library's whole 91 KB `index.js`,
 * shipped as an asset nothing loads.)
 */

import { isAllowedParentOrigin, WORKER_PATH } from "./policy.js";

let accepted: MessagePort | undefined;

/** The registration's worker once it is activated -- whether or not it controls this page. */
async function activeWorker(): Promise<ServiceWorker> {
  const registration = await navigator.serviceWorker.register(
    new URL(WORKER_PATH, location.href).href,
    { scope: "/" },
  );
  for (;;) {
    const worker = registration.active;
    if (worker?.state === "activated") return worker;
    const pending = worker ?? registration.waiting ?? registration.installing;
    await new Promise<void>((resolve) => {
      if (pending == null) {
        registration.addEventListener("updatefound", () => resolve(), { once: true });
      } else {
        pending.addEventListener("statechange", () => resolve(), { once: true });
      }
    });
  }
}

async function bridge(external: MessagePort): Promise<void> {
  const worker = await activeWorker();
  navigator.serviceWorker.addEventListener("message", (event) => {
    external.postMessage(event.data, [...event.ports]);
  });
  // `addEventListener` alone does not start the container's message queue.
  navigator.serviceWorker.startMessages();
  external.onmessage = (event) => worker.postMessage(event.data, [...event.ports]);
}

const framed = window.parent !== window;
document.documentElement.dataset.relay = framed ? "waiting" : "not-framed";

window.addEventListener("message", (event) => {
  if (!framed || event.source !== window.parent) return;
  if (event.data?.type !== "CONNECT") return;
  const port = event.ports?.[0];
  if (port == null) return;
  if (!isAllowedParentOrigin(event.origin, location.hostname)) {
    // Loud: a refused parent is either a misconfigured ghost app or an attempt,
    // and both deserve to be visible in the console.
    console.warn(`session relay: refused a port from ${event.origin}`);
    document.documentElement.dataset.relay = "refused";
    port.close();
    return;
  }
  // ONE PORT PER PAGE, as in the library: a second CONNECT is closed, not
  // swapped in, so whoever connected first keeps the session.
  if (accepted != null) {
    port.close();
    return;
  }
  accepted = port;
  document.documentElement.dataset.relay = "connecting";
  bridge(port).then(
    () => {
      document.documentElement.dataset.relay = "connected";
    },
    (error: unknown) => {
      console.error("session relay: could not start the worker", error);
      document.documentElement.dataset.relay = "failed";
    },
  );
});

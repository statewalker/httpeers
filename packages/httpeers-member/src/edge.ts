/**
 * The ServiceWorker edge: mounts a peer's `dispatch` into
 * `@statewalker/webrun-http-browser`'s `SwHttpAdapter` so a page's own
 * `fetch()` (same-origin) can reach it, no different in shape from any
 * other HTTP request on the page.
 *
 * `dispatch` MOUNTS UNCHANGED -- NO WRAPPER, NO CAST (design note 22 §1,
 * criterion 1 of prototype E-1). `httpeers.core`'s `FetchHandler` is
 * `(Request) => Promise<Response>`; `SwHttpAdapter.register`'s `HttpHandler`
 * (`@statewalker/webrun-http-streams`) is `(Request) => Response |
 * Promise<Response>` -- the same contract, arrived at independently, which
 * is exactly why `mountEdge` below passes `dispatch` straight through with
 * no adapter of its own.
 *
 * THE KEY/PREFIX TRAP -- see `edge-guard.ts`'s `assertKeyMatchesPrefix` for
 * the mechanism and why it is factored into its own file.
 *
 * WORKSPACE IMPORT, NOT NPM (design note 39 "Published 0.3.3 and workspace
 * 0.3.3 are different artefacts"). `SwHttpAdapter` does not exist in the
 * published npm tarball's dist bundle at all -- `src/sw/index.js` is
 * absent there, the re-export is commented out, and the deep import fails
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. `package.json` pins
 * `@statewalker/webrun-http-browser: workspace:*` for exactly this reason.
 * The WORKSPACE package's own `package.json` still points its `./sw`
 * export at `./dist/sw.js`, and that package ships no committed `dist/`
 * (gitignored, `workspaces/webrun-wire/.gitignore`) -- so this import only
 * resolves once `pnpm --filter @statewalker/webrun-http-browser build` (or
 * an equivalent `turbo build` that reaches it) has actually run. This is
 * the known defect the task brief calls out; see this task's report for
 * exactly what was verified and how.
 */
import type { FetchHandler } from "@statewalker/httpeers-core";
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { assertKeyMatchesPrefix } from "./edge-guard.js";

export { assertKeyMatchesPrefix };

/**
 * The two browser globals this file names, declared LOCALLY rather than by
 * adding "dom" to the package's `lib` -- see `./page-wake.ts` for the reason.
 *
 * `navigator` is the interesting one: @types/node declares it too, and ITS
 * `Navigator` has no `serviceWorker`, so this is not merely filling a gap but
 * shadowing a same-named global that means something else in the other
 * runtime. Narrow on purpose -- the guard below only asks whether the
 * property is there.
 */
declare const navigator: { serviceWorker?: unknown };
declare const location: { origin: string; href: string };

export interface MountEdgeInit {
  /** The ServiceWorker adapter's channel key -- see `assertKeyMatchesPrefix`'s doc comment for why this must equal `prefix`'s first path segment. */
  key: string;
  /** Defaults to `${key}/` -- the one prefix shape `assertKeyMatchesPrefix` is guaranteed to accept. Overridable only for a caller with a real reason to diverge. */
  prefix?: string;
  /** Defaults to `DEFAULT_SERVICE_WORKER_URL` -- see its own comment; omitting it entirely is NOT an option this adapter survives. */
  serviceWorkerUrl?: string;
  /** The peer's own router. Mounted unchanged -- see this module's doc comment. */
  dispatch: FetchHandler;
}

/**
 * Where each origin's ServiceWorker script lives: `/sw.js`, the dist root.
 * Fixed by `../static-server/main.ts`'s own `swFile` default (it serves
 * exactly that filename with `Service-Worker-Allowed: /`) and by both vite
 * configs, which name the `sw` entry `sw.js` with no content hash for this
 * exact reason.
 *
 * SUPPLYING THIS IS NOT OPTIONAL, AND OMITTING IT IS NOT A GRACEFUL
 * DEGRADATION. `SwHttpAdapter`'s own defaults are mutually recursive:
 * `scope` reads `serviceWorkerUrl`, which (when unset) computes
 * `new URL("./index-sw.js", rootUrl)`, and `rootUrl` reads `scope` again
 * (`sw-dispatcher.ts`'s three getters). With neither `scope` nor
 * `serviceWorkerUrl` given, the CONSTRUCTOR -- which validates `this.scope`
 * -- recurses until the stack is exhausted. Verified directly by
 * constructing one under Node: `RangeError: Maximum call stack size
 * exceeded`, before `start()` is ever reached. `mountEdge` previously
 * forwarded `init.serviceWorkerUrl` straight through, so every caller that
 * left it unset (the image peer page, Task 12) would have hit that
 * RangeError the first time it ran in a real browser. Defaulting here fixes
 * every such caller at once rather than asking each page to remember.
 */
export const DEFAULT_SERVICE_WORKER_URL = "/sw.js";

export interface EdgeHandle {
  /** The URL a same-origin `fetch()` reaches this peer's `dispatch` through. */
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Register a peer's `dispatch` on the ServiceWorker edge. Throws (via
 * `assertKeyMatchesPrefix`) before `SwHttpAdapter` is even constructed if
 * `key`/`prefix` disagree -- the failure this function exists to make
 * loud instead of silent.
 */
export async function mountEdge(init: MountEdgeInit): Promise<EdgeHandle> {
  const prefix = init.prefix ?? `${init.key}/`;
  assertKeyMatchesPrefix(init.key, prefix);

  // SAY WHAT IS ACTUALLY WRONG. ServiceWorkers exist only in a secure context:
  // `https://`, or `http://` on `localhost`/`127.0.0.1`. Served from a LAN
  // address over plain HTTP -- exactly what someone does when opening these
  // pages from a phone -- `navigator.serviceWorker` is `undefined`, and the
  // first symptom is `TypeError: Cannot read properties of undefined (reading
  // 'register')` thrown from inside the adapter, which names neither the cause
  // nor the fix. This is a browser rule, not something this stack can work
  // around; the deployment answer is the TLS the design already provides for
  // (`TLS_CERT`/`TLS_KEY`).
  if (typeof navigator === "undefined" || navigator.serviceWorker == null) {
    const origin = typeof location !== "undefined" ? location.origin : "this origin";
    throw new Error(
      `mountEdge: this browser exposes no ServiceWorker at ${origin}, so a peer cannot be ` +
        "reached through the page's own fetch(). ServiceWorkers require a secure context: " +
        "serve the page over https, or open it on localhost / 127.0.0.1. " +
        "(A LAN address over plain http is not a secure context, which is why this fails " +
        "there but works on localhost.)",
    );
  }

  // Resolved against the page's own origin: `SwHttpAdapter` passes this to
  // `new URL(...)` with no base, so a bare "/sw.js" would throw `Invalid
  // URL` rather than being treated as origin-relative.
  const serviceWorkerUrl = new URL(
    init.serviceWorkerUrl ?? DEFAULT_SERVICE_WORKER_URL,
    location.href,
  ).href;
  const adapter = new SwHttpAdapter({ key: init.key, serviceWorkerUrl });
  await adapter.start();
  const registration = await adapter.register(prefix, init.dispatch);

  return {
    baseUrl: registration.baseUrl,
    async stop() {
      await registration.remove();
      await adapter.stop();
    },
  };
}

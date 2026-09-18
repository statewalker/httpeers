/**
 * Turning a failure to get the page's ServiceWorker into an error a user can
 * act on.
 *
 * THE HANG THIS USED TO GUARD. A page can load UNCONTROLLED while its worker
 * is already active -- a HARD RELOAD (Ctrl+Shift+R; Firefox's
 * `location.reload(true)`) bypasses the worker by spec, and Firefox has left a
 * second tab uncontrolled too. The worker claimed its clients when it
 * activated, long ago, so no `controllerchange` ever comes. Up to
 * `@statewalker/webrun-http-browser` 0.4, `SwHttpAdapter.start()` then waited
 * forever: llm-chat's mesh.html sat at "Joining… (mounting-edge)" after every
 * hard reload, and this file carried a reload guard of its own.
 *
 * SINCE 0.5 THE LIBRARY RECOVERS IT ITSELF. `start()` asks the active worker to
 * claim the page again (a `CLAIM` call, answered with `clients.claim()` by the
 * package's own `sw-worker` -- which is what this stack's `/sw.js` is), so a
 * hard-reloaded page is taken over in place, with no navigation. Every wait is
 * bounded by `timeout`; past it `start()` rejects with a
 * `ServiceWorkerControlError` whose `reason` says which wait failed. And with
 * `reloadIfUncontrolled` it reloads once, guarded by `sessionStorage`, when the
 * claim did not take. Measured in Chromium and Firefox by
 * `packages/httpeers-browser-conformance/scripts/edge-reload.mjs`.
 *
 * What is left here is the message: `edgeStartError` maps the library's error
 * onto the ones `mountEdge` has always thrown, so a page shows "close the tab
 * and reopen it" rather than a library's diagnostic. It matches on `name` and
 * `reason`, not `instanceof`: every bundle of webrun-http-browser carries its
 * own copy of the class.
 */

/** The error a page shows when it cannot get its ServiceWorker's control. */
export class UncontrolledPageError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      "This page isn't controlled by its ServiceWorker, so the mesh cannot be reached through " +
        `it — close the tab and reopen it. (${detail})`,
      options,
    );
    this.name = "UncontrolledPageError";
  }
}

/** The shape of webrun-http-browser's `ServiceWorkerControlError`, matched structurally. */
interface ControlErrorLike {
  name: "ServiceWorkerControlError";
  reason: string;
  message: string;
}

function isControlError(error: unknown): error is ControlErrorLike {
  return (
    error instanceof Error &&
    error.name === "ServiceWorkerControlError" &&
    typeof (error as Partial<ControlErrorLike>).reason === "string"
  );
}

/**
 * The error `mountEdge` throws when `SwHttpAdapter.start()` rejects:
 *
 *   - `reason: "uncontrolled"` -- the worker is active but did not take the
 *     page when asked, and the one automatic reload was already spent (or
 *     could not be guarded) -> `UncontrolledPageError`;
 *   - `"activation-timeout"` / `"unresponsive"` -- the worker never activated,
 *     or controls the page but did not answer -> an `Error` naming the worker
 *     and the bound, and saying what to do;
 *   - anything else is not a control failure and is returned unchanged.
 *
 * The library's own error is kept as `cause`, for DevTools.
 */
export function edgeStartError(
  error: unknown,
  serviceWorkerUrl: string,
  timeoutMs: number,
): unknown {
  if (!isControlError(error)) return error;
  if (error.reason === "uncontrolled") {
    return new UncontrolledPageError(
      "its ServiceWorker is active but did not take control when asked, and the page " +
        "has already been reloaded once to recover, or could not be",
      { cause: error },
    );
  }
  const what =
    error.reason === "activation-timeout"
      ? "did not activate"
      : "did not answer the page, although it controls it,";
  return new Error(
    `mountEdge: the ServiceWorker ${serviceWorkerUrl} ${what} within ` +
      `${Math.round(timeoutMs / 1000)} s. Close the tab and reopen it; if that does not help, ` +
      "clear this site's data in the browser to remove the ServiceWorker and start clean.",
    { cause: error },
  );
}

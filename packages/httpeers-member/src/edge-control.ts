/**
 * Making sure a page is CONTROLLED by its ServiceWorker before the edge waits
 * for it -- and failing loudly, never hanging, when it cannot be.
 *
 * THE HANG THIS EXISTS FOR. `SwHttpAdapter.start()` (webrun-http-browser)
 * registers the worker and then waits for `navigator.serviceWorker.controller`
 * -- resolving at once if there is one, otherwise on the next
 * `controllerchange`, with no timeout. On a first visit that is right: the new
 * worker activates, its `activate` handler runs `clients.claim()`, and the
 * page gets a controller. But a page can also load UNCONTROLLED while the
 * worker is already active:
 *
 *   - a HARD RELOAD (Ctrl+Shift+R; in Firefox also `location.reload(true)`)
 *     loads the page bypassing its ServiceWorker, by spec;
 *   - a tab whose navigation raced the worker's first activation.
 *
 * The worker activated -- and claimed -- long ago, so nothing will ever fire
 * `controllerchange` for this page, and `start()` waits forever. That shipped:
 * llm-chat's mesh.html sat at "Joining… (mounting-edge)" after every hard
 * reload.
 *
 * WHAT RECOVERS IT, measured in Chromium and Firefox (see
 * `packages/httpeers-browser-conformance/scripts/edge-reload.mjs`):
 *
 *   - `clients.claim()` run by the worker DOES take over a hard-reloaded page.
 *     But the worker only claims on `activate`, and the worker this edge
 *     registers (webrun-http-browser's ready-made `sw-worker`) exposes no way
 *     for a page to ask for another claim; a byte-identical `register()` or
 *     `update()` installs nothing, so there is no second `activate`. A page
 *     cannot make the current worker claim it.
 *   - An ordinary reload of the uncontrolled page comes back controlled, in
 *     both browsers.
 *
 * So the recovery is ONE guarded reload. The guard is a timestamped flag in
 * `sessionStorage` (per tab, survives the reload): a page that finds the flag,
 * recent, and is STILL uncontrolled does not reload again -- it throws
 * `UncontrolledPageError`, which says what to do. Without a working
 * `sessionStorage` there is no way to prove the reload cannot loop, so there
 * is no reload: the error is thrown straight away.
 *
 * Everything the browser provides is injected (`ControlEnv`), so the decision
 * is unit-tested without a browser; `edge.ts` supplies the real globals.
 */

/** The `sessionStorage` key of the reload guard. */
export const CONTROL_RELOAD_KEY = "httpeers:edge:control-reload";

/**
 * How long a reload guard counts. A flag older than this is left over from
 * some earlier episode (a tab that crashed mid-reload, say) and does not stop
 * a fresh recovery. A reload that works takes well under a second; a minute is
 * generous and still short enough that a later hard reload recovers again.
 */
export const CONTROL_RELOAD_WINDOW_MS = 60_000;

/** The error a page shows when it cannot get its ServiceWorker's control. */
export class UncontrolledPageError extends Error {
  constructor(detail: string) {
    super(
      "This page isn't controlled by its ServiceWorker, so the mesh cannot be reached through " +
        `it — close the tab and reopen it. (${detail})`,
    );
    this.name = "UncontrolledPageError";
  }
}

/** The `sessionStorage` subset used. Any method may throw (storage disabled). */
export interface ControlStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What `ensureControlled` needs from the browser. */
export interface ControlEnv {
  /** Whether `navigator.serviceWorker.controller` is set right now. */
  isControlled(): boolean;
  /** Whether this page's scope already has an ACTIVE worker (`getRegistration(...).active`). */
  hasActiveWorker(): Promise<boolean>;
  /** `sessionStorage`, or `undefined` where reading it throws. */
  storage: ControlStorage | undefined;
  reload(): void;
  now(): number;
}

/**
 * What to do, from the three facts that decide it. Pure, so every branch is
 * a unit test.
 *
 *   - `proceed`: controlled already, or no active worker yet (a first visit,
 *     or a worker still installing) -- its `activate` will claim this page;
 *   - `reload`: uncontrolled under an active worker, with no recent guard;
 *   - `fail`: uncontrolled under an active worker, and either the guarded
 *     reload already happened or the guard cannot be kept.
 */
export type ControlDecision = "proceed" | "reload" | "fail";

export function decideControl(facts: {
  controlled: boolean;
  activeWorker: boolean;
  /** When this tab last reloaded to recover; `null` for none, `undefined` when storage is unusable. */
  reloadedAt: number | null | undefined;
  now: number;
}): ControlDecision {
  if (facts.controlled || !facts.activeWorker) return "proceed";
  if (facts.reloadedAt === undefined) return "fail";
  if (facts.reloadedAt !== null && facts.now - facts.reloadedAt < CONTROL_RELOAD_WINDOW_MS) {
    return "fail";
  }
  return "reload";
}

/** The guard's timestamp: `null` for none (or unparseable), `undefined` when storage throws. */
function readGuard(storage: ControlStorage | undefined): number | null | undefined {
  if (storage == null) return undefined;
  try {
    const raw = storage.getItem(CONTROL_RELOAD_KEY);
    if (raw == null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return undefined;
  }
}

function clearGuard(storage: ControlStorage | undefined): void {
  try {
    storage?.removeItem(CONTROL_RELOAD_KEY);
  } catch {
    // Nothing to clear if storage is unusable.
  }
}

/**
 * Resolve when the page is controlled or about to be (a first visit); reload
 * once when it is uncontrolled under an active worker; throw
 * `UncontrolledPageError` when that reload has already been tried.
 *
 * On `reload` the returned promise never settles: the page is navigating away,
 * and continuing into `SwHttpAdapter.start()` would only reach the hang again.
 * `mountEdge`'s own bound on the whole wait still applies should the reload
 * somehow not happen.
 */
export async function ensureControlled(env: ControlEnv): Promise<void> {
  const controlled = env.isControlled();
  const activeWorker = controlled ? true : await env.hasActiveWorker();
  const reloadedAt = readGuard(env.storage);
  const decision = decideControl({ controlled, activeWorker, reloadedAt, now: env.now() });

  if (decision === "proceed") {
    // Controlled (or on the way to it): a guard left by the reload that got us
    // here has done its job. Keeping it would turn the NEXT hard reload of this
    // tab, within the window, into an error instead of a recovery.
    if (controlled && reloadedAt != null) clearGuard(env.storage);
    return;
  }
  if (decision === "fail") {
    // Clear it so the user's own next reload gets its one recovery again; the
    // loop is broken regardless, because this branch never reloads.
    clearGuard(env.storage);
    throw new UncontrolledPageError(
      reloadedAt === undefined
        ? "sessionStorage is unavailable, so an automatic reload could not be guarded against looping"
        : "it was reloaded once already and is still uncontrolled",
    );
  }

  try {
    env.storage?.setItem(CONTROL_RELOAD_KEY, String(env.now()));
  } catch {
    // readGuard just succeeded, so this is unexpected; without the guard a
    // reload could loop, so do not reload.
    throw new UncontrolledPageError(
      "sessionStorage refused the reload guard, so an automatic reload could not be guarded",
    );
  }
  env.reload();
  await new Promise<never>(() => {});
}

/** Reject with `message` if `promise` has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

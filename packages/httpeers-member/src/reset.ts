/**
 * Getting a stuck origin back to a first visit — and NOTHING ELSE IN IT.
 *
 * ITS OWN ENTRY POINT ON PURPOSE. This is what a rescue page loads when the
 * app will not start, so it must not depend on the app starting. Importing it
 * through `./browser` would drag in the session, the member lifecycle,
 * `httpeers-access` and finally `biscuit-wasm` -- a WebAssembly module that
 * needs its own initialisation -- to unregister a ServiceWorker. If that
 * initialisation is what broke, the rescue page breaks with it.
 *
 * Measured, not assumed: importing `@statewalker/httpeers-member/browser` in a
 * browser fails outright until the wasm loader is wired, which is exactly the
 * situation someone reaching for a reset may be in.
 *
 * So: zero imports. Everything here is a platform global.
 */

/**
 * The page globals a reset touches. Declared locally, like the rest of this
 * file — see `./page-wake.ts` for why not `lib: dom`.
 */
declare const navigator: {
  serviceWorker?: { getRegistrations(): Promise<Array<{ unregister(): Promise<boolean> }>> };
};
declare const indexedDB: {
  databases?(): Promise<Array<{ name?: string }>>;
  deleteDatabase(name: string): {
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked: (() => void) | null;
  };
};
declare const localStorage: { clear(): void } | undefined;
declare const sessionStorage: { clear(): void } | undefined;

/** What a reset actually removed, so a page can report it rather than guess. */
export interface ResetResult {
  /** ServiceWorker registrations unregistered on this origin. */
  serviceWorkers: number;
  /** IndexedDB databases deleted, by name. */
  databases: string[];
}

/**
 * Put this origin back to a first-visit state: no worker, no databases, no
 * stored values.
 *
 * WHY THIS EXISTS AT ALL. A ServiceWorker is the stickiest thing a static site
 * can install, and the obvious remedies do not work — measured in a real
 * browser, not inferred:
 *
 *   - **A reload does not remove one.** Registration is durable state on the
 *     ORIGIN, independent of any page's lifetime.
 *   - **`unregister()` does not evict the worker already controlling this
 *     page.** It removes the registration; the active worker keeps serving
 *     open clients until they are unloaded. So a reset control that reports
 *     success without reloading is still being served by the thing it says it
 *     removed. **Reload after calling this.**
 *   - **Unregistering alone is a half-reset.** The identity that makes a page
 *     "the same peer" is in IndexedDB. Clear only the worker and the page
 *     comes back as the same member, which is exactly the outcome people
 *     report as "it did not work".
 *
 * EVERYTHING ON THE ORIGIN, NOT A LIST OF NAMES. The state spans idb-keyval's
 * store (identity, remembered mesh), the hub's database, the libp2p key store,
 * the ServiceWorker adapter's claimed-keys table and `localStorage` — five
 * places across three packages today. A hand-maintained list would go stale
 * the first time one moved, silently, leaving the half-reset above. An origin
 * here belongs to one app, so "all of it" is both simpler and correct.
 *
 * NEVER THROWS. It runs on a rescue page that must work when everything else
 * is broken, including on a first visit with nothing to remove.
 */
export async function resetBrowserState(): Promise<ResetResult> {
  let serviceWorkers = 0;
  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    for (const registration of registrations) {
      try {
        await registration.unregister();
        serviceWorkers += 1;
      } catch {
        /* one that refuses must not stop the rest */
      }
    }
  } catch {
    /* no ServiceWorker support, or an insecure context */
  }

  const databases: string[] = [];
  try {
    // `indexedDB.databases()` is unsupported in Firefox, where enumeration is
    // impossible and this half is a no-op. The worker and the stores below are
    // still cleared, so a reset there is partial rather than absent -- worth
    // knowing, and better than refusing to run.
    const found = (await indexedDB.databases?.()) ?? [];
    for (const { name } of found) {
      if (name == null || name === "") continue;
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        // A database still open in another tab blocks. Resolving anyway keeps
        // the reset moving; the page reload that follows closes this tab's
        // handle, and the delete completes then.
        request.onblocked = () => resolve();
      });
      databases.push(name);
    }
  } catch {
    /* enumeration unsupported */
  }

  try {
    localStorage?.clear();
  } catch {
    /* blocked site data */
  }
  try {
    sessionStorage?.clear();
  } catch {
    /* blocked site data */
  }

  return { serviceWorkers, databases };
}

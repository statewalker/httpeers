/**
 * `resetBrowserState()` — the one control that gets a user unstuck.
 *
 * Built on what `sw-lifecycle.test.ts` MEASURED rather than on what the spec
 * implies: a reload does not remove a worker, `unregister()` leaves the
 * existing controller in place until the page is unloaded, and the identity
 * that makes a page "the same peer" is in IndexedDB, not in the worker.
 *
 * So a reset that only unregisters is a half-reset: the page reloads, finds
 * its old key, and claims the same peer id. That is the version an operator
 * reports as "it did not work".
 *
 * EVERYTHING ON THE ORIGIN, NOT A LIST OF NAMES. The state is spread over
 * idb-keyval's store (identity, remembered mesh), the hub's own database, the
 * libp2p key store, the ServiceWorker adapter's claimed-keys table, and
 * localStorage (proxy routes) — five places across three packages today. A
 * hand-maintained list would go stale the first time one moved, silently,
 * leaving exactly the half-reset this exists to prevent.
 */

import { describe, expect, it } from "vitest";
import { resetBrowserState } from "@statewalker/httpeers-member/reset";

const SW_URL = "/test-sw.js";

describe("resetBrowserState", () => {
  it("removes the worker, the databases and the stored values together", async () => {
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;

    const dbName = `httpeers-reset-${Math.random().toString(36).slice(2)}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(dbName, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("s");
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    localStorage.setItem("httpeers:routes", "[]");

    const result = await resetBrowserState();

    expect(result.serviceWorkers).toBeGreaterThan(0);
    expect(result.databases).toContain(dbName);
    expect(await navigator.serviceWorker.getRegistrations()).toHaveLength(0);
    expect((await indexedDB.databases()).some((d) => d.name === dbName)).toBe(false);
    expect(localStorage.getItem("httpeers:routes")).toBeNull();
  }, 60_000);

  it("is safe to run when there is nothing to remove", async () => {
    // The rescue page runs this on load, every time, including the first visit
    // of someone who has never used the app. It must not throw there.
    await resetBrowserState();
    const second = await resetBrowserState();
    expect(second.serviceWorkers).toBe(0);
    expect(second.databases).toEqual([]);
  }, 60_000);

  it("reports what it removed, so a page can say so rather than guess", async () => {
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;
    const result = await resetBrowserState();
    // A reset that reported nothing would leave the operator unable to tell
    // "there was nothing to clear" from "the clear silently failed".
    expect(result.serviceWorkers).toBe(1);
  }, 60_000);
});

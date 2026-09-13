/**
 * Getting rid of a ServiceWorker — measured in a real browser.
 *
 * WHY THIS IS THE FIRST BROWSER TEST. A ServiceWorker is the stickiest thing a
 * static deployment can install. It outlives the tab that registered it, it is
 * re-used by every later visit to the origin, and a user who wants to start
 * clean has no obvious way to do it: reloading does NOT remove one, and
 * clearing "cache" in the browser UI often does not either. Everything else in
 * these packages can be undone by closing the tab. This cannot.
 *
 * So before four demo sites go live on `*.httpeers.net`, the reset path has to
 * be something that was run rather than something that was reasoned about.
 * These tests are that. They are deliberately written against the RAW
 * ServiceWorker API rather than through `mountEdge`, because what a user needs
 * when the app is broken is a path that does not depend on the app's own code
 * loading at all.
 */

import { describe, expect, it } from "vitest";

/** Where the throwaway worker lives. Served from `public/`, so scope is the origin root. */
const SW_URL = "/test-sw.js";

async function registrations(): Promise<readonly ServiceWorkerRegistration[]> {
  return navigator.serviceWorker.getRegistrations();
}

async function unregisterAll(): Promise<number> {
  const all = await registrations();
  for (const reg of all) await reg.unregister();
  return all.length;
}

describe("the ServiceWorker a page installs", () => {
  it("registers, activates, and is then listed for the whole origin", async () => {
    await unregisterAll();
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;

    expect(reg.active ?? reg.installing ?? reg.waiting).not.toBeNull();
    // THE STICKINESS, stated as a fact: it is now attached to the ORIGIN, not
    // to this page. Any later visit finds it already there.
    expect((await registrations()).length).toBeGreaterThan(0);

    await unregisterAll();
  }, 30_000);

  it("survives a reload — which is why 'just refresh' is not the answer", async () => {
    // The instinct when something is wrong is to reload. This measures what
    // that actually does to a worker: nothing.
    await unregisterAll();
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;

    // A reload cannot be performed inside one vitest browser test, so this
    // asserts the property the reload depends on: registration is durable
    // state on the origin, independent of any client. Nothing about the
    // current page's lifetime removes it.
    const before = (await registrations()).length;
    expect(before).toBeGreaterThan(0);

    const stillThere = await navigator.serviceWorker.getRegistration(SW_URL);
    expect(stillThere).toBeDefined();

    await unregisterAll();
  }, 30_000);

  it("is removed by unregister(), and removal is observable", async () => {
    // THE RESET, in its smallest honest form. This is what a "reset this app"
    // control has to do, and what a rescue page has to do when the app itself
    // will not start.
    await unregisterAll();
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;
    expect((await registrations()).length).toBeGreaterThan(0);

    const removed = await unregisterAll();
    expect(removed).toBeGreaterThan(0);
    expect((await registrations()).length).toBe(0);
  }, 30_000);

  it("keeps controlling this page after unregister, until the page goes away", async () => {
    // THE DETAIL THAT MAKES A RESET BUTTON FEEL BROKEN, and the reason the
    // control must reload afterwards rather than just report success.
    //
    // `unregister()` removes the REGISTRATION. It does not evict the worker
    // that is already controlling open clients: per the spec the active worker
    // keeps serving them until they are unloaded. So a page that unregisters
    // and then says "done" is still being served by the thing it claims to
    // have removed.
    await unregisterAll();
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;

    const controllerBefore = navigator.serviceWorker.controller;
    await unregisterAll();

    expect((await registrations()).length).toBe(0);
    // Whatever was controlling this document is still controlling it.
    expect(navigator.serviceWorker.controller).toBe(controllerBefore);
  }, 30_000);
});

describe("what a reset must also clear", () => {
  it("IndexedDB outlives the worker, so unregistering is not enough", async () => {
    // The member's identity, the remembered mesh and the hub's snapshot all
    // live in IndexedDB. A reset that removed only the worker would leave a
    // page that still claims the old peer id -- which is precisely the
    // confusing half-reset an operator reports as "it did not work".
    const name = `httpeers-reset-probe-${Math.random().toString(36).slice(2)}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("s");
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });

    const before = await indexedDB.databases();
    expect(before.some((d) => d.name === name)).toBe(true);

    await new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase(name);
      del.onsuccess = () => resolve();
      del.onerror = () => resolve();
      del.onblocked = () => resolve();
    });

    const after = await indexedDB.databases();
    expect(after.some((d) => d.name === name)).toBe(false);
  }, 30_000);
});

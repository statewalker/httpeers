/**
 * The decision `mountEdge` makes before waiting for a ServiceWorker controller.
 *
 * The browser half -- that a hard reload really does leave a page uncontrolled,
 * and that one ordinary reload really does recover it -- is measured in
 * Chromium and Firefox by `httpeers-browser-conformance/scripts/edge-reload.mjs`.
 * These tests pin what the page DOES with those facts, and above all that it
 * can never reload in a loop.
 */

import { describe, expect, it } from "vitest";
import {
  CONTROL_RELOAD_KEY,
  CONTROL_RELOAD_WINDOW_MS,
  type ControlEnv,
  type ControlStorage,
  decideControl,
  ensureControlled,
  UncontrolledPageError,
  withTimeout,
} from "../src/edge-control.js";

const NOW = 1_800_000_000_000;

describe("decideControl", () => {
  it("proceeds when the page is controlled", () => {
    expect(
      decideControl({ controlled: true, activeWorker: true, reloadedAt: null, now: NOW }),
    ).toBe("proceed");
  });

  it("proceeds on a first visit: no active worker yet, whose activate will claim the page", () => {
    expect(
      decideControl({ controlled: false, activeWorker: false, reloadedAt: null, now: NOW }),
    ).toBe("proceed");
  });

  // THE BUG: a hard reload under an already-active worker. Waiting here hangs forever.
  it("reloads an uncontrolled page under an active worker", () => {
    expect(
      decideControl({ controlled: false, activeWorker: true, reloadedAt: null, now: NOW }),
    ).toBe("reload");
  });

  it("fails instead of reloading twice within the window", () => {
    expect(
      decideControl({ controlled: false, activeWorker: true, reloadedAt: NOW - 500, now: NOW }),
    ).toBe("fail");
  });

  it("treats a guard older than the window as left over, and reloads", () => {
    expect(
      decideControl({
        controlled: false,
        activeWorker: true,
        reloadedAt: NOW - CONTROL_RELOAD_WINDOW_MS - 1,
        now: NOW,
      }),
    ).toBe("reload");
  });

  it("fails rather than reloading when the guard cannot be kept", () => {
    expect(
      decideControl({ controlled: false, activeWorker: true, reloadedAt: undefined, now: NOW }),
    ).toBe("fail");
  });
});

function memoryStorage(initial: Record<string, string> = {}): ControlStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function env(over: Partial<ControlEnv> & { storage?: ControlStorage | undefined }) {
  let reloads = 0;
  const e: ControlEnv = {
    isControlled: () => false,
    hasActiveWorker: async () => true,
    storage: memoryStorage(),
    reload: () => {
      reloads++;
    },
    now: () => NOW,
    ...over,
  };
  return { env: e, reloads: () => reloads };
}

/** How `p` stands after a few macrotasks: a reload leaves it pending forever. */
async function outcomeOf(p: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  let state: "resolved" | "rejected" | "pending" = "pending";
  p.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  await new Promise((r) => setTimeout(r, 20));
  return state;
}

describe("ensureControlled", () => {
  it("resolves at once for a controlled page, and clears the guard that got it there", async () => {
    const storage = memoryStorage({ [CONTROL_RELOAD_KEY]: String(NOW - 1000) });
    const t = env({ isControlled: () => true, storage });
    await ensureControlled(t.env);
    expect(t.reloads()).toBe(0);
    expect(storage.data.has(CONTROL_RELOAD_KEY)).toBe(false);
  });

  it("resolves on a first visit without reloading", async () => {
    const t = env({ hasActiveWorker: async () => false });
    await ensureControlled(t.env);
    expect(t.reloads()).toBe(0);
  });

  it("sets the guard, reloads once, and never resolves into the hang", async () => {
    const storage = memoryStorage();
    const t = env({ storage });
    const pending = ensureControlled(t.env);
    expect(await outcomeOf(pending)).toBe("pending");
    expect(t.reloads()).toBe(1);
    expect(storage.data.get(CONTROL_RELOAD_KEY)).toBe(String(NOW));
  });

  it("after that reload, still uncontrolled: throws the error a page shows, and does not reload", async () => {
    const storage = memoryStorage({ [CONTROL_RELOAD_KEY]: String(NOW - 800) });
    const t = env({ storage });
    const err = await ensureControlled(t.env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncontrolledPageError);
    expect((err as Error).message).toMatch(/close the tab and reopen it/);
    expect(t.reloads()).toBe(0);
    // Cleared, so the user's own next reload gets its one recovery again.
    expect(storage.data.has(CONTROL_RELOAD_KEY)).toBe(false);
  });

  it("a sequence of loads can never reload twice in a row", async () => {
    // Simulate a browser that never gives control: each "load" runs
    // ensureControlled against the same tab storage.
    const storage = memoryStorage();
    let reloads = 0;
    const outcomes: string[] = [];
    for (let load = 0; load < 4; load++) {
      const e: ControlEnv = {
        isControlled: () => false,
        hasActiveWorker: async () => true,
        storage,
        reload: () => {
          reloads++;
        },
        now: () => NOW + load * 1000,
      };
      const outcome = await outcomeOf(ensureControlled(e));
      outcomes.push(outcome);
      // A failed page does not navigate, and a resolved one is controlled: either ends it.
      if (outcome !== "pending") break;
    }
    expect(outcomes).toEqual(["pending", "rejected"]);
    expect(reloads).toBe(1);
  });

  it("does not reload when sessionStorage is unavailable", async () => {
    const t = env({ storage: undefined });
    await expect(ensureControlled(t.env)).rejects.toBeInstanceOf(UncontrolledPageError);
    expect(t.reloads()).toBe(0);
  });

  it("does not reload when sessionStorage throws", async () => {
    const throwing: ControlStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const t = env({ storage: throwing });
    await expect(ensureControlled(t.env)).rejects.toBeInstanceOf(UncontrolledPageError);
    expect(t.reloads()).toBe(0);
  });
});

describe("withTimeout", () => {
  it("passes a value through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "late")).resolves.toBe(7);
  });

  it("rejects with the message when the promise outlives the bound", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "too late")).rejects.toThrow("too late");
  });
});

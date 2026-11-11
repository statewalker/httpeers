import { describe, expect, it, vi } from "vitest";
import { reservedPlaceholders, servicesOf, stopAll } from "../src/client.js";
import {
  APP_SERVICE_KEY,
  DEFAULT_SERVICE_KEY,
  MESH_SERVICE_KEY,
  SESSION_SERVICE_KEYS,
} from "../src/policy.js";

const handler = async (): Promise<Response> => new Response("x");

describe("the services a session is opened with", () => {
  it("keeps what it is given, in order", () => {
    const services = servicesOf([
      { key: "app", path: "/", handler },
      { key: "mesh", path: "/peers/", handler },
    ]);
    expect(services.map((s) => `${s.key}@${s.path}`)).toEqual(["app@/", "mesh@/peers/"]);
  });

  // A DUPLICATE KEY IS A COLLISION, NOT A REPLACEMENT. Two services registered
  // under one key on one port both install a matching CONNECT listener and
  // answer each other's calls -- a known sharp edge in the library, cheap to
  // refuse here rather than debug there.
  it("refuses two services with the same key", () => {
    expect(() =>
      servicesOf([
        { key: "app", path: "/", handler },
        { key: "app", path: "/peers/", handler },
      ]),
    ).toThrow(/same key/i);
  });

  it("refuses an empty list, which would open an origin nothing answers", () => {
    expect(() => servicesOf([])).toThrow(/at least one/i);
  });

  // EVERY path `isShellPath` claims, not just the prefix. `servicesOf` used to
  // restate the `_shell/` half of that rule as a second condition beside it;
  // these cases pin the rule itself, so the one remaining call is enough.
  it.each(["/_shell/", "/_shell/main-abc123.js", "/relay.html", "/relay-sw.js"])(
    "refuses %s, which is the shell's own",
    (path) => {
      expect(() => servicesOf([{ key: "app", path, handler }])).toThrow(/reserved/i);
    },
  );
});

// A HELD KEY IS ONE A HOSTILE GHOST CANNOT TAKE. `openSession` itself needs a
// browser to exercise; the reservation it makes does not, because it is a
// pure function of the requested services and the allowlist. Testing it here
// is the only way a regression in it -- reserving too few keys, or leaking a
// path onto a placeholder -- would ever be caught before production.
describe("reserving the whole key space", () => {
  it("holds every key the caller did not use", () => {
    const services = servicesOf([{ key: APP_SERVICE_KEY, path: "/", handler }]);
    const placeholders = reservedPlaceholders(services, SESSION_SERVICE_KEYS);
    expect(placeholders.map((p) => p.key).sort()).toEqual(
      [DEFAULT_SERVICE_KEY, MESH_SERVICE_KEY].sort(),
    );
  });

  it("gives a placeholder no path, so it cannot mount and cannot compete on longest-prefix", () => {
    const services = servicesOf([{ key: APP_SERVICE_KEY, path: "/", handler }]);
    const placeholders = reservedPlaceholders(services, SESSION_SERVICE_KEYS);
    for (const placeholder of placeholders) {
      expect("path" in placeholder).toBe(false);
    }
  });

  it("reserves nothing once every key is used", () => {
    const services = servicesOf([
      { key: APP_SERVICE_KEY, path: "/", handler },
      { key: MESH_SERVICE_KEY, path: "/peers/", handler },
      { key: DEFAULT_SERVICE_KEY, path: "/other/", handler },
    ]);
    expect(reservedPlaceholders(services, SESSION_SERVICE_KEYS)).toEqual([]);
  });

  it("gives a placeholder a handler that refuses", async () => {
    const services = servicesOf([{ key: APP_SERVICE_KEY, path: "/", handler }]);
    const [placeholder] = reservedPlaceholders(services, SESSION_SERVICE_KEYS);
    const response = await placeholder.handler(new Request("https://example.test/"));
    expect(response.ok).toBe(false);
  });
});

describe("stopping a session's services before its connection closes (#19)", () => {
  // THE ORDER IS THE FIX: `openSession` closes the connection once this
  // resolves, so resolving early is the bug, whatever else happens.
  it("waits until every stop has settled", async () => {
    const settled: string[] = [];
    const later = (name: string, ms: number) => () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          settled.push(name);
          resolve();
        }, ms),
      );
    vi.useFakeTimers();
    try {
      const waiting = stopAll([later("app", 20), later("mesh", 5)], 1_000);
      await vi.advanceTimersByTimeAsync(20);
      await waiting;
      expect(settled.sort()).toEqual(["app", "mesh"]);
      // THE BOUND'S OWN TIMER IS CLEARED once every stop has settled, so a
      // closed session leaves nothing pending behind it.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // A DEAD RELAY NEVER ANSWERS UNREGISTER, and the library's call has no
  // timeout -- an unbounded wait would hang a failing `openSession` forever.
  it("gives up on a relay that never answers", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = stopAll([() => new Promise<void>(() => {})], 5_000).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // A failed stop is no reason to keep the connection open.
  it("does not reject when a stop fails, and still waits for the others", async () => {
    let other = false;
    await expect(
      stopAll(
        [
          () => Promise.reject(new Error("boom")),
          () => {
            throw new Error("sync boom");
          },
          () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                other = true;
                resolve();
              }, 5),
            ),
        ],
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect(other).toBe(true);
  });
});

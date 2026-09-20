import { describe, expect, it } from "vitest";
import { reservedPlaceholders, servicesOf } from "../src/client.js";
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

  it("refuses a path that is the shell's own", () => {
    expect(() => servicesOf([{ key: "app", path: "/_shell/", handler }])).toThrow(/reserved/i);
  });
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

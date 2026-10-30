/**
 * 01 — Can Direct and Bridged be one `Upstream` behind one route table?
 *
 * Every scenario runs once per kind with the SAME assertions: a difference
 * between Direct and Bridged shows up as one kind failing a row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shareRouter } from "../src/share-router.js";
import {
  BRIDGE_MARKER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
  createUpstream,
  type UpstreamConfig,
  unreachable,
} from "../src/upstreams.js";
import { deadOrigin, type Running, startBridgeStub, startService, streamGate } from "./fixtures.js";

const TOKEN = "pairing-token-01";

let service: Running;
let bridge: Running;

beforeAll(async () => {
  service = await startService();
  bridge = await startBridgeStub(TOKEN);
});
afterAll(async () => {
  await service?.close();
  await bridge?.close();
});

const KINDS: Record<string, (target: string) => UpstreamConfig> = {
  direct: (target) => ({ kind: "direct", target }),
  bridged: (target) => ({ kind: "bridged", target, bridge: { base: bridge.origin, token: TOKEN } }),
};

/** The Sharer's router with one Service, `foo`, reached through `kind`. */
function sharerFor(kind: string, target = service.origin) {
  const config = KINDS[kind]?.(target);
  if (config == null) throw new Error(`no kind ${kind}`);
  return shareRouter({ services: () => [{ id: "foo", upstream: createUpstream(config) }] });
}

describe.each(Object.keys(KINDS))("01 — %s", (kind) => {
  it("a Guest request reaches the Service with its path and query rewritten", async () => {
    const res = await sharerFor(kind)(new Request("http://sharer.mesh/s/foo/echo/a/b?x=1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ service: "dirk", path: "/echo/a/b", query: "?x=1" });
    // Proof of the path taken: in Node the Service is reachable directly, so
    // without this a "bridged" upstream that skips the Bridge passes too.
    expect(res.headers.get(BRIDGE_MARKER)).toBe(kind === "bridged" ? "relayed" : null);
  });

  it("the Guest's mesh credentials never reach the Service; the app's own authorization does", async () => {
    const res = await sharerFor(kind)(
      new Request("http://sharer.mesh/s/foo/echo", {
        headers: {
          "x-httpeers-token": "guest-membership-token",
          "x-httpeers-peer": "12D3KooWGuest",
          authorization: "Bearer app-session",
        },
      }),
    );

    const { headers } = (await res.json()) as { headers: Record<string, string> };
    expect(headers["x-httpeers-token"]).toBeUndefined();
    expect(headers["x-httpeers-peer"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer app-session");
  });

  it("a Guest cannot pick the Bridge's target, and no Bridge header reaches the Service", async () => {
    // Another local service the Guest would like to reach instead of `foo`.
    const other = await startService();
    try {
      const res = await sharerFor(kind)(
        new Request("http://sharer.mesh/s/foo/echo", {
          headers: {
            [BRIDGE_TARGET_HEADER]: other.origin,
            [BRIDGE_TOKEN_HEADER]: "guessed-token",
          },
        }),
      );

      const { headers } = (await res.json()) as { headers: Record<string, string> };
      expect(headers.host).toBe(new URL(service.origin).host);
      expect(Object.keys(headers).filter((h) => h.startsWith("x-peershare-"))).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it("a Guest's POST reaches the Service with its body", async () => {
    const res = await sharerFor(kind)(
      new Request("http://sharer.mesh/s/foo/echo/form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "hello from Claudia" }),
      }),
    );

    expect(await res.json()).toMatchObject({
      method: "POST",
      path: "/echo/form",
      body: '{"title":"hello from Claudia"}',
    });
  });

  it("a live response streams: the Guest holds the first chunk before the second exists", async () => {
    const res = await within(3000, sharerFor(kind)(new Request("http://sharer.mesh/s/foo/stream")));
    if (res.body == null) throw new Error("no body");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

    expect((await within(3000, reader.read())).value).toBe("first\n");
    streamGate.open();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += r.value;
    expect(rest).toBe("second\n");
  });
});

describe("01 — a Service's redirect", () => {
  it("bridged: reaches the Guest as a path, so they stay in their origin", async () => {
    const res = await sharerFor("bridged")(new Request("http://sharer.mesh/s/foo/redirect-self"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/echo/landed?from=redirect");
  });

  it("bridged: a redirect to another site stays absolute", async () => {
    const res = await sharerFor("bridged")(new Request("http://sharer.mesh/s/foo/redirect-away"));

    expect(res.headers.get("location")).toBe("https://accounts.example/login");
  });

  it("direct: is followed, as the Sharer's browser tab can only do (rung 04)", async () => {
    const res = await sharerFor("direct")(new Request("http://sharer.mesh/s/foo/redirect-self"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: "/echo/landed", query: "?from=redirect" });
  });
});

describe("01 — what is down", () => {
  it("tells 'the Service is down' from 'the Bridge is down', whichever kind is used", async () => {
    const dead = await deadOrigin();
    const ask = (config: UpstreamConfig) =>
      shareRouter({ services: () => [{ id: "foo", upstream: createUpstream(config) }] })(
        new Request("http://sharer.mesh/s/foo/echo"),
      );

    const bridgeAt = (base: string) => ({ base, token: TOKEN });
    const healthy = await ask({ kind: "direct", target: service.origin });
    const directDown = await ask({ kind: "direct", target: dead });
    const serviceDown = await ask({
      kind: "bridged",
      target: dead,
      bridge: bridgeAt(bridge.origin),
    });
    const bridgeDown = await ask({
      kind: "bridged",
      target: service.origin,
      bridge: bridgeAt(dead),
    });

    expect(unreachable(healthy)).toBeUndefined();
    expect(unreachable(directDown)).toBe("service");
    expect(unreachable(serviceDown)).toBe("service");
    expect(unreachable(bridgeDown)).toBe("bridge");
  });
});

/** Fails instead of hanging: a buffering relay never delivers the first chunk. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no data in ${ms} ms`)), ms),
    ),
  ]);
}

/**
 * 04 — Can one GET classify Health and spot what won't work for Guests?
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridge } from "../src/bridge/bridge.js";
import { type Listening, listenLoopback } from "../src/bridge/serve.js";
import { probe } from "../src/probe.js";
import { createUpstream } from "../src/upstreams.js";
import { type AppTraits, deadOrigin, type Running, startApp, VITE_INDEX } from "./fixtures.js";

const TOKEN = "pairing-token-04";
let bridge: Listening;
const running: Running[] = [];

beforeAll(async () => {
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai" }),
  );
});
afterAll(async () => {
  await bridge?.close();
  await Promise.all(running.map((r) => r.close()));
});

/** A Bridged upstream to a fresh app with `traits`. */
async function bridgedTo(traits: AppTraits = {}) {
  const app = await startApp(traits);
  running.push(app);
  return createUpstream({
    kind: "bridged",
    target: app.origin,
    bridge: { base: bridge.origin, token: TOKEN },
  });
}

describe("04 — Health", () => {
  it("ok: the app answers quickly", async () => {
    const report = await probe(await bridgedTo());
    expect(report).toMatchObject({ health: "ok", warnings: [] });
  });

  it("slow: the app answers, but slower than Guests will tolerate", async () => {
    const report = await probe(await bridgedTo({ delayMs: 300 }), { slowMs: 150 });
    expect(report.health).toBe("slow");
    expect(report.ms).toBeGreaterThanOrEqual(300);
  });

  it("down, cause service-down: nothing answers at the app's address", async () => {
    const upstream = createUpstream({
      kind: "bridged",
      target: await deadOrigin(),
      bridge: { base: bridge.origin, token: TOKEN },
    });
    expect(await probe(upstream)).toMatchObject({ health: "down", cause: "service-down" });
  });

  it("down, cause bridge-down: the Bridge is not running", async () => {
    const upstream = createUpstream({
      kind: "bridged",
      target: "http://127.0.0.1:9",
      bridge: { base: await deadOrigin(), token: TOKEN },
    });
    expect(await probe(upstream)).toMatchObject({ health: "down", cause: "bridge-down" });
  });

  it("down, cause service-down: the app answers with a server error", async () => {
    expect(await probe(await bridgedTo({ status: 503 }))).toMatchObject({
      health: "down",
      cause: "service-down",
    });
  });
});

describe("04 — warnings: what will not work for Guests", () => {
  it.each([
    ["Vite", VITE_INDEX],
    ["webpack-dev-server", '<script src="/webpack-dev-server.js"></script>'],
    [
      "Next.js dev",
      '<script src="/_next/static/chunks/webpack.js"></script><script src="/_next/webpack-hmr"></script>',
    ],
    [
      "a page opening its own WebSocket",
      '<script>new WebSocket("ws://" + location.host + "/live")</script>',
    ],
  ])("ws-needed: %s", async (_name, html) => {
    const report = await probe(await bridgedTo({ html }));
    expect(report.health).toBe("ok");
    expect(report.warnings).toContain("ws-needed");
  });

  it("no ws-needed for a page that only mentions WebSockets in text", async () => {
    const report = await probe(await bridgedTo({ html: "<p>We do not use WebSocket here.</p>" }));
    expect(report.warnings).toEqual([]);
  });

  it("cookies-set: the app sets a cookie (a login), which Guests cannot keep", async () => {
    const report = await probe(await bridgedTo({ setCookie: "session=abc; Path=/; HttpOnly" }));
    expect(report.warnings).toContain("cookies-set");
  });
});

describe("04 — cookies, with the Bridge's jars on (M9)", () => {
  let jarBridge: Listening;
  beforeAll(async () => {
    jarBridge = await listenLoopback(
      createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai", cookieJars: true }),
    );
  });
  afterAll(async () => {
    await jarBridge?.close();
  });

  it("no cookies-set warning: the Bridge keeps each Guest's cookies, so logins work", async () => {
    const app = await startApp({ setCookie: "session=abc; Path=/; HttpOnly" });
    running.push(app);
    const upstream = createUpstream({
      kind: "bridged",
      target: app.origin,
      bridge: { base: jarBridge.origin, token: TOKEN },
    });

    expect((await probe(upstream)).warnings).not.toContain("cookies-set");
  });
});

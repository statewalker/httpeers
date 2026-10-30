/**
 * 16 (spike) — Can a jar per Guest keep cookie logins working?
 *
 * Only the Bridge can see `Set-Cookie` (rung 04), so the jar lives there,
 * keyed by the Guest the Sharer names in `x-peershare-guest`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridge } from "../src/bridge/bridge.js";
import { type Listening, listenLoopback } from "../src/bridge/serve.js";
import {
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_GUEST_HEADER as GUEST_HEADER,
} from "../src/upstreams.js";
import type { Running } from "./fixtures.js";
import { startLoginApp } from "./fixtures.js";

const TOKEN = "pairing-token-16";
let app: Running;
let bridge: Listening;

beforeAll(async () => {
  app = await startLoginApp();
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai", cookieJars: true }),
  );
});
afterAll(async () => {
  await bridge?.close();
  await app?.close();
});

const asGuest = (guest: string, path: string) =>
  fetch(`${bridge.origin}${path}`, {
    headers: {
      [BRIDGE_TARGET_HEADER]: app.origin,
      [BRIDGE_TOKEN_HEADER]: TOKEN,
      [GUEST_HEADER]: guest,
    },
  }).then((r) => r.text());

describe("16 — the Bridge's cookie jars", () => {
  it("a Guest's login cookie is sent on that Guest's next request, never on another's", async () => {
    await asGuest("12D3KooWClaudia", "/login?user=claudia");

    expect(await asGuest("12D3KooWClaudia", "/whoami")).toBe("claudia");
    expect(await asGuest("12D3KooWMarta", "/whoami")).toBe("anonymous");
  });
});

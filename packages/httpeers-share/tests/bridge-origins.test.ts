/** The Bridge's origin allow-list and its optional key, over real HTTP and WebSocket. */

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createBridge, originAllowed } from "../src/bridge/bridge.js";
import { type Listening, listenLoopback } from "../src/bridge/serve.js";
import { BRIDGE_MARKER, BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER } from "../src/upstreams.js";

const ORIGINS = ["https://peershare.httpeers.net", "http://localhost:*"];
let app: { origin: string; close(): Promise<void> };
let keyless: Listening;
let keyed: Listening;

beforeAll(async () => {
  const server = createServer((req, res) => res.end(`echo ${req.url}`));
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.send("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  app = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
  keyless = await listenLoopback(createBridge({ token: "", allowedOrigins: ORIGINS }));
  keyed = await listenLoopback(createBridge({ token: "k", allowedOrigins: ORIGINS }));
});
afterAll(async () => {
  await keyless?.close();
  await keyed?.close();
  await app?.close();
});

function call(bridge: Listening, origin: string, token?: string) {
  const headers: Record<string, string> = { origin, [BRIDGE_TARGET_HEADER]: app.origin };
  if (token != null) headers[BRIDGE_TOKEN_HEADER] = token;
  return fetch(`${bridge.origin}/x`, { headers });
}

function socket(bridge: Listening, origin: string, protocol: string): Promise<string> {
  const q = new URLSearchParams({ target: `${app.origin}/live` });
  const url = `${bridge.origin.replace("http:", "ws:")}/.peershare/socket?${q}`;
  return new Promise((resolve, reject) => {
    const ws = new WS(url, [protocol], { origin });
    ws.once("message", (d) => {
      resolve(String(d));
      ws.close();
    });
    ws.once("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });
}

describe("originAllowed", () => {
  it("matches exact origins, any port of a host, and everything", () => {
    expect(originAllowed("https://peershare.httpeers.net", ORIGINS)).toBe(true);
    expect(originAllowed("http://localhost:5173", ORIGINS)).toBe(true);
    expect(originAllowed("http://localhost", ORIGINS)).toBe(true);
    expect(originAllowed("http://localhost.evil.com", ORIGINS)).toBe(false);
    expect(originAllowed("http://localhost:5173.evil.com", ORIGINS)).toBe(false);
    expect(originAllowed("https://localhost:5173", ORIGINS)).toBe(false);
    expect(originAllowed("https://peershare.httpeers.net.evil.com", ORIGINS)).toBe(false);
    expect(originAllowed("https://a.example", ["*"])).toBe(true);
  });
});

describe("the Bridge's origin list", () => {
  it("relays for an allowed origin and grants it CORS", async () => {
    const res = await call(keyless, "http://localhost:8080");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8080");
    expect(await res.text()).toBe("echo /x");
  });

  it("refuses another website with no CORS grant", async () => {
    const res = await call(keyless, "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.headers.get(BRIDGE_MARKER)).toBe("origin-forbidden");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses another website's WebSocket", async () => {
    await expect(socket(keyless, "https://evil.example", "peershare.")).rejects.toThrow("403");
  });
});

describe("the Bridge's key", () => {
  it("is not checked when empty, on HTTP and on WebSockets", async () => {
    expect((await call(keyless, "http://localhost:8080")).status).toBe(200);
    expect(await socket(keyless, "http://localhost:8080", "peershare.")).toBe("hello");
  });

  it("is checked when set", async () => {
    const none = await call(keyed, "http://localhost:8080");
    expect(none.status).toBe(401);
    expect(none.headers.get(BRIDGE_MARKER)).toBe("bad-token");
    expect((await call(keyed, "http://localhost:8080", "k")).status).toBe(200);
    await expect(socket(keyed, "http://localhost:8080", "peershare.")).rejects.toThrow("401");
    expect(await socket(keyed, "http://localhost:8080", "peershare.k")).toBe("hello");
  });
});

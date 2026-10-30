/** M9 — the Bridge relays WebSockets, with the same guards as HTTP. */

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createBridge } from "../src/bridge/bridge.js";
import { type Listening, listenLoopback } from "../src/bridge/serve.js";

const TOKEN = "pairing-token-ws";
const PEERSHARE = "https://tools.sandclaw.ai";
let bridge: Listening;
let app: { origin: string; close(): Promise<void> };

beforeAll(async () => {
  // A dev server's live channel: echoes text, and says which subprotocol it agreed.
  const server = createServer();
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  wss.on("connection", (socket, req) => {
    socket.send(`hello ${req.url} ${socket.protocol}`);
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
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
  bridge = await listenLoopback(createBridge({ token: TOKEN, allowedOrigin: PEERSHARE }));
});
afterAll(async () => {
  await bridge?.close();
  await app?.close();
});

function socketUrl(target: string, protocols = "vite-hmr") {
  const q = new URLSearchParams({ target, protocols });
  return `${bridge.origin.replace("http:", "ws:")}/.peershare/socket?${q}`;
}

function open(
  url: string,
  token = TOKEN,
  origin = PEERSHARE,
): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    // Node's WebSocket cannot set Origin; the `ws` client can.
    import("ws").then(({ WebSocket: WS }) => {
      const ws = new WS(url, [`peershare.${token}`], { origin }) as unknown as WebSocket;
      ws.onmessage = (e) => resolve({ ws, first: String(e.data) });
      ws.onerror = () => reject(new Error("refused"));
    });
  });
}

describe("M9 — the Bridge's sockets", () => {
  it("relays a WebSocket to the app, path and subprotocol included, both ways", async () => {
    const { ws, first } = await open(socketUrl(`${app.origin}/live?x=1`));
    expect(first).toBe("hello /live?x=1 vite-hmr");

    const echo = new Promise<string>((r) => {
      ws.onmessage = (e) => r(String(e.data));
    });
    ws.send("ping");
    expect(await echo).toBe("ping");
    ws.close();
  });

  it("refuses a wrong token, another website, and a target the Bridge may not reach", async () => {
    await expect(open(socketUrl(`${app.origin}/live`), "wrong")).rejects.toThrow("refused");
    await expect(
      open(socketUrl(`${app.origin}/live`), TOKEN, "https://evil.example"),
    ).rejects.toThrow("refused");
    await expect(open(socketUrl("http://8.8.8.8/live"))).rejects.toThrow("refused");
  });
});

/** The Bridge under every runtime the proxy may find: the same contract over HTTP and WebSocket. */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER } from "../src/upstreams.js";

const TOKEN = "pairing-token-runtimes";
const PEERSHARE = "https://peershare.httpeers.net";
const SCRIPT = fileURLToPath(new URL("./runtimes/start-bridge.mjs", import.meta.url));
const COMMANDS: Record<string, string[]> = {
  node: ["node", SCRIPT],
  bun: ["bun", SCRIPT],
  deno: ["deno", "run", "-A", SCRIPT],
};

let app: { origin: string; close(): Promise<void> };

beforeAll(async () => {
  // A local service with HTTP and a live channel.
  const server = createServer((req, res) => res.end(`echo ${req.url}`));
  const wss = new WebSocketServer({ server, handleProtocols: (p) => [...p][0] ?? false });
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
});
afterAll(() => app?.close());

function start(runtime: string): Promise<{ origin: string; child: ChildProcess }> {
  const [cmd, ...args] = COMMANDS[runtime] ?? [];
  const child = spawn(cmd as string, [...args, TOKEN, PEERSHARE], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += d;
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) resolve({ origin: line.trim(), child });
    });
    child.stderr?.on("data", (d) => {
      err += d;
    });
    child.on("exit", (code) => reject(new Error(`${runtime} exited ${code}: ${err}`)));
  });
}

function openSocket(origin: string, target: string): Promise<{ ws: WS; first: string }> {
  const q = new URLSearchParams({ target, protocols: "vite-hmr" });
  const url = `${origin.replace("http:", "ws:")}/.peershare/socket?${q}`;
  return new Promise((resolve, reject) => {
    const ws = new WS(url, [`peershare.${TOKEN}`], { origin: PEERSHARE });
    ws.once("message", (data) => resolve({ ws, first: String(data) }));
    ws.once("error", reject);
  });
}

describe.each(Object.keys(COMMANDS))("the Bridge under %s", (runtime) => {
  let bridge: { origin: string; child: ChildProcess };
  beforeAll(async () => {
    bridge = await start(runtime);
  });
  afterAll(() => {
    bridge?.child.kill();
  });

  it("binds 127.0.0.1", () => {
    expect(bridge.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("relays a cross-origin request to the service", async () => {
    const res = await fetch(`${bridge.origin}/hi?x=1`, {
      headers: {
        origin: PEERSHARE,
        [BRIDGE_TARGET_HEADER]: app.origin,
        [BRIDGE_TOKEN_HEADER]: TOKEN,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
    expect(await res.text()).toBe("echo /hi?x=1");
  });

  it("relays a WebSocket both ways, subprotocol included", async () => {
    const { ws, first } = await openSocket(bridge.origin, `${app.origin}/live`);
    expect(first).toBe("hello /live vite-hmr");
    // The page offered only its token protocol; the app agreed on `vite-hmr` with the Bridge.
    expect(ws.protocol).toBe(`peershare.${TOKEN}`);
    const echo = new Promise<string>((r) => ws.once("message", (d) => r(String(d))));
    ws.send("ping");
    expect(await echo).toBe("ping");
    ws.close();
  });
});

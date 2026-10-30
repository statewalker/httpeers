/**
 * M9 — a WebSocket inside one request: the Guest's tunnel against the
 * Sharer's service table, in-process here (over the mesh in peershare's tests).
 */

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { type ServiceEntry, serviceTable } from "../src/service-table.js";
import { openTunnel, type TunnelSocket } from "../src/socket-tunnel.js";

let app: { ws: string; close(): Promise<void> };

beforeAll(async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (p) => [...p][0] ?? false });
  wss.on("connection", (socket, req) => {
    socket.send(`hello ${req.url} ${socket.protocol}`);
    socket.on("message", (data, isBinary) =>
      socket.send(isBinary ? data : `echo ${data}`, { binary: isBinary }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  app = {
    ws: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
});
afterAll(async () => {
  await app?.close();
});

function table(enabled = true) {
  const services: ServiceEntry[] = [
    {
      id: "dev",
      name: "dev",
      enabled,
      isDefault: true,
      upstream: async () => new Response("http"),
      socket: (path, protocols) => new WebSocket(`${app.ws}${path}`, protocols),
    },
  ];
  return serviceTable(() => services, { sharerName: "Dirk" });
}

function next(socket: TunnelSocket): Promise<unknown> {
  return new Promise((r) => {
    socket.onmessage = (e) => r(e.data);
  });
}

describe("M9 — the socket tunnel", () => {
  it("carries text both ways, with the path and the subprotocol", async () => {
    const socket = openTunnel(table(), "/s/dev/live?x=1", ["vite-hmr"]);
    expect(await next(socket)).toBe("hello /live?x=1 vite-hmr");

    const reply = next(socket);
    socket.send("ping");
    expect(await reply).toBe("echo ping");
    socket.close();
  });

  it("carries binary both ways", async () => {
    const socket = openTunnel(table(), "/s/dev/live", []);
    await next(socket);
    const reply = next(socket);
    socket.send(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array((await reply) as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    socket.close();
  });

  it("a paused Service refuses the socket: it closes at once", async () => {
    const socket = openTunnel(table(false), "/s/dev/live", []);
    const closed = await new Promise<number>((r) => {
      socket.onclose = (e) => r(e.code);
    });
    expect(closed).not.toBe(1000);
  });
});

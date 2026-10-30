/**
 * The Bridge on a port, under Node. Under Bun, `main.ts` hands the same
 * handler to `Bun.serve`.
 */

import type { IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { serve } from "@hono/node-server";
import type { FetchHandler } from "@statewalker/webrun-http-proxy";
import { WebSocketServer } from "ws";
import { acceptedProtocol, connectApp, relaySocket, type SocketGate } from "./sockets.js";

export interface Listening {
  origin: string;
  /** The interface actually bound. */
  address: string;
  close(): Promise<void>;
}

/**
 * Binds 127.0.0.1 only: the Bridge is never reachable from the network. A
 * handler carrying a socket gate (`createBridge`'s) also relays WebSockets.
 */
export function listenLoopback(
  handler: FetchHandler & { sockets?: SocketGate },
  port = 0,
): Promise<Listening> {
  return new Promise((resolve) => {
    // `overrideGlobalObjects: false`: by default @hono/node-server swaps the
    // process's global Request and Response for its own, which breaks streaming
    // request bodies for everything else in the process (found in M9: the mesh
    // member's full-duplex fetch stalled while a Bridge ran in the same process).
    const server = serve(
      { fetch: handler, port, hostname: "127.0.0.1", overrideGlobalObjects: false },
      (info: AddressInfo) => {
        resolve({
          origin: `http://127.0.0.1:${info.port}`,
          address: info.address,
          close: () =>
            new Promise<void>((done) => {
              for (const client of wss.clients) client.terminate();
              if ("closeAllConnections" in server) server.closeAllConnections();
              server.close(() => done());
            }),
        });
      },
    );
    // The subprotocol to accept travels on the request itself, so concurrent
    // upgrades cannot take each other's.
    const accepts = new WeakMap<IncomingMessage, string>();
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (_offered, req) => accepts.get(req) ?? false,
    });
    server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const gate = handler.sockets;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const verdict =
        gate == null
          ? { ok: false as const, status: 400 }
          : await gate(new URL(req.url ?? "/", "http://bridge"), headers);
      if (!verdict.ok) {
        socket.end(`HTTP/1.1 ${verdict.status} Refused\r\nconnection: close\r\n\r\n`);
        return;
      }
      const plan = verdict.plan;
      const app = await connectApp(plan).catch(() => null);
      if (app == null) {
        socket.end("HTTP/1.1 502 Refused\r\nconnection: close\r\n\r\n");
        return;
      }
      const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
      accepts.set(req, acceptedProtocol(plan, app, offered));
      wss.handleUpgrade(req, socket, head, (ws) => {
        const relay = relaySocket(
          { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
          app,
        );
        ws.on("message", (data, isBinary) =>
          relay.message(isBinary ? new Uint8Array(data as Buffer).buffer : String(data)),
        );
        ws.on("close", (code, reason) => relay.close(code, String(reason)));
      });
    });
  });
}

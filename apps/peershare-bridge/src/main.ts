/**
 * `bun run main.ts [--port 9090] [--origin https://peershare.httpeers.net] [--open] [--no-cookie-jars]`
 *
 * Starts the Bridge on 127.0.0.1 and prints the PeerShare URL that pairs the
 * page with it; `--open` also opens that URL in the default browser (rung 14).
 */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  acceptedProtocol,
  connectApp,
  createBridge,
  relaySocket,
  SOCKET_PATH,
} from "@statewalker/httpeers-share/bridge";

/** The slice of Bun's server API the Bridge uses (no `bun-types` needed). */
interface BunSocket {
  data: { app: WebSocket; relay?: ReturnType<typeof relaySocket> };
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}
interface BunServer {
  port: number;
  upgrade(
    request: Request,
    init: { headers: Record<string, string>; data: BunSocket["data"] },
  ): boolean;
}
declare const Bun: {
  serve(init: {
    hostname: string;
    port: number;
    fetch: (request: Request, server: BunServer) => Promise<Response | undefined>;
    websocket: {
      open(ws: BunSocket): void;
      message(ws: BunSocket, message: string | Uint8Array): void;
      close(ws: BunSocket, code: number, reason: string): void;
    };
  }): BunServer;
};

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9090" },
    // Where the PeerShare page lives (decision 2.8).
    origin: { type: "string", default: "https://peershare.httpeers.net" },
    open: { type: "boolean", default: false },
    // Each Guest's cookies kept apart, so cookie logins work for Guests (rung 16, M9).
    "no-cookie-jars": { type: "boolean", default: false },
  },
});

// 32 random bytes: the Pairing token, new on every launch, never stored.
const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const origin = values.origin;

const bridge = createBridge({
  token,
  allowedOrigin: origin,
  cookieJars: !values["no-cookie-jars"],
});

const server = Bun.serve({
  // IPv4 loopback only. The printed URL says 127.0.0.1, never `localhost`,
  // which a browser may try as ::1 first and find nothing there.
  hostname: "127.0.0.1",
  port: Number(values.port),
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (
      url.pathname !== SOCKET_PATH ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return bridge(request);
    }
    // A WebSocket for the app (M9): the same guards as HTTP.
    const verdict = await bridge.sockets(url, request.headers);
    if (!verdict.ok) return new Response(null, { status: verdict.status });
    // The app first: the page is then given the subprotocol the app chose.
    const app = await connectApp(verdict.plan).catch(() => null);
    if (app == null) return new Response(null, { status: 502 });
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim());
    const upgraded = srv.upgrade(request, {
      headers: { "sec-websocket-protocol": acceptedProtocol(verdict.plan, app, offered) },
      data: { app },
    });
    if (upgraded) return undefined;
    app.close();
    return new Response("WebSocket upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.data.relay = relaySocket(
        { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
        ws.data.app,
      );
    },
    message(ws, message) {
      ws.data.relay?.message(typeof message === "string" ? message : message.slice().buffer);
    },
    close(ws, code, reason) {
      ws.data.relay?.close(code, reason);
    },
  },
});

const localUrl = `http://127.0.0.1:${server.port}`;
const pairing = new URLSearchParams({ localUrl, t: token });
console.log(`PeerShare Bridge listening on ${localUrl}`);
console.log("Open this page to share your local services:");
console.log(`${origin}/peer-share#${pairing}`);

if (values.open) openInBrowser(`${origin}/peer-share#${pairing}`);

/** The platform's opener; `PEERSHARE_OPEN` overrides it (tests, unusual desktops). */
function openInBrowser(url: string): void {
  const opener =
    process.env.PEERSHARE_OPEN ??
    (process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open");
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {
    console.log("Could not open a browser; open the link above yourself.");
  });
}

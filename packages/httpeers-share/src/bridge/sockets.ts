/**
 * The Bridge's WebSockets (M9): `/.peershare/socket?target=<url>&protocols=a,b`.
 *
 * Guarded exactly like HTTP (rung 02): the PeerShare origin only, the
 * Pairing token (as the subprotocol `peershare.<token>`, because a browser
 * cannot set headers on a WebSocket), and the same target rules. Then one
 * socket to the app is relayed message for message, both ways.
 */

import type { BridgeInit } from "./bridge.js";
import { reachable, sameSecret } from "./bridge.js";

export const SOCKET_PATH = "/.peershare/socket";
export const TOKEN_PROTOCOL_PREFIX = "peershare.";

export interface SocketPlan {
  /** The app's WebSocket URL. */
  target: string;
  /** The subprotocols to offer the app. */
  protocols: string[];
  /** The one the Bridge accepts from the page (its token protocol). */
  accept: string;
}

export type SocketGate = (
  url: URL,
  headers: Headers,
) => Promise<{ ok: true; plan: SocketPlan } | { ok: false; status: 400 | 401 | 403 | 502 }>;

export function socketGate(
  init: Pick<BridgeInit, "token" | "allowedOrigin">,
  resolveHost: (name: string) => Promise<string[]>,
): SocketGate {
  return async (url, headers) => {
    if (url.pathname !== SOCKET_PATH) return { ok: false, status: 400 };
    const origin = headers.get("origin");
    if (origin != null && origin !== init.allowedOrigin) return { ok: false, status: 403 };

    const offered = (headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
    const accept = offered.find(
      (p) =>
        p.startsWith(TOKEN_PROTOCOL_PREFIX) &&
        sameSecret(p.slice(TOKEN_PROTOCOL_PREFIX.length), init.token),
    );
    if (accept == null) return { ok: false, status: 401 };

    const target = url.searchParams.get("target") ?? "";
    let http: URL;
    try {
      http = new URL(target);
    } catch {
      return { ok: false, status: 400 };
    }
    const reach = await reachable(http.href.replace(/^ws/, "http"), resolveHost);
    if (reach !== "ok") return { ok: false, status: reach === "forbidden" ? 403 : 502 };

    const ws = new URL(http);
    ws.protocol = http.protocol === "https:" || http.protocol === "wss:" ? "wss:" : "ws:";
    const protocols = (url.searchParams.get("protocols") ?? "").split(",").filter(Boolean);
    return { ok: true, plan: { target: ws.href, protocols, accept } };
  };
}

/** The page's side of a relayed socket, whatever server accepted it. */
export interface InboundSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

/**
 * Open the app's socket first: the page's upgrade is completed only once the
 * app has accepted, so the page can be given the subprotocol the APP chose
 * (a WebSocket's protocol is fixed by its handshake). Rejects if the app
 * refuses or cannot be reached.
 */
export function connectApp(plan: SocketPlan): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const app = new WebSocket(plan.target, plan.protocols);
    app.binaryType = "arraybuffer";
    // An app often speaks first ("hello" on connect), before the page's side
    // is upgraded and relaying: held here, delivered first by `relaySocket`.
    const held: Array<string | ArrayBuffer> = [];
    early.set(app, held);
    app.onmessage = (e) => held.push(e.data as string | ArrayBuffer);
    app.onopen = () => resolve(app);
    app.onerror = () => reject(new Error(`the app's socket at ${plan.target} refused`));
  });
}

/** The subprotocol to accept from the page: the app's choice when the page offered it, else the token's. */
export function acceptedProtocol(plan: SocketPlan, app: WebSocket, offered: string[]): string {
  return app.protocol !== "" && offered.includes(app.protocol) ? app.protocol : plan.accept;
}

const early = new WeakMap<WebSocket, Array<string | ArrayBuffer>>();

/** Relay two open sockets, message for message, both ways; returns the inbound side's event sinks. */
export function relaySocket(
  inbound: InboundSocket,
  app: WebSocket,
): { message(data: string | ArrayBuffer): void; close(code?: number, reason?: string): void } {
  for (const data of early.get(app)?.splice(0) ?? []) inbound.send(data);
  app.onmessage = (e) => inbound.send(e.data as string | ArrayBuffer);
  app.onclose = (e) => inbound.close(closable(e.code), e.reason);
  app.onerror = () => inbound.close(1011, "the app's socket failed");
  return {
    message(data) {
      if (app.readyState === WebSocket.OPEN) app.send(data);
    },
    close(code, reason) {
      if (app.readyState <= WebSocket.OPEN) app.close(closable(code), reason);
    },
  };
}

/** A code `close()` may be called with (1000, or 3000–4999); anything else becomes 1000. */
function closable(code?: number): number {
  return code === 1000 || (code != null && code >= 3000 && code <= 4999) ? code : 1000;
}

/**
 * Real servers on real ports, so the rung measures HTTP rather than mocks.
 *
 * `startService` is the Sharer's local app (Dirk's `localhost:5173`).
 * `startBridgeStub` is a THROWAWAY stand-in for the Bridge: just enough to
 * relay, with none of the lock-down rung 02 is about. Only its wire contract
 * (`BRIDGE_TARGET_HEADER`, `BRIDGE_TOKEN_HEADER`) matters here.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BRIDGE_MARKER, BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER } from "../src/upstreams.js";

export interface Running {
  origin: string;
  close(): Promise<void>;
}

export function startService(): Promise<Running> {
  return listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/echo")) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          service: "dirk",
          method: req.method,
          path: url.pathname,
          query: url.search,
          headers,
          body,
        }),
      );
      return;
    }

    if (url.pathname === "/cors-star") {
      // A dev server's typical "allow everything" policy.
      res.writeHead(200, {
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "*",
      });
      res.end("open to all");
      return;
    }

    if (url.pathname.startsWith("/redirect-")) {
      // `/redirect-self` → this Service's own `/echo/landed`, absolute, as most
      // frameworks write it; `/redirect-away` → somewhere else entirely.
      const location =
        url.pathname === "/redirect-self"
          ? `http://${req.headers.host}/echo/landed?from=redirect`
          : "https://accounts.example/login";
      res.writeHead(302, { location });
      res.end();
      return;
    }

    if (url.pathname === "/stream") {
      // The second chunk is written only after the first was READ by the
      // test, so a relay that buffers deadlocks instead of passing by luck.
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.write("first\n");
      streamGate.wait().then(() => res.end("second\n"));
      return;
    }

    res.writeHead(404).end("not found");
  });
}

/** Lets a test release the second chunk of `/stream` once it holds the first. */
export const streamGate = (() => {
  let release: () => void = () => {};
  let gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    wait: () => gate,
    open() {
      release();
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
  };
})();

export function startBridgeStub(token: string): Promise<Running> {
  return listen(async (req, res) => {
    if (req.headers[BRIDGE_TOKEN_HEADER] !== token) {
      res.writeHead(401, { [BRIDGE_MARKER]: "bad-token" }).end();
      return;
    }
    const target = req.headers[BRIDGE_TARGET_HEADER];
    if (typeof target !== "string") {
      res.writeHead(400, { [BRIDGE_MARKER]: "no-target" }).end();
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    // The Bridge's own headers are consumed by this hop.
    headers.delete(BRIDGE_TOKEN_HEADER);
    headers.delete(BRIDGE_TARGET_HEADER);
    headers.delete("host");
    // Hop-by-hop headers describe THIS connection, not the next one; undici
    // refuses a request that carries them (a streamed POST arrives with
    // `transfer-encoding: chunked`). Rung 02's Bridge must drop them too.
    for (const hop of ["connection", "keep-alive", "transfer-encoding", "content-length"]) {
      headers.delete(hop);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const upstream = await fetch(new URL(req.url ?? "/", target), {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
        redirect: "manual",
      });
      res.writeHead(upstream.status, {
        ...Object.fromEntries(upstream.headers),
        [BRIDGE_MARKER]: "relayed",
      });
      if (upstream.body == null) res.end();
      else Readable.fromWeb(upstream.body as never).pipe(res);
    } catch {
      res.writeHead(502, { [BRIDGE_MARKER]: "target-unreachable" }).end();
    }
  });
}

/** A port that was listening and is now closed: connecting to it is refused. */
export async function deadOrigin(): Promise<string> {
  const s = await startService();
  await s.close();
  return s.origin;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<Running> {
  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Local apps with the traits the Probe looks for, on real ports. */

export interface AppTraits {
  /** HTML served at `/`. */
  html?: string;
  /** Delay before answering, in ms. */
  delayMs?: number;
  /** A `Set-Cookie` the app sends, as a login would. */
  setCookie?: string;
  /** Send `Access-Control-Allow-Origin: <origin>` (Direct needs it). */
  cors?: boolean;
  status?: number;
}

export async function startApp(traits: AppTraits = {}): Promise<Running> {
  const server = createServer((req, res) => {
    setTimeout(() => {
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      if (traits.setCookie != null) headers["set-cookie"] = traits.setCookie;
      if (traits.cors === true) headers["access-control-allow-origin"] = req.headers.origin ?? "*";
      res.writeHead(traits.status ?? 200, headers);
      res.end(traits.html ?? "<!doctype html><title>app</title><p>hello</p>");
    }, traits.delayMs ?? 0);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** What Vite's dev server serves at `/`: its client opens a WebSocket for hot reload. */
export const VITE_INDEX = `<!doctype html><html><head>
<script type="module" src="/@vite/client"></script>
</head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>`;

export async function startLoginApp(): Promise<Running> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/login") {
      const user = url.searchParams.get("user") ?? "nobody";
      return void res
        .writeHead(200, { "set-cookie": `session=${user}; Path=/; HttpOnly` })
        .end("logged in");
    }
    if (url.pathname === "/whoami") {
      const session = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      return void res.writeHead(200, { "content-type": "text/plain" }).end(session ?? "anonymous");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

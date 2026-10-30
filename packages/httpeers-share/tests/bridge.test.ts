/**
 * 02 — Can a loopback CORS relay be safe from other websites?
 *
 * The seam is the Bridge's HTTP port: every test talks to a real listening
 * Bridge, which relays to a real local Service (rung 01's fixture).
 */

import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridge } from "../src/bridge/bridge.js";
import { type Listening, listenLoopback } from "../src/bridge/serve.js";
import { shareRouter } from "../src/share-router.js";
import {
  BRIDGE_MARKER,
  BRIDGE_REDIRECT_LOCATION_HEADER,
  BRIDGE_REDIRECT_STATUS_HEADER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
  createUpstream,
  unreachable,
} from "../src/upstreams.js";
import { deadOrigin, type Running, startService, streamGate } from "./fixtures.js";

const TOKEN = "pairing-token-02";
const PEERSHARE = "https://tools.sandclaw.ai";

let service: Running;
let bridge: Listening;

beforeAll(async () => {
  service = await startService();
  bridge = await listenLoopback(createBridge({ token: TOKEN, allowedOrigin: PEERSHARE }));
});
afterAll(async () => {
  await bridge?.close();
  await service?.close();
});

/** A request to the Bridge as the PeerShare page would send it; `init.headers` override. */
function toBridge(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return fetch(`${bridge.origin}${path}`, {
    ...init,
    headers: {
      origin: PEERSHARE,
      [BRIDGE_TARGET_HEADER]: service.origin,
      [BRIDGE_TOKEN_HEADER]: TOKEN,
      ...init.headers,
    },
  });
}

describe("02 — the Bridge refuses", () => {
  it("the PeerShare page with a stale token: 401 it can read, so it can say 'relaunch the Bridge'", async () => {
    // Readable to the PeerShare origin only: other sites are refused before
    // the token is looked at (below), and a browser cannot forge `Origin`.
    const res = await toBridge("/echo", { headers: { [BRIDGE_TOKEN_HEADER]: "stale" } });

    expect(res.status).toBe(401);
    expect(res.headers.get(BRIDGE_MARKER)).toBe("bad-token");
    expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
  });

  it("anyone else without the token: 401, and no cross-origin permission", async () => {
    const res = await fetch(`${bridge.origin}/echo`, {
      headers: { [BRIDGE_TARGET_HEADER]: service.origin },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("another website, even with the token: 403, and no cross-origin permission", async () => {
    const res = await toBridge("/echo", { headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("02 — the Bridge's hello", () => {
  it("answers the PeerShare page with who it is when no target is named", async () => {
    const res = await toBridge("/", { headers: { [BRIDGE_TARGET_HEADER]: "" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
    expect(await res.json()).toEqual({ bridge: "peershare" });
  });
});

describe("02 — the Bridge relays", () => {
  it("the PeerShare page's request, to the Service, and lets the page read the answer", async () => {
    const res = await toBridge("/echo/a?x=1");

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
    expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
    expect(res.headers.get(BRIDGE_MARKER)).toBe("relayed");
    // Without this a browser page cannot read the marker at all.
    expect(exposed(res)).toContain(BRIDGE_MARKER);

    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body).toMatchObject({ service: "dirk", path: "/echo/a", query: "?x=1" });
    expect(Object.keys(body.headers).filter((h) => h.startsWith("x-peershare-"))).toEqual([]);
  });
});

describe("02 — the Service's own CORS policy", () => {
  it("is replaced: the page gets its one origin, never `*` or credentials", async () => {
    const res = await toBridge("/cors-star");

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });
});

describe("02 — a Service's redirect", () => {
  it("never reaches the page as a 3xx: it is restated in headers the page can read", async () => {
    const res = await toBridge("/redirect-self", { redirect: "manual" });

    expect(res.status).toBe(200);
    expect(res.headers.get(BRIDGE_REDIRECT_STATUS_HEADER)).toBe("302");
    // Same origin as the Service: made relative, so the Guest stays in their origin.
    expect(res.headers.get(BRIDGE_REDIRECT_LOCATION_HEADER)).toBe("/echo/landed?from=redirect");
    expect(exposed(res)).toEqual(
      expect.arrayContaining([BRIDGE_REDIRECT_STATUS_HEADER, BRIDGE_REDIRECT_LOCATION_HEADER]),
    );
  });

  it("to another site keeps its absolute location", async () => {
    const res = await toBridge("/redirect-away", { redirect: "manual" });

    expect(res.headers.get(BRIDGE_REDIRECT_LOCATION_HEADER)).toBe("https://accounts.example/login");
  });
});

function exposed(res: Response): string[] {
  return (res.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase());
}

describe("02 — the Bridge's preflight", () => {
  /** A preflight carries no custom headers, so no token: browsers never send one. */
  function preflight(origin: string) {
    return fetch(`${bridge.origin}/echo`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": `content-type, ${BRIDGE_TARGET_HEADER}, ${BRIDGE_TOKEN_HEADER}`,
        "access-control-request-private-network": "true",
      },
    });
  }

  it("grants the PeerShare page the methods, headers and private-network access it needs", async () => {
    const res = await preflight(PEERSHARE);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const h of ["content-type", BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER]) {
      expect(allowed).toContain(h);
    }
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("grants nothing to another website", async () => {
    const res = await preflight("https://evil.example");

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-private-network")).toBeNull();
  });
});

describe("02 — where the Bridge relays", () => {
  /** A Bridge whose outbound network is a recorder: LAN addresses do not exist on a test runner. */
  async function recordingBridge() {
    const reached: string[] = [];
    const fetchImpl = (async (req: Request) => {
      reached.push(new URL(req.url).origin);
      return new Response("ok");
    }) as typeof fetch;
    // The resolver is the other network boundary: `.local` names resolve
    // to whatever this table says, as mDNS on the Sharer's LAN would.
    const resolveHost = async (name: string) => MDNS[name] ?? [];
    const b = await listenLoopback(
      createBridge({ token: TOKEN, allowedOrigin: PEERSHARE, fetchImpl, resolveHost }),
    );
    return { b, reached };
  }

  const MDNS: Record<string, string[]> = {
    "nas.local": ["192.168.1.30"],
    "rebound.local": ["192.168.1.31", "8.8.8.8"], // one public answer is enough to refuse
    "public.local": ["93.184.216.34"],
  };

  it.each(["http://rebound.local", "http://public.local"])(
    "refuses %s: a .local name that resolves to a public address",
    async (target) => {
      const { b, reached } = await recordingBridge();
      try {
        const res = await fetch(`${b.origin}/`, {
          headers: {
            origin: PEERSHARE,
            [BRIDGE_TARGET_HEADER]: target,
            [BRIDGE_TOKEN_HEADER]: TOKEN,
          },
        });
        expect(res.status).toBe(403);
        expect(res.headers.get(BRIDGE_MARKER)).toBe("target-forbidden");
        expect(reached).toEqual([]);
      } finally {
        await b.close();
      }
    },
  );

  it("reports a .local name that does not resolve as unreachable", async () => {
    const { b, reached } = await recordingBridge();
    try {
      const res = await fetch(`${b.origin}/`, {
        headers: {
          origin: PEERSHARE,
          [BRIDGE_TARGET_HEADER]: "http://gone.local",
          [BRIDGE_TOKEN_HEADER]: TOKEN,
        },
      });
      expect(res.status).toBe(502);
      expect(res.headers.get(BRIDGE_MARKER)).toBe("target-unreachable");
      expect(reached).toEqual([]);
    } finally {
      await b.close();
    }
  });

  const FORBIDDEN = [
    "http://8.8.8.8", // a public address
    "https://example.com", // any DNS name but localhost: rebinding turns names into anything
    "http://dev.localhost:3000", // *.localhost is loopback by convention only; a resolver may forward it
    "http://169.254.169.254", // link-local: cloud metadata
    "http://[fe80::1]", // IPv6 link-local
    "http://0.0.0.0:8080", // "any interface", reaches loopback by accident on some systems
    "http://100.128.0.1", // just past carrier-grade NAT (100.64/10)
    "file:///etc/passwd", // not HTTP at all
  ];

  it.each(FORBIDDEN)("refuses %s, and says so to the page", async (target) => {
    const { b, reached } = await recordingBridge();
    try {
      const res = await fetch(`${b.origin}/`, {
        headers: {
          origin: PEERSHARE,
          [BRIDGE_TARGET_HEADER]: target,
          [BRIDGE_TOKEN_HEADER]: TOKEN,
        },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get(BRIDGE_MARKER)).toBe("target-forbidden");
      expect(res.headers.get("access-control-allow-origin")).toBe(PEERSHARE);
      expect(reached).toEqual([]);
    } finally {
      await b.close();
    }
  });

  const ALLOWED = [
    "http://localhost:5173",
    "http://127.0.0.1:9000",
    "http://[::1]:8000",
    "http://10.0.0.5",
    "http://172.16.4.2:8080",
    "http://192.168.1.20:8000",
    "http://[fd12:3456::1]:80", // IPv6 unique-local
    "http://100.64.0.1:8080", // Tailscale / carrier-grade NAT (100.64/10)
    "http://100.101.102.103",
    "http://nas.local:8000", // mDNS: resolved first, see `resolveHost` below
  ];

  it.each(ALLOWED)("relays to %s", async (target) => {
    const { b, reached } = await recordingBridge();
    try {
      const res = await fetch(`${b.origin}/`, {
        headers: {
          origin: PEERSHARE,
          [BRIDGE_TARGET_HEADER]: target,
          [BRIDGE_TOKEN_HEADER]: TOKEN,
        },
      });
      expect(res.status).toBe(200);
      expect(reached).toEqual([new URL(target).origin]);
    } finally {
      await b.close();
    }
  });
});

describe("02 — rung 01's Bridged upstream, against the real Bridge", () => {
  const sharer = (target: string, base = bridge.origin) =>
    shareRouter({
      services: () => [
        {
          id: "foo",
          upstream: createUpstream({ kind: "bridged", target, bridge: { base, token: TOKEN } }),
        },
      ],
    });

  it("reaches the Service, and the response says it was relayed", async () => {
    const res = await sharer(service.origin)(new Request("http://sharer.mesh/s/foo/echo/x"));

    expect(res.headers.get(BRIDGE_MARKER)).toBe("relayed");
    expect(await res.json()).toMatchObject({ path: "/echo/x" });
  });

  it("'the Service is down' and 'the Bridge is down' are still told apart", async () => {
    const dead = await deadOrigin();

    const serviceDown = await sharer(dead)(new Request("http://sharer.mesh/s/foo/echo"));
    const bridgeDown = await sharer(
      service.origin,
      dead,
    )(new Request("http://sharer.mesh/s/foo/echo"));

    expect(unreachable(serviceDown)).toBe("service");
    expect(unreachable(bridgeDown)).toBe("bridge");
  });

  it("a Service's redirect reaches the Guest as a real redirect, inside their origin", async () => {
    const res = await sharer(service.origin)(new Request("http://sharer.mesh/s/foo/redirect-self"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/echo/landed?from=redirect");
  });

  it("a Guest's POST arrives whole (hop-by-hop headers do not cross the Bridge)", async () => {
    const res = await sharer(service.origin)(
      new Request("http://sharer.mesh/s/foo/echo/form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "hello from Claudia" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      method: "POST",
      body: '{"title":"hello from Claudia"}',
    });
  });

  it("a live response streams through the Bridge", async () => {
    const res = await within(
      3000,
      sharer(service.origin)(new Request("http://sharer.mesh/s/foo/stream")),
    );
    if (res.body == null) throw new Error("no body");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

    expect((await within(3000, reader.read())).value).toBe("first\n");
    streamGate.open();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += r.value;
    expect(rest).toBe("second\n");
  });
});

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no data in ${ms} ms`)), ms),
    ),
  ]);
}

describe("02 — the Bridge's port", () => {
  it("is bound to loopback only: unreachable through this machine's other addresses", async () => {
    expect(bridge.address).toBe("127.0.0.1");

    const port = new URL(bridge.origin).port;
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i != null && i.family === "IPv4" && !i.internal)
      .map((i) => i?.address);
    for (const address of others) {
      await expect(fetch(`http://${address}:${port}/`)).rejects.toThrow();
    }
  });
});

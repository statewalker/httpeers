/**
 * R-1: the mount truth table.
 *
 * Mount semantics were never specified — longest-prefix was implemented,
 * but overlapping mounts, trailing slashes, the root mount and
 * segment-boundary matching were all unstated. This file pins the contract
 * rather than leaving it implied.
 *
 * One case below was rewritten rather than promoted unchanged: the archived
 * suite asserted that a trailing-slash mount (`/api/`) does NOT match the
 * bare prefix (`/api`) — a trap its own source comment called out and said
 * should be normalised or documented, with neither done at the time. That
 * has since been ruled: normalise. The rewritten case asserts the
 * normalised behaviour instead of the trap.
 */
import { describe, expect, it } from "vitest";
import { registerPeer } from "../src/peer-context.js";
import { createMounts, createPeerRouter } from "../src/router.js";

const SELF = "12D3KooWSelfaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "12D3KooWOtherbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface EchoedPath {
  path: string;
  search: string;
}

function mountsFor(prefixes: string[]) {
  const m = createMounts();
  for (const p of prefixes) m.provide(p, async () => new Response(p));
  return m;
}

const hit = async (prefixes: string[], path: string): Promise<string | null> => {
  const h = mountsFor(prefixes).match(path);
  return h == null ? null : await (await h(new Request(`http://p${path}`))).text();
};

describe("R-1: mount matching", () => {
  it("matches an exact path", async () => {
    expect(await hit(["/test"], "/test")).toBe("/test");
  });

  it("matches below the prefix", async () => {
    expect(await hit(["/test"], "/test/deep/path")).toBe("/test");
  });

  it("respects segment boundaries — /test must not match /testing", async () => {
    expect(await hit(["/test"], "/testing")).toBeNull();
  });

  it("longest prefix wins, whatever the registration order", async () => {
    expect(await hit(["/a", "/a/b"], "/a/b/c")).toBe("/a/b");
    expect(await hit(["/a/b", "/a"], "/a/b/c")).toBe("/a/b");
  });

  it("falls back to the shorter prefix outside the longer one", async () => {
    expect(await hit(["/a", "/a/b"], "/a/zzz")).toBe("/a");
  });

  it("the root mount catches everything", async () => {
    expect(await hit(["/"], "/anything/at/all")).toBe("/");
    expect(await hit(["/"], "/")).toBe("/");
  });

  it("a specific mount beats the root mount", async () => {
    expect(await hit(["/", "/api"], "/api/x")).toBe("/api");
    expect(await hit(["/", "/api"], "/other")).toBe("/");
  });

  it("a trailing-slash mount is normalised — /api/ and /api are the same mount", async () => {
    // Ruling: normalise in provide()/match() rather than leave the trap
    // documented. '/api/' now matches '/api', '/api/x' and '/api/' alike.
    expect(await hit(["/api/"], "/api/x")).toBe("/api/");
    expect(await hit(["/api/"], "/api/")).toBe("/api/");
    expect(await hit(["/api/"], "/api")).toBe("/api/");
  });

  it("returns null when nothing matches", async () => {
    expect(await hit(["/a"], "/b")).toBeNull();
  });
});

describe("R-1: peer-prefix routing", () => {
  function build() {
    const mounts = createMounts();
    mounts.provide("/", async (req) => {
      const u = new URL(req.url);
      return new Response(JSON.stringify({ path: u.pathname, search: u.search }));
    });
    const calls: Array<[string, string]> = [];
    const remote = async (peer: string, req: Request) => {
      calls.push([peer, new URL(req.url).pathname + new URL(req.url).search]);
      return new Response("forwarded");
    };
    return {
      route: createPeerRouter({
        selfPeerId: SELF,
        mounts,
        remote,
        allowForward: async () => true, // forwarding is deny-by-default; see R-2
      }),
      calls,
    };
  }

  it("serves an unprefixed path locally", async () => {
    const { route, calls } = build();
    const body = (await (await route(new Request("http://p/x/y"))).json()) as EchoedPath;
    expect(body.path).toBe("/x/y");
    expect(calls).toHaveLength(0);
  });

  it("strips its OWN peer prefix and keeps the query", async () => {
    const { route } = build();
    const body = (await (
      await route(new Request(`http://p/${SELF}/x/y?a=1`))
    ).json()) as EchoedPath;
    expect(body.path).toBe("/x/y");
    expect(body.search).toBe("?a=1"); // impossible before note 15
  });

  it("forwards another peer prefix, query included", async () => {
    const { route, calls } = build();
    await route(new Request(`http://p/${OTHER}/x/y?a=1`));
    expect(calls).toEqual([[OTHER, "/x/y?a=1"]]);
  });

  it("a bare peer id addresses that peer at /", async () => {
    const { route, calls } = build();
    await route(new Request(`http://p/${OTHER}`));
    expect(calls[0]?.[0]).toBe(OTHER);
    expect(calls[0]?.[1]).toBe("/");
  });

  it("forwarding is DENIED by default — relaying is a capability", async () => {
    const mounts = createMounts();
    mounts.provide("/", async () => new Response("local"));
    const route = createPeerRouter({
      selfPeerId: SELF,
      mounts,
      remote: async () => new Response("forwarded"),
    });
    const res = await route(new Request(`http://p/${OTHER}/x`));
    expect(res.status).toBe(403);
  });

  it("a segment that merely looks path-like is NOT treated as a peer", async () => {
    const { route, calls } = build();
    const body = (await (await route(new Request("http://p/12D3Koo/x"))).json()) as EchoedPath;
    expect(body.path).toBe("/12D3Koo/x"); // too short to be a peer id
    expect(calls).toHaveLength(0);
  });

  it("carries the peer binding across the self-prefix re-creation", async () => {
    const mounts = createMounts();
    let seen: unknown;
    mounts.provide("/", async (req) => {
      const { lookupPeer } = await import("../src/peer-context.js");
      seen = lookupPeer(req);
      return new Response("ok");
    });
    const route = createPeerRouter({
      selfPeerId: SELF,
      mounts,
      remote: async () => new Response(),
    });
    const req = new Request(`http://p/${SELF}/x`);
    registerPeer(req, OTHER);
    await route(req);
    expect(seen).toBe(OTHER);
  });

  it("a self-prefixed POST keeps its body", async () => {
    // The self-prefix branch does `new Request(url, req)`. Under undici a
    // request with a STREAMING body needs duplex:'half'; a buffered one
    // does not. Confirmed: buffered bodies survive.
    const mounts = createMounts();
    mounts.provide("/", async (req) => new Response(await req.text()));
    const route = createPeerRouter({
      selfPeerId: SELF,
      mounts,
      remote: async () => new Response(),
    });
    const res = await route(new Request(`http://p/${SELF}/x`, { method: "POST", body: "payload" }));
    expect(await res.text()).toBe("payload");
  });
});

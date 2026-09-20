/**
 * The session demo, minus the browser: the hub's app and the pinned handler
 * a session's requests land in, wired as the app page wires them.
 */
import { type FetchHandler, MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import { pinnedPeer } from "@statewalker/httpeers-ghost";
import { beforeEach, describe, expect, it } from "vitest";
import { createDemoSpa, SPA_ADVERTISEMENT } from "../src/shared/demo-spa.js";
import { meshRules } from "../src/shared/policy.js";
import {
  callThroughMember,
  type MeshMember,
  meshAppServices,
  withDeadline,
} from "../src/shared/session-frame.js";

const HUB = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const OTHER = "12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa";

describe("the hub's demo app", () => {
  const spa = createDemoSpa({ selfPeerId: () => HUB });

  it.each([
    ["/spa", "text/html"],
    ["/spa/", "text/html"],
    ["/spa/index.html", "text/html"],
    ["/spa/app.js", "text/javascript"],
    ["/spa/style.css", "text/css"],
    ["/spa/api/hello", "application/json"],
  ])("serves %s as %s", async (path, type) => {
    const res = await spa(new Request(`http://peer.local${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
  });

  // The page addresses a peer EXPLICITLY under `/peers/`, and the only peer it
  // can be sure of is the one that just answered. So `/api/hello` names it.
  it("names the peer that answered, which is what the page addresses", async () => {
    const res = await spa(new Request("http://peer.local/spa/api/hello"));
    expect((await res.json()).peer).toBe(HUB);
  });

  // THE FIREFOX CASE, at the one end of it this can reach without a browser:
  // whatever body arrives comes back with its length, so a body lost on the
  // way is a mismatch rather than an empty string nobody looks at.
  it("echoes a POSTed body, with its length", async () => {
    const sent = JSON.stringify({ from: "abc.p.httpeers.net", nonce: "1" });
    const res = await spa(
      new Request("http://peer.local/spa/api/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sent,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: sent, bytes: sent.length, method: "POST" });
  });

  it("is advertised under the mount it is served at", () => {
    expect(SPA_ADVERTISEMENT.kind).toBe("app");
    expect(SPA_ADVERTISEMENT.id).toBe("spa");
  });

  it("is reachable to members under the mesh rules", () => {
    // The policy is Datalog; this only checks both forms are present, so a
    // mount without its allow is caught here rather than as a 403 in a browser.
    const text = JSON.stringify(meshRules());
    expect(text).toContain('resource(\\"/spa\\")');
    expect(text).toContain('starts_with(\\"/spa/\\")');
  });
});

describe("a session's requests, as the app page routes them", () => {
  function wire() {
    const seen: string[] = [];
    const spa = createDemoSpa({ selfPeerId: () => HUB });
    const memberFetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      // The MEMBERSHIP token, in its own header: `Authorization` belongs to the
      // app and the mesh never reads it (`MESH_TOKEN_HEADER`).
      seen.push(`${url.pathname}${url.search} ${request.headers.get(MESH_TOKEN_HEADER)}`);
      // The member's edge: /peers/<peer>/<rest> -> that peer's handler.
      const [, , peer, ...rest] = url.pathname.split("/");
      if (peer !== HUB) return new Response("unreachable", { status: 502 });
      return spa(new Request(`http://peer.local/${rest.join("/")}${url.search}`, request));
    };
    const handler = pinnedPeer({
      landing: { peerId: HUB, appPath: "/spa" },
      basePath: "/",
      token: () => "TOKEN",
      remote: callThroughMember(memberFetch, "peers"),
    });
    return { handler, seen };
  }

  it("serves the session's index.html from the pinned peer's app", async () => {
    const { handler, seen } = wire();
    const res = await handler(new Request("https://abc.p.httpeers.net/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("A mesh app, in its own origin");
    expect(seen).toEqual([`/peers/${HUB}/spa/ TOKEN`]);
  });

  it("maps a root-absolute path to the app's mount on the same peer", async () => {
    const { handler, seen } = wire();
    const res = await handler(new Request("https://abc.p.httpeers.net/api/hello?x=1"));
    expect((await res.json()).message).toContain("over the mesh");
    expect(seen).toEqual([`/peers/${HUB}/spa/api/hello?x=1 TOKEN`]);
  });

  it("cannot be steered to another peer", async () => {
    const { handler, seen } = wire();
    const res = await handler(new Request(`https://abc.p.httpeers.net/${OTHER}/spa/`));
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });
});

/**
 * Everything a call through the fake member touches lands here, keyed by the
 * forwarded request's path -- modelled on `wire()`'s `seen`, but shared
 * across the two services `wireServices()` builds so a test can see which
 * service dispatched where.
 */
let seenPaths: string[] = [];

beforeEach(() => {
  seenPaths = [];
});

/**
 * What `openMeshApp` would register for a session, without opening one: the
 * app pinned to HUB and the mesh gateway, both wired to the same fake member
 * as `wire()` wires its single pinned handler.
 *
 * The fake member answers HUB's own app through the demo SPA (so the pinned
 * service's response is real) and answers any other peer with a bare 200
 * (the mesh test only needs to see the gateway reach it, not what it serves).
 *
 * `member.fetch` is a READER over a swappable `current` -- `setFetch` stands
 * in for `session.ts` reassigning the whole `MemberHandle` on a reconnect
 * (a new value, never mutated in place) or clearing it to `null` on a
 * disconnect ("this page left the mesh"). A captured `FetchHandler` value
 * instead of a reader would not be able to model either.
 */
function wireServices() {
  const spa = createDemoSpa({ selfPeerId: () => HUB });
  let current: FetchHandler | null = async (request) => {
    const url = new URL(request.url);
    seenPaths.push(`${url.pathname}${url.search}`);
    // The member's edge: /peers/<peer>/<rest> -> that peer's handler.
    const [, , peer, ...rest] = url.pathname.split("/");
    if (peer === HUB) {
      return spa(new Request(`http://peer.local/${rest.join("/")}${url.search}`, request));
    }
    return new Response("ok", { status: 200 });
  };
  const member: MeshMember = {
    peerId: HUB,
    fetch: () => current,
    meshView: () => null,
    token: () => "TOKEN",
  };
  // meshAppServices never touches the container -- only openMeshApp does, to
  // append the iframe -- so a real DOM element is not needed to build and
  // test the two services in Node.
  const services = meshAppServices({
    peerId: HUB,
    appPath: "/spa",
    member,
    container: {} as HTMLElement,
  });
  return {
    services,
    setFetch(next: FetchHandler | null) {
      current = next;
    },
  };
}

describe("a session's two services", () => {
  it("gives the app's own requests to the pinned peer", async () => {
    const { services } = wireServices();
    const app = services.find((s) => s.path === "/");
    const res = await app?.handler(new Request("https://abc.p.httpeers.net/api/hello"));
    expect(res?.status).toBe(200);
    expect(seenPaths).toEqual([`/peers/${HUB}/spa/api/hello`]);
  });

  // THE WHOLE MESH, BY DESIGN (spec §3.2): an app in a session may call any
  // peer the parent can see, bounded by that peer's own ingress policy.
  it("gives a /peers/ request to the gateway, which reaches the named peer", async () => {
    const { services } = wireServices();
    const mesh = services.find((s) => s.path === "/peers/");
    const res = await mesh?.handler(
      new Request(`https://abc.p.httpeers.net/peers/${OTHER}/llm/v1`),
    );
    expect(res?.status).toBe(200);
    expect(seenPaths).toEqual([`/peers/${OTHER}/llm/v1`]);
  });

  // THE WHOLE POINT OF TASK 8, minus the browser: a POST addressed through
  // `/peers/` reaches the named peer WITH ITS BODY. `createGateway` reads the
  // body with core's `bodyOf` precisely because Firefox has no
  // `Request.prototype.body`; there the body used to arrive empty and silent.
  it("carries a POSTed body through /peers/ to the named peer", async () => {
    const { services } = wireServices();
    const mesh = services.find((s) => s.path === "/peers/");
    const sent = JSON.stringify({ from: "abc.p.httpeers.net", nonce: "1" });
    const res = await mesh?.handler(
      new Request(`https://abc.p.httpeers.net/peers/${HUB}/spa/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sent,
      }),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ echoed: sent, bytes: sent.length, method: "POST" });
    expect(seenPaths).toEqual([`/peers/${HUB}/spa/api/echo`]);
  });

  // The un-stripped mount prefix is createGateway's basePath. Stripping twice
  // would send `/llm/v1` to the edge with no peer in it.
  it("does not strip the prefix twice", async () => {
    const { services } = wireServices();
    const mesh = services.find((s) => s.path === "/peers/");
    await mesh?.handler(new Request(`https://abc.p.httpeers.net/peers/${OTHER}/llm/v1?x=1`));
    expect(seenPaths[0]).toContain(`/${OTHER}/`);
  });

  // THE REGRESSION THIS GUARDS AGAINST: `member.fetch` captured as a VALUE at
  // session-open time would keep answering through the stopped node forever,
  // because `session.ts` REPLACES the whole MemberHandle on a reconnect
  // rather than mutating it -- nothing would ever reassign a captured value.
  it("reaches the newly live handle after a reconnect, not the stopped one", async () => {
    const { services, setFetch } = wireServices();
    const app = services.find((s) => s.path === "/");

    setFetch(async () => new Response("A"));
    const first = await app?.handler(new Request("https://abc.p.httpeers.net/api/hello"));
    expect(await first?.text()).toBe("A");

    // The reconnect: a brand-new handle, not a mutation of the old one.
    setFetch(async () => new Response("B"));
    const second = await app?.handler(new Request("https://abc.p.httpeers.net/api/hello"));
    expect(await second?.text()).toBe("B");
  });

  // Not a 502 from a dead node's dispatch and not a 504 from the deadline --
  // an explicit, legible refusal the moment the member has no live handle.
  it("answers 503 once the page has left the mesh", async () => {
    const { services, setFetch } = wireServices();
    const app = services.find((s) => s.path === "/");

    setFetch(null);
    const res = await app?.handler(new Request("https://abc.p.httpeers.net/api/hello"));
    expect(res?.status).toBe(503);
    expect(await res?.text()).toBe("this page left the mesh");
  });
});

describe("withDeadline", () => {
  it("passes a prompt answer through untouched", async () => {
    const guarded = withDeadline(async () => new Response("ok"), 50);
    expect(await (await guarded(new Request("http://x/"))).text()).toBe("ok");
  });

  // A HANDLER THAT NEVER ANSWERS WOULD HANG THE IFRAME FOREVER. The relay has
  // no timeout of its own, so the party that knows the app sets the bound.
  it("answers 504 when the handler does not", async () => {
    const guarded = withDeadline(() => new Promise<Response>(() => {}), 20);
    const res = await guarded(new Request("http://x/"));
    expect(res.status).toBe(504);
  });
});

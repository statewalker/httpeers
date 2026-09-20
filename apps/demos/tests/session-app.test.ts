/**
 * The session demo, minus the browser: the hub's app and the pinned handler
 * a session's requests land in, wired as the app page wires them.
 */
import { MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import { pinnedPeer } from "@statewalker/httpeers-ghost";
import { describe, expect, it } from "vitest";
import { createDemoSpa, SPA_ADVERTISEMENT } from "../src/shared/demo-spa.js";
import { meshRules } from "../src/shared/policy.js";
import { callThroughMember } from "../src/shared/session-frame.js";

const HUB = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const OTHER = "12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa";

describe("the hub's demo app", () => {
  const spa = createDemoSpa();

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
    const spa = createDemoSpa();
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

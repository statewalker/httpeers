/**
 * The door binds where it is told. On a host-networked hub (`compose.host.yml`)
 * `0.0.0.0` would put the door on every host interface, so the
 * address must be settable and must actually be the one bound.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalDoorHandler,
  createStaticUiHandler,
  type LocalDoor,
  startLocalDoor,
} from "../src/local-door.js";
import type { ServiceModule } from "../src/service-module.js";

const SECRET = "s3cr3t-door-value";
const ALLOWED = ["127.0.0.1:8080", "localhost:8080"];

async function withDoor(hostname: string | undefined, check: (door: LocalDoor) => void) {
  const door = await startLocalDoor({
    port: 0,
    hostname,
    hubPeerId: "12D3KooWHub",
    modules: [],
    secret: SECRET,
    allowedHosts: ALLOWED,
  });
  try {
    check(door);
  } finally {
    await door.stop();
  }
}

describe("startLocalDoor", () => {
  it("binds the configured address", async () => {
    await withDoor("127.0.0.1", (door) => {
      expect(door.address).toBe("127.0.0.1");
      expect(door.port).toBeGreaterThan(0);
    });
  });

  it("binds every interface by default", async () => {
    await withDoor(undefined, (door) => expect(door.address).toBe("0.0.0.0"));
  });
});

describe("the door's gate", () => {
  const HUB = "12D3KooWHub";
  let seen: Request | undefined;
  const echo: ServiceModule = {
    id: "echo",
    advertisement: { id: "echo", kind: "test-service", title: "Echo" },
    rules: [],
    policies: [],
    handler: async (request) => {
      seen = request;
      return Response.json({ ok: true });
    },
  };
  const handler = createLocalDoorHandler({
    hubPeerId: HUB,
    modules: [echo],
    secret: SECRET,
    allowedHosts: ALLOWED,
    adminApi: async () => Response.json({ admin: true }),
    ui: async () => new Response("<h1>ui</h1>"),
  });

  /** A request as Traefik forwards it: the allowed Host, the secret, whatever else is given. */
  function forwarded(
    path: string,
    {
      host = "127.0.0.1:8080",
      secret = SECRET as string | null,
      ...init
    }: RequestInit & {
      host?: string;
      secret?: string | null;
    } = {},
  ): Request {
    const headers = new Headers(init.headers);
    headers.set("host", host);
    if (secret != null) headers.set("x-hub-door-secret", secret);
    return new Request(`http://${host}${path}`, { ...init, headers });
  }

  const ROUTES = ["/", "/app.js", "/hub/api/mesh", `/peers/${HUB}/echo/x`, "/elsewhere"];

  it("401s every route without the secret header", async () => {
    for (const path of ROUTES) {
      const res = await handler(forwarded(path, { secret: null }));
      expect(res.status, path).toBe(401);
    }
  });

  it("401s every route with a wrong secret, including one that is a prefix of the right one", async () => {
    for (const secret of ["wrong", SECRET.slice(0, -1), `${SECRET}x`, ""]) {
      for (const path of ROUTES) {
        expect((await handler(forwarded(path, { secret }))).status, `${secret} ${path}`).toBe(401);
      }
    }
  });

  it("passes the right secret on an allowed host", async () => {
    expect((await handler(forwarded("/"))).status).toBe(200);
    expect((await handler(forwarded("/hub/api/mesh"))).status).toBe(200);
    expect(
      (await handler(forwarded(`/peers/${HUB}/echo/x`, { host: "localhost:8080" }))).status,
    ).toBe(200);
  });

  it("never hands the secret on to a module", async () => {
    seen = undefined;
    await handler(forwarded(`/peers/${HUB}/echo/x`));
    expect(seen).toBeDefined();
    expect((seen as Request | undefined)?.headers.get("x-hub-door-secret")).toBeNull();
  });

  it("421s a Host that is not allowed, even with the right secret", async () => {
    for (const host of ["evil.example:8080", "127.0.0.1:8787", "172.27.0.2:8787", "localhost"]) {
      const res = await handler(forwarded("/hub/api/mesh", { host }));
      expect(res.status, host).toBe(421);
    }
  });

  it("421s when the Host header and the URL's authority disagree", async () => {
    const request = new Request("http://127.0.0.1:8080/hub/api/mesh", {
      headers: { host: "rebound.example:8080", "x-hub-door-secret": SECRET },
    });
    expect((await handler(request)).status).toBe(421);
  });

  it("matches hosts case-insensitively", async () => {
    expect((await handler(forwarded("/", { host: "LOCALHOST:8080" }))).status).toBe(200);
  });

  it("403s a state-changing request from another origin; allows its own origin or none", async () => {
    const post = (origin?: string) =>
      handler(
        forwarded("/hub/api/invitations", {
          method: "POST",
          body: "{}",
          ...(origin != null ? { headers: { origin } } : {}),
        }),
      );
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("http://127.0.0.1:8787")).status).toBe(403);
    expect((await post("null")).status).toBe(403);
    expect((await post("http://127.0.0.1:8080")).status).toBe(200);
    expect((await post("http://localhost:8080")).status).toBe(200);
    expect((await post()).status).toBe(200);
    // DELETE is state-changing too.
    const del = await handler(
      forwarded("/hub/api/members/x", {
        method: "DELETE",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(del.status).toBe(403);
  });

  it("does not origin-check GET and HEAD", async () => {
    const get = await handler(
      forwarded("/hub/api/mesh", { headers: { origin: "https://evil.example" } }),
    );
    expect(get.status).toBe(200);
  });

  it("refuses to be built without a secret or without allowed hosts", () => {
    const base = { hubPeerId: HUB, modules: [], allowedHosts: ALLOWED, secret: SECRET };
    expect(() => createLocalDoorHandler({ ...base, secret: "" })).toThrow(/secret/);
    expect(() =>
      createLocalDoorHandler({ ...base, secret: undefined as unknown as string }),
    ).toThrow(/secret/);
    expect(() => createLocalDoorHandler({ ...base, allowedHosts: [] })).toThrow(/allowed host/);
    expect(() => createLocalDoorHandler({ ...base, allowedHosts: ["a/b"] })).toThrow(/host:port/);
  });

  it("startLocalDoor refuses to bind without a secret", async () => {
    await expect(
      startLocalDoor({ port: 0, hubPeerId: HUB, modules: [], secret: "", allowedHosts: ALLOWED }),
    ).rejects.toThrow(/secret/);
  });
});

/**
 * The root rescue. LiteLLM's exported dashboard is a client-routed app: with a
 * `token` cookie already set, its login page routes the browser to `/ui` at the
 * ORIGIN ROOT, because the router knows nothing about `SERVER_ROOT_PATH`. On the
 * door that landed on the admin UI's 404. The door serves exactly one hub, so
 * `/ui...` at the root is unambiguous and it sends the browser back under the
 * prefix.
 */
describe("the door's /ui rescue", () => {
  const HUB = "12D3KooWHub";
  const handler = createLocalDoorHandler({
    hubPeerId: HUB,
    modules: [
      {
        id: "llm",
        advertisement: { id: "llm", kind: "openapi-service", title: "LLM" },
        rules: [],
        policies: [],
        handler: async (request) => Response.json({ llm: new URL(request.url).pathname }),
      },
    ],
    secret: SECRET,
    allowedHosts: ALLOWED,
    adminApi: async () => Response.json({ admin: true }),
    ui: async () => new Response("<h1>ui</h1>"),
  });
  const get = (path: string, init: RequestInit = {}) =>
    handler(
      new Request(`http://127.0.0.1:8080${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          host: "127.0.0.1:8080",
          "x-hub-door-secret": SECRET,
        },
      }),
    );

  it("307s /ui and /ui/ to the hub's own prefixed dashboard", async () => {
    for (const path of ["/ui", "/ui/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toBe(`/peers/${HUB}/llm/ui/`);
    }
  });

  it("keeps the query string", async () => {
    const res = await get("/ui/?redirect_to=%2Fui%2F&x=1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/peers/${HUB}/llm/ui/?redirect_to=%2Fui%2F&x=1`);
  });

  it("keeps a deeper dashboard path", async () => {
    const res = await get("/ui/models?page=2");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/peers/${HUB}/llm/ui/models?page=2`);
  });

  it("answers HEAD the same way", async () => {
    const res = await get("/ui/", { method: "HEAD" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/peers/${HUB}/llm/ui/`);
  });

  it("never redirects a request already under /peers/, so it cannot loop", async () => {
    const res = await get(`/peers/${HUB}/llm/ui/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ llm: "/llm/ui/" });
    // Another peer's prefix is not this door's business either: no rescue, no loop.
    const other = await get("/peers/12D3KooWOther/llm/ui/");
    expect(other.status).not.toBe(307);
    expect(await other.text()).toBe("<h1>ui</h1>");
  });

  it("rescues only /ui, never a path that merely starts with those letters", async () => {
    for (const path of ["/uix", "/ui.txt", "/uiconfig", "/hub/api/ui", "/"]) {
      const res = await get(path);
      expect(res.status, path).not.toBe(307);
    }
  });

  it("leaves non-GET/HEAD methods alone: an escaped navigation is always a GET", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await get("/ui/", { method });
      expect(res.status, method).not.toBe(307);
    }
  });

  it("still rescues when the hub has no llm module -- the door does not vouch for the target", async () => {
    const bare = createLocalDoorHandler({
      hubPeerId: HUB,
      modules: [],
      secret: SECRET,
      allowedHosts: ALLOWED,
      ui: async () => new Response("<h1>ui</h1>"),
    });
    const res = await bare(
      new Request("http://127.0.0.1:8080/ui/", {
        headers: { host: "127.0.0.1:8080", "x-hub-door-secret": SECRET },
      }),
    );
    expect(res.status).toBe(307);
  });

  it("is behind the gate: no secret, no rescue", async () => {
    const res = await handler(
      new Request("http://127.0.0.1:8080/ui/", { headers: { host: "127.0.0.1:8080" } }),
    );
    expect(res.status).toBe(401);
  });
});

describe("createStaticUiHandler", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
  });

  /**
   * `<parent>/dist-ui/…` plus a `secret.txt` OUTSIDE it, one level up — what a
   * traversal attempt would have to reach to prove anything, rather than just
   * hitting a 404 that a missing file would produce anyway.
   */
  async function fixture() {
    const parent = await mkdtemp(join(tmpdir(), "hub-ui-"));
    dirs.push(parent);
    const root = join(parent, "dist-ui");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "index.html"), "<h1>Hub</h1>");
    await writeFile(join(root, "app.js"), "console.log(1);");
    await writeFile(join(root, "sub", "style.css"), "body {}");
    await writeFile(join(parent, "secret.txt"), "TOP SECRET");
    return { root, parent, handler: createStaticUiHandler(root) };
  }

  it("serves index.html at /, with the right content type", async () => {
    const { handler } = await fixture();
    const res = await handler(new Request("http://door.local/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>Hub</h1>");
  });

  it("serves nested assets with their content type", async () => {
    const { handler } = await fixture();
    const js = await handler(new Request("http://door.local/app.js"));
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");

    const css = await handler(new Request("http://door.local/sub/style.css"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
  });

  it("404s a file that does not exist", async () => {
    const { handler } = await fixture();
    const res = await handler(new Request("http://door.local/nope.txt"));
    expect(res.status).toBe(404);
  });

  it("never serves a file above the root: a literal .. in the URL", async () => {
    const { handler } = await fixture();
    const res = await handler(new Request("http://door.local/../secret.txt"));
    expect(res.status).toBe(404);
  });

  it("never serves a file above the root: a percent-encoded .. in the URL", async () => {
    const { handler } = await fixture();
    // Decodes to "/../secret.txt" -- `new URL(...)` cannot collapse this dot
    // segment itself, because it never sees it as literal "..": the boundary
    // check after decoding is what has to catch it.
    const res = await handler(new Request("http://door.local/%2e%2e/secret.txt"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP SECRET");
  });
});

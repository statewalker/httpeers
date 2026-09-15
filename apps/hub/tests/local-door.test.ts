/**
 * The door binds where it is told. On a host-networked hub (`compose.host.yml`)
 * `0.0.0.0` would put the unauthenticated door on every host interface, so the
 * address must be settable and must actually be the one bound.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStaticUiHandler, type LocalDoor, startLocalDoor } from "../src/local-door.js";

async function withDoor(hostname: string | undefined, check: (door: LocalDoor) => void) {
  const door = await startLocalDoor({ port: 0, hostname, hubPeerId: "12D3KooWHub", modules: [] });
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

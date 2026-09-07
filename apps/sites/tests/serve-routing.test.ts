import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve.js";

function app(files: Record<string, string>) {
  // Caching off: these tests assert resolution, not cache behaviour.
  return createApp({ files: new MemFilesApi({ initialFiles: files }), cacheTtlMs: 0 });
}

const H = (host = "abc.net") => ({ headers: { Host: host } });

describe("routing", () => {
  it("serves the root index", async () => {
    const res = await app({ "/abc.net/index.html": "home" }).request("/", H());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("home");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves an exact file", async () => {
    const res = await app({ "/abc.net/a.css": "body{}" }).request("/a.css", H());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("serves /foo from /foo.html", async () => {
    const res = await app({ "/abc.net/foo.html": "F" }).request("/foo", H());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("F");
  });

  // Serving /foo/index.html AT /foo breaks every relative link inside it:
  // `img.png` would resolve to /img.png, not /foo/img.png. The symptom is
  // missing images, which looks nothing like a routing bug.
  it("redirects /foo to /foo/ when it resolves to a directory index", async () => {
    const res = await app({ "/abc.net/foo/index.html": "F" }).request("/foo", H());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/foo/");
  });

  it("serves /foo/ directly, without redirecting", async () => {
    const res = await app({ "/abc.net/foo/index.html": "F" }).request("/foo/", H());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("F");
  });

  it("preserves the query string across the redirect", async () => {
    const res = await app({ "/abc.net/foo/index.html": "F" }).request("/foo?a=1", H());
    expect(res.headers.get("location")).toBe("/foo/?a=1");
  });

  it("returns a plain 404 when nothing matches", async () => {
    const res = await app({ "/abc.net/index.html": "home" }).request("/nope", H());
    expect(res.status).toBe(404);
  });

  it("serves /404.html with a 404 status when present", async () => {
    const res = await app({
      "/abc.net/index.html": "home",
      "/abc.net/404.html": "custom",
    }).request("/nope", H());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("custom");
  });

  // 200, not 404: client-side routers need the document to load.
  it("serves index.html with 200 for an unmatched path when spa is on", async () => {
    const res = await app({
      "/abc.net/index.html": "shell",
      "/abc.net/.site/config.json": JSON.stringify({ spa: true }),
    }).request("/deep/link", H());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell");
  });

  it("404s an unknown site", async () => {
    const res = await app({ "/abc.net/index.html": "home" }).request("/", H("nope.net"));
    expect(res.status).toBe(404);
  });

  it("400s an invalid Host without touching storage", async () => {
    const res = await app({ "/abc.net/index.html": "home" }).request("/", H("../etc"));
    expect(res.status).toBe(400);
  });

  it("404s the config directory rather than forbidding it", async () => {
    const res = await app({ "/abc.net/.site/config.json": "{}" }).request(
      "/.site/config.json",
      H(),
    );
    expect(res.status).toBe(404);
  });

  it("still serves other dotfiles, so /.well-known keeps working", async () => {
    const res = await app({ "/abc.net/.well-known/x.txt": "ok" }).request(
      "/.well-known/x.txt",
      H(),
    );
    expect(res.status).toBe(200);
  });

  it("applies the site's Cache-Control", async () => {
    const res = await app({
      "/abc.net/index.html": "home",
      "/abc.net/.site/config.json": JSON.stringify({ cacheControl: "public, max-age=99" }),
    }).request("/", H());
    expect(res.headers.get("cache-control")).toBe("public, max-age=99");
  });

  it("defaults Cache-Control to no-cache", async () => {
    const res = await app({ "/abc.net/index.html": "home" }).request("/", H());
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
  });
});

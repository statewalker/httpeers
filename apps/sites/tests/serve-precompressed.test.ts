import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve.js";
import { cacheControlFor, DEFAULT_SITE_CONFIG } from "../src/site-config.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

function app(files: Record<string, string>, config?: object) {
  const initialFiles = { ...files };
  if (config) initialFiles["/abc.net/.site/config.json"] = JSON.stringify(config);
  return createApp({ files: new MemFilesApi({ initialFiles }), cacheTtlMs: 0 });
}

const req = (headers: Record<string, string> = {}) => ({
  headers: { Host: "abc.net", ...headers },
});

const FILES = {
  "/abc.net/app.js": "identity",
  "/abc.net/app.js.br": "brotli",
  "/abc.net/app.js.gz": "gzipped",
  "/abc.net/plain.css": "body{}",
};

describe("pre-compressed files", () => {
  it("are ignored unless the site turns them on", async () => {
    const res = await app(FILES).request("/app.js", req({ "Accept-Encoding": "br, gzip" }));
    expect(await res.text()).toBe("identity");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("serve the .br copy to a client that accepts br", async () => {
    const res = await app(FILES, { precompressed: true }).request(
      "/app.js",
      req({ "Accept-Encoding": "gzip, deflate, br" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("brotli");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-length")).toBe(String("brotli".length));
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("etag")).toMatch(/-br"$/);
  });

  it("fall back to .gz when br is not accepted", async () => {
    const res = await app(FILES, { precompressed: true }).request(
      "/app.js",
      req({ "Accept-Encoding": "br;q=0, gzip" }),
    );
    expect(await res.text()).toBe("gzipped");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("serve the file itself without Accept-Encoding, still varying on it", async () => {
    const res = await app(FILES, { precompressed: true }).request("/app.js", req());
    expect(await res.text()).toBe("identity");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("serve the file itself when no copy exists", async () => {
    const res = await app(FILES, { precompressed: true }).request(
      "/plain.css",
      req({ "Accept-Encoding": "br" }),
    );
    expect(await res.text()).toBe("body{}");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("take `*` as any encoding not refused", async () => {
    const res = await app(FILES, { precompressed: true }).request(
      "/app.js",
      req({ "Accept-Encoding": "*;q=0.5, br;q=0" }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("answer a range request from the file itself", async () => {
    const res = await app(FILES, { precompressed: true }).request(
      "/app.js",
      req({ "Accept-Encoding": "br", Range: "bytes=0-3" }),
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("iden");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("revalidate against the encoding's own validator", async () => {
    const a = app(FILES, { precompressed: true });
    const first = await a.request("/app.js", req({ "Accept-Encoding": "br" }));
    const etag = first.headers.get("etag") ?? "";
    const again = await a.request(
      "/app.js",
      req({ "Accept-Encoding": "br", "If-None-Match": etag }),
    );
    expect(again.status).toBe(304);
    expect(again.headers.get("content-encoding")).toBe("br");
    const identity = await a.request("/app.js", req({ "If-None-Match": etag }));
    expect(identity.status).toBe(200);
  });

  it("read whitespace around `;` as RFC 9110 allows", async () => {
    const a = app(FILES, { precompressed: true });
    const refused = await a.request("/app.js", req({ "Accept-Encoding": "br ; q=0, *" }));
    expect(refused.headers.get("content-encoding")).toBe("gzip");
    const spaced = await a.request("/app.js", req({ "Accept-Encoding": "gzip ;q = 0.5" }));
    expect(spaced.headers.get("content-encoding")).toBe("gzip");
  });

  it("follow the client's preference, br first at equal q", async () => {
    const a = app(FILES, { precompressed: true });
    const prefers = await a.request("/app.js", req({ "Accept-Encoding": "br;q=0.1, gzip" }));
    expect(prefers.headers.get("content-encoding")).toBe("gzip");
    const xgzip = await a.request("/app.js", req({ "Accept-Encoding": "x-gzip" }));
    expect(xgzip.headers.get("content-encoding")).toBe("gzip");
  });
});

describe("cache rules", () => {
  const config = {
    cacheRules: [
      { prefix: "/_astro/", cacheControl: IMMUTABLE },
      { prefix: "/_astro/fresh/", cacheControl: "no-store" },
      { prefix: "no-slash", cacheControl: "ignored" },
    ],
  };
  const files = {
    "/abc.net/index.html": "home",
    "/abc.net/_astro/a.js": "a",
    "/abc.net/_astro/fresh/b.js": "b",
  };

  it("give a matching path the rule's Cache-Control", async () => {
    const res = await app(files, config).request("/_astro/a.js", req());
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
  });

  it("let the longest prefix win", async () => {
    const res = await app(files, config).request("/_astro/fresh/b.js", req());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("leave other paths on the site's Cache-Control", async () => {
    const res = await app(files, config).request("/", req());
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
  });

  it("drop entries that are no rule", () => {
    expect(cacheControlFor({ ...DEFAULT_SITE_CONFIG, cacheRules: [] }, "/x")).toBe(
      "public, no-cache",
    );
  });
});

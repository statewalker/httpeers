import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve.js";

const PAGE = "https://peershare.httpeers.net";

function app(cors?: unknown[]) {
  const files: Record<string, string> = {
    "/abc.net/index.html": "home",
    "/abc.net/docs/index.html": "docs",
    "/abc.net/404.html": "missing",
  };
  if (cors != null) files["/abc.net/.site/config.json"] = JSON.stringify({ cors });
  return createApp({ files: new MemFilesApi({ initialFiles: files }), cacheTtlMs: 0 });
}

const req = (headers: Record<string, string>, method = "GET") => ({
  method,
  headers: { Host: "abc.net", ...headers },
});

describe("cors", () => {
  it("a site without `cors` sends no CORS headers, and refuses OPTIONS as before", async () => {
    const res = await app().request("/", req({ Origin: PAGE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await app().request("/", req({ Origin: PAGE }, "OPTIONS"));
    expect(pre.status).toBe(405);
  });

  it("allows a listed origin on every response, and varies on Origin", async () => {
    const site = app([PAGE]);
    const ok = await site.request("/", req({ Origin: PAGE }));
    expect(ok.headers.get("access-control-allow-origin")).toBe(PAGE);
    expect(ok.headers.get("vary")).toContain("Origin");
    const missing = await site.request("/nope", req({ Origin: PAGE }));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(PAGE);
  });

  it("allows no other origin, and says nothing to a request without one", async () => {
    const site = app([PAGE]);
    const other = await site.request("/", req({ Origin: "https://evil.example" }));
    expect(other.status).toBe(200);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const none = await site.request("/", req({}));
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("`*` allows any origin, without Vary", async () => {
    const res = await app(["*"]).request("/", req({ Origin: "https://any.example" }));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBeNull();
  });

  // A shared cache must not hand a navigation's answer (no grant) to a listed origin's fetch.
  it("varies on Origin for every request to a site that lists origins, allowed or not", async () => {
    const site = app([PAGE]);
    for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: PAGE }]) {
      const res = await site.request("/", req(headers));
      expect(res.headers.get("vary")).toContain("Origin");
    }
    const plain = await app().request("/", req({ Origin: PAGE }));
    expect(plain.headers.get("vary")).toBeNull();
  });

  it("grants on redirects, 304s, ranges, HEAD and the custom 404 too", async () => {
    const site = app([PAGE]);
    const redirect = await site.request("/docs", req({ Origin: PAGE }));
    expect(redirect.status).toBe(301);
    const full = await site.request("/", req({ Origin: PAGE }));
    const etag = full.headers.get("etag") ?? "";
    const notModified = await site.request("/", req({ Origin: PAGE, "If-None-Match": etag }));
    expect(notModified.status).toBe(304);
    const range = await site.request("/", req({ Origin: PAGE, Range: "bytes=0-1" }));
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("ho");
    const head = await site.request("/", req({ Origin: PAGE }, "HEAD"));
    const missing = await site.request("/nope", req({ Origin: PAGE }));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("missing");
    for (const res of [redirect, notModified, range, head, missing]) {
      expect(res.headers.get("access-control-allow-origin")).toBe(PAGE);
    }
  });

  it("matches a listed origin written with capitals or a trailing slash", async () => {
    const res = await app(["https://PeerShare.httpeers.net/"]).request("/", req({ Origin: PAGE }));
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGE);
  });

  it("never grants the `null` origin (sandboxed frames, data: and file: pages)", async () => {
    const res = await app(["null", PAGE]).request("/", req({ Origin: "null" }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  // A request with a non-safelisted header (PeerShare's x-peershare-guest) is preflighted.
  it("answers a preflight from an allowed origin with the requested headers", async () => {
    const res = await app([PAGE]).request(
      "/",
      req(
        {
          Origin: PAGE,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-peershare-guest, accept-language",
        },
        "OPTIONS",
      ),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGE);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "x-peershare-guest, accept-language",
    );
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("answers a preflight that asks for no headers without an Allow-Headers", async () => {
    const res = await app([PAGE]).request(
      "/",
      req({ Origin: PAGE, "Access-Control-Request-Method": "GET" }, "OPTIONS"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.has("access-control-allow-headers")).toBe(false);
  });

  it("refuses an OPTIONS that is no preflight, even from an allowed origin", async () => {
    const res = await app([PAGE]).request("/", req({ Origin: PAGE }, "OPTIONS"));
    expect(res.status).toBe(405);
  });

  it("keeps the old order: other methods are 405 before the host is looked at", async () => {
    const res = await app().request("/", { method: "POST", headers: { Host: "" } });
    expect(res.status).toBe(405);
  });

  it("refuses a preflight from another origin", async () => {
    const res = await app([PAGE]).request(
      "/",
      req({ Origin: "https://evil.example", "Access-Control-Request-Method": "GET" }, "OPTIONS"),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("still allows only reading: POST is refused even from an allowed origin", async () => {
    const res = await app([PAGE]).request("/", req({ Origin: PAGE }, "POST"));
    expect(res.status).toBe(405);
  });
});

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve.js";

const PAGE = "https://peershare.httpeers.net";

function app(cors?: string[]) {
  const files: Record<string, string> = { "/abc.net/index.html": "home" };
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

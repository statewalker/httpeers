import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve.js";

function app() {
  return createApp({
    files: new MemFilesApi({ initialFiles: { "/abc.net/index.html": "home" } }),
    cacheTtlMs: 0,
  });
}
const H = { headers: { Host: "abc.net" } };

describe("conditional requests", () => {
  it("sends a weak ETag and Last-Modified", async () => {
    const res = await app().request("/", H);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("returns 304 with no body when If-None-Match matches", async () => {
    const a = app();
    const first = await a.request("/", H);
    const etag = first.headers.get("etag") as string;
    const res = await a.request("/", { headers: { Host: "abc.net", "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("serves normally when If-None-Match does not match", async () => {
    const res = await app().request("/", {
      headers: { Host: "abc.net", "If-None-Match": 'W/"nope"' },
    });
    expect(res.status).toBe(200);
  });

  it("returns 304 when If-Modified-Since is at or after the mtime", async () => {
    const a = app();
    const first = await a.request("/", H);
    const lastModified = first.headers.get("last-modified") as string;
    const res = await a.request("/", {
      headers: { Host: "abc.net", "If-Modified-Since": lastModified },
    });
    expect(res.status).toBe(304);
  });

  // If-None-Match takes precedence over If-Modified-Since (RFC 9110).
  it("prefers If-None-Match when both are present", async () => {
    const a = app();
    const first = await a.request("/", H);
    const res = await a.request("/", {
      headers: {
        Host: "abc.net",
        "If-None-Match": 'W/"nope"',
        "If-Modified-Since": first.headers.get("last-modified") as string,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("methods", () => {
  it("answers HEAD with headers and no body", async () => {
    const res = await app().request("/", { method: "HEAD", headers: { Host: "abc.net" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("");
  });

  it("rejects other methods with 405 and an Allow header", async () => {
    const res = await app().request("/", { method: "POST", headers: { Host: "abc.net" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

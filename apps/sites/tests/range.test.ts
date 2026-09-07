import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { parseRange } from "../src/range.js";
import { createApp } from "../src/serve.js";

describe("parseRange", () => {
  it("parses a closed range", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  it("clamps an end beyond the file", () => {
    expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
  });

  it("reports a start beyond the file as unsatisfiable", () => {
    expect(parseRange("bytes=200-", 100)).toBe("unsatisfiable");
  });

  it("ignores an absent or non-bytes unit", () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange("items=0-9", 100)).toBeUndefined();
  });

  // Multi-range needs multipart/byteranges; falling back to 200 is allowed
  // and is far better than answering with a wrong single range.
  it("ignores a multi-range request", () => {
    expect(parseRange("bytes=0-9,20-29", 100)).toBeUndefined();
  });
});

describe("range responses", () => {
  const app = () =>
    createApp({
      files: new MemFilesApi({ initialFiles: { "/abc.net/a.txt": "0123456789" } }),
      cacheTtlMs: 0,
    });

  it("returns 206 with Content-Range and exactly the requested bytes", async () => {
    const res = await app().request("/a.txt", {
      headers: { Host: "abc.net", Range: "bytes=2-4" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(res.headers.get("content-length")).toBe("3");
    expect(await res.text()).toBe("234");
  });

  it("returns 416 with Content-Range for an unsatisfiable range", async () => {
    const res = await app().request("/a.txt", {
      headers: { Host: "abc.net", Range: "bytes=50-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("serves the whole file when the range is unparseable", async () => {
    const res = await app().request("/a.txt", {
      headers: { Host: "abc.net", Range: "items=0-1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });
});

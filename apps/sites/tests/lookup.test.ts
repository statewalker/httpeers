import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { lookupFile } from "../src/lookup.js";

function store(files: Record<string, string>) {
  return new MemFilesApi({ initialFiles: files });
}

describe("lookupFile", () => {
  it("finds an exact file", async () => {
    const api = store({ "/abc.net/a.txt": "hi" });
    const r = await lookupFile(api, "abc.net", "/a.txt");
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.storagePath).toBe("/abc.net/a.txt");
      expect(r.kind).toBe("exact");
    }
  });

  it("finds /foo via /foo.html", async () => {
    const api = store({ "/abc.net/foo.html": "x" });
    const r = await lookupFile(api, "abc.net", "/foo");
    expect(r.found && r.kind).toBe("html-extension");
  });

  it("finds /foo via /foo/index.html and reports it as a directory index", async () => {
    const api = store({ "/abc.net/foo/index.html": "x" });
    const r = await lookupFile(api, "abc.net", "/foo");
    expect(r.found && r.kind).toBe("directory-index");
  });

  it("prefers the exact file over the .html and index candidates", async () => {
    const api = store({
      "/abc.net/foo": "exact",
      "/abc.net/foo.html": "html",
      "/abc.net/foo/index.html": "index",
    });
    const r = await lookupFile(api, "abc.net", "/foo");
    expect(r.found && r.storagePath).toBe("/abc.net/foo");
  });

  it("serves the root index", async () => {
    const api = store({ "/abc.net/index.html": "home" });
    const r = await lookupFile(api, "abc.net", "/");
    expect(r.found && r.storagePath).toBe("/abc.net/index.html");
  });

  it("does not find a file belonging to a different site", async () => {
    const api = store({ "/other.net/a.txt": "x" });
    expect((await lookupFile(api, "abc.net", "/a.txt")).found).toBe(false);
  });

  // read() returns an EMPTY ITERABLE for a missing file rather than throwing,
  // so without an explicit stats() check this would be a 200 with no body.
  it("reports not-found rather than an empty success", async () => {
    const api = store({ "/abc.net/index.html": "home" });
    expect((await lookupFile(api, "abc.net", "/missing")).found).toBe(false);
  });

  it("never serves the config directory", async () => {
    const api = store({ "/abc.net/.site/config.json": "{}" });
    expect((await lookupFile(api, "abc.net", "/.site/config.json")).found).toBe(false);
  });

  it("rejects traversal before touching storage", async () => {
    const api = store({ "/secret.txt": "x" });
    expect((await lookupFile(api, "abc.net", "/../secret.txt")).found).toBe(false);
  });

  it("does not mistake a directory for a file", async () => {
    const api = store({ "/abc.net/foo/bar.txt": "x" });
    // /foo exists as a directory but has no index; none of the candidates is a file.
    expect((await lookupFile(api, "abc.net", "/foo")).found).toBe(false);
  });
});

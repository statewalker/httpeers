import { describe, expect, it } from "vitest";
import { candidates, isConfigPath, normalizeRequestPath } from "../src/resolve.js";

describe("normalizeRequestPath", () => {
  it("passes a plain path through", () => {
    expect(normalizeRequestPath("/a/b.html")).toBe("/a/b.html");
  });

  it("percent-decodes", () => {
    expect(normalizeRequestPath("/a%20b.html")).toBe("/a b.html");
  });

  it("collapses repeated slashes", () => {
    expect(normalizeRequestPath("/a//b///c")).toBe("/a/b/c");
  });

  // Decoded FIRST, then checked -- otherwise %2e%2e%2f walks straight through.
  it("rejects traversal, encoded or not", () => {
    expect(normalizeRequestPath("/../etc")).toBeUndefined();
    expect(normalizeRequestPath("/a/../../etc")).toBeUndefined();
    expect(normalizeRequestPath("/%2e%2e/etc")).toBeUndefined();
  });

  it("rejects a malformed percent-encoding rather than throwing", () => {
    expect(normalizeRequestPath("/%ZZ")).toBeUndefined();
  });

  it("rejects a path that is not absolute", () => {
    expect(normalizeRequestPath("a/b")).toBeUndefined();
  });
});

describe("candidates", () => {
  it("maps the root to its index", () => {
    expect(candidates("/")).toEqual([{ path: "/index.html", kind: "directory-index" }]);
  });

  it("maps a trailing slash to that directory's index", () => {
    expect(candidates("/foo/")).toEqual([{ path: "/foo/index.html", kind: "directory-index" }]);
  });

  it("tries exact, then .html, then the directory index -- in that order", () => {
    expect(candidates("/foo")).toEqual([
      { path: "/foo", kind: "exact" },
      { path: "/foo.html", kind: "html-extension" },
      { path: "/foo/index.html", kind: "directory-index" },
    ]);
  });

  it("still offers the .html and index candidates for a path with an extension", () => {
    // /a.css.html is nonsense but harmless; special-casing extensions would
    // break legitimate files like /release-1.2 with no extension at all.
    expect(candidates("/a.css")[0]).toEqual({ path: "/a.css", kind: "exact" });
  });
});

describe("isConfigPath", () => {
  it("recognises the config directory at any depth", () => {
    expect(isConfigPath("/.site/config.json")).toBe(true);
    expect(isConfigPath("/a/.site/x")).toBe(true);
  });

  it("does not match other dotfiles, so /.well-known keeps working", () => {
    expect(isConfigPath("/.well-known/acme")).toBe(false);
    expect(isConfigPath("/site/config.json")).toBe(false);
    expect(isConfigPath("/x.site/y")).toBe(false);
  });
});

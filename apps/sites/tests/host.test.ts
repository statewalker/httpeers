import { describe, expect, it } from "vitest";
import { siteFromHost } from "../src/host.js";

describe("siteFromHost", () => {
  it("returns a plain hostname unchanged", () => {
    expect(siteFromHost("abc.httpeers.net")).toBe("abc.httpeers.net");
  });

  it("lowercases, because storage keys are case-sensitive and headers are not", () => {
    expect(siteFromHost("ABC.HttPeers.NET")).toBe("abc.httpeers.net");
  });

  it("strips a port", () => {
    expect(siteFromHost("abc.httpeers.net:443")).toBe("abc.httpeers.net");
  });

  it("strips a fully-qualified trailing dot", () => {
    expect(siteFromHost("abc.httpeers.net.")).toBe("abc.httpeers.net");
  });

  it("rejects an absent header", () => {
    expect(siteFromHost(undefined)).toBeUndefined();
  });

  // This header becomes a storage path, so anything path-shaped must not survive.
  it("rejects path traversal and separators", () => {
    expect(siteFromHost("../etc/passwd")).toBeUndefined();
    expect(siteFromHost("abc/def")).toBeUndefined();
    expect(siteFromHost("abc..net")).toBeUndefined();
  });

  it("rejects labels with leading or trailing hyphens", () => {
    expect(siteFromHost("-abc.net")).toBeUndefined();
    expect(siteFromHost("abc-.net")).toBeUndefined();
  });

  it("rejects an over-long name", () => {
    expect(siteFromHost(`${"a".repeat(254)}.net`)).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(siteFromHost("")).toBeUndefined();
  });
});

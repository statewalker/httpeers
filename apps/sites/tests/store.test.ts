import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { describe, expect, it } from "vitest";
import { createFilesApi } from "../src/store.js";

describe("createFilesApi", () => {
  it("builds a mem adapter", () => {
    expect(createFilesApi({ SITES_ADAPTER: "mem" })).toBeInstanceOf(MemFilesApi);
  });

  it("builds a node adapter rooted where told", () => {
    expect(createFilesApi({ SITES_ADAPTER: "node", SITES_ROOT: "/tmp/sites" })).toBeInstanceOf(
      NodeFilesApi,
    );
  });

  it("requires a root for the node adapter", () => {
    expect(() => createFilesApi({ SITES_ADAPTER: "node" })).toThrow(/SITES_ROOT/);
  });

  it("builds an s3 adapter when fully configured", () => {
    const api = createFilesApi({
      SITES_ADAPTER: "s3",
      S3_ENDPOINT: "http://rustfs:9000",
      S3_BUCKET: "sites",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(api).toBeDefined();
  });

  // Missing credentials must fail at startup, not on the first request:
  // the alternative is a container that reports healthy and 404s everything.
  it("names the missing variable rather than starting broken", () => {
    expect(() =>
      createFilesApi({ SITES_ADAPTER: "s3", S3_ENDPOINT: "http://rustfs:9000" }),
    ).toThrow(/S3_BUCKET/);
  });

  it("rejects an unknown adapter by name", () => {
    expect(() => createFilesApi({ SITES_ADAPTER: "carrier-pigeon" })).toThrow(/carrier-pigeon/);
  });
});

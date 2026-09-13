import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SITE_CONFIG, readSiteConfig } from "../src/site-config.js";

const CONFIG = "/abc.net/.site/config.json";

describe("readSiteConfig", () => {
  it("returns defaults when no config exists", async () => {
    const api = new MemFilesApi({ initialFiles: { "/abc.net/index.html": "x" } });
    expect(await readSiteConfig(api, "abc.net")).toEqual(DEFAULT_SITE_CONFIG);
  });

  it("reads spa, notFound and cacheControl", async () => {
    const api = new MemFilesApi({
      initialFiles: {
        [CONFIG]: JSON.stringify({
          spa: true,
          notFound: "/oops.html",
          cacheControl: "public, max-age=31536000, immutable",
        }),
      },
    });
    expect(await readSiteConfig(api, "abc.net")).toEqual({
      spa: true,
      notFound: "/oops.html",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  it("ignores unknown keys", async () => {
    const api = new MemFilesApi({
      initialFiles: { [CONFIG]: JSON.stringify({ spa: true, nonsense: 42 }) },
    });
    const config = await readSiteConfig(api, "abc.net");
    expect(config.spa).toBe(true);
    expect(config).not.toHaveProperty("nonsense");
  });

  it("ignores fields of the wrong type rather than trusting them", async () => {
    const api = new MemFilesApi({
      initialFiles: { [CONFIG]: JSON.stringify({ spa: "yes", notFound: 7 }) },
    });
    expect(await readSiteConfig(api, "abc.net")).toEqual(DEFAULT_SITE_CONFIG);
  });

  // A typo in a config file must not take a site offline, and every default
  // is the safe one -- but it must be loud, or it is undebuggable.
  it("falls back to defaults on malformed JSON, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MemFilesApi({ initialFiles: { [CONFIG]: "{ not json" } });
    expect(await readSiteConfig(api, "abc.net")).toEqual(DEFAULT_SITE_CONFIG);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("defaults to no-cache, because nothing here guarantees hashed filenames", () => {
    expect(DEFAULT_SITE_CONFIG.cacheControl).toBe("public, no-cache");
    expect(DEFAULT_SITE_CONFIG.spa).toBe(false);
  });
});

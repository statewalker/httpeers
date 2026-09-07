/**
 * The HTTP surface. Everything storage-shaped arrives through `FilesApi`, so
 * the whole app runs against an in-memory adapter with no I/O at all.
 */
import type { FileStats, FilesApi } from "@statewalker/webrun-files";
import { Hono } from "hono";
import { TtlCache } from "./cache.js";
import { contentTypeFor } from "./content-type.js";
import { siteFromHost } from "./host.js";
import { type LookupResult, lookupFile, statFile } from "./lookup.js";
import { readSiteConfig, type SiteConfig } from "./site-config.js";

export interface ServeOptions {
  files: FilesApi;
  /** Zero disables caching. Default 60_000. */
  cacheTtlMs?: number;
  /** Default 10_000. */
  cacheMax?: number;
}

/** Bridge `FilesApi`'s async iterable into a web `ReadableStream`. */
function toStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * A weak validator built from size and mtime.
 *
 * WEAK, AND NOT BY PREFERENCE. `FilesApi.stats()` exposes no content hash, so
 * a strong `ETag` would mean reading every byte of a file just to answer a
 * conditional request -- which is exactly the work the request is trying to
 * avoid. Omitted entirely when `size` is missing: a fabricated validator is
 * worse than none, because clients trust it.
 */
function etagFor(stats: FileStats): string | undefined {
  if (stats.size == null) return undefined;
  const mtime = stats.lastModified ?? 0;
  return `W/"${stats.size.toString(36)}-${mtime.toString(36)}"`;
}

export function createApp(options: ServeOptions): Hono {
  const { files } = options;
  const resolutions = new TtlCache<LookupResult>({
    ttlMs: options.cacheTtlMs ?? 60_000,
    max: options.cacheMax ?? 10_000,
  });
  const configs = new TtlCache<SiteConfig>({
    ttlMs: options.cacheTtlMs ?? 60_000,
    max: options.cacheMax ?? 10_000,
  });

  const app = new Hono();

  async function configFor(site: string): Promise<SiteConfig> {
    const hit = configs.get(site);
    if (hit != null) return hit;
    const config = await readSiteConfig(files, site);
    configs.set(site, config);
    return config;
  }

  async function resolve(site: string, path: string): Promise<LookupResult> {
    const key = `${site}${path}`;
    const hit = resolutions.get(key);
    if (hit != null) return hit;
    const result = await lookupFile(files, site, path);
    resolutions.set(key, result);
    return result;
  }

  app.all("*", async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.text("method not allowed", 405, { Allow: "GET, HEAD" });
    }

    const site = siteFromHost(c.req.header("host"));
    if (site == null) return c.text("bad request", 400);

    const url = new URL(c.req.url);
    const found = await resolve(site, url.pathname);
    const config = await configFor(site);

    if (found.found) {
      // The redirect that must not be skipped: serving a directory index at
      // the un-slashed URL breaks every relative link inside the document.
      if (found.kind === "directory-index" && !url.pathname.endsWith("/")) {
        return c.redirect(`${url.pathname}/${url.search}`, 301);
      }
      return respond(c, found.storagePath, found.stats, config, c.req.method === "HEAD");
    }

    // Not found. SPA first -- a client-side router needs the document, with 200.
    if (config.spa) {
      const shell = `/${site}/index.html`;
      const stats = await statFile(files, shell);
      if (stats != null) {
        return respond(c, shell, stats, config, c.req.method === "HEAD");
      }
    }

    const custom = `/${site}${config.notFound}`;
    const customStats = await statFile(files, custom);
    if (customStats != null) {
      return respond(c, custom, customStats, config, c.req.method === "HEAD", 404);
    }
    return c.text("not found", 404, { "Cache-Control": config.cacheControl });
  });

  async function respond(
    // biome-ignore lint/suspicious/noExplicitAny: Hono's context type is not exported in a usable form here
    c: any,
    storagePath: string,
    stats: FileStats,
    config: SiteConfig,
    headOnly: boolean,
    status = 200,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": contentTypeFor(storagePath),
      "Cache-Control": config.cacheControl,
    };
    if (stats.size != null) headers["Content-Length"] = String(stats.size);
    if (stats.lastModified != null) {
      headers["Last-Modified"] = new Date(stats.lastModified).toUTCString();
    }
    const etag = etagFor(stats);
    if (etag != null) headers.ETag = etag;
    headers["Accept-Ranges"] = "bytes";

    if (headOnly) return new Response(null, { status, headers });
    return new Response(toStream(files.read(storagePath)), { status, headers });
  }

  return app;
}

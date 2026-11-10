/**
 * The HTTP surface. Everything storage-shaped arrives through `FilesApi`, so
 * the whole app runs against an in-memory adapter with no I/O at all.
 */
import type { FileEntryStats, FilesApi } from "@statewalker/webrun-files";
import { Hono } from "hono";
import { TtlCache } from "./cache.js";
import { contentTypeFor } from "./content-type.js";
import { siteFromHost } from "./host.js";
import { type LookupResult, lookupFile, statFile } from "./lookup.js";
import { parseRange } from "./range.js";
import { cacheControlFor, readSiteConfig, type SiteConfig } from "./site-config.js";

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
function etagFor(stats: FileEntryStats, encoding?: string): string | undefined {
  if (stats.size == null) return undefined;
  const mtime = stats.lastModified ?? 0;
  return `W/"${stats.size.toString(36)}-${mtime.toString(36)}${encoding ? `-${encoding}` : ""}"`;
}

/** The encodings a site may publish beside a file, in order of preference. */
const ENCODINGS = [
  { name: "br", suffix: ".br" },
  { name: "gzip", suffix: ".gz" },
] as const;

/** The encodings `Accept-Encoding` allows (q > 0), by name. `*` allows any not named. */
function acceptedEncodings(header: string | undefined): Set<string> {
  const accepted = new Set<string>();
  if (header == null) return accepted;
  const refused = new Set<string>();
  let any = false;
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const ok = q == null || Number(q.slice(2)) > 0;
    if (token === "*") any = ok;
    else if (ok) accepted.add(token);
    else refused.add(token);
  }
  if (any) for (const e of ENCODINGS) if (!refused.has(e.name)) accepted.add(e.name);
  return accepted;
}

/** The value for `Access-Control-Allow-Origin`, or null when the site does not allow `origin`. */
function allowedOrigin(config: SiteConfig, origin: string | undefined): string | null {
  if (config.cors.includes("*")) return "*";
  return origin != null && config.cors.includes(origin) ? origin : null;
}

/**
 * Adds the CORS headers. A site that lists specific origins varies EVERY
 * response on `Origin`, allowed or not: a shared cache that stored the answer to
 * a navigation (no grant) must not hand it to a listed origin's fetch, which
 * would then fail until the copy expires. Headers are set in place: every
 * response here is built by this module or Hono, never taken from a fetch.
 */
function withCors(res: Response, config: SiteConfig, allowed: string | null): Response {
  if (config.cors.length > 0 && !config.cors.includes("*")) res.headers.append("Vary", "Origin");
  if (allowed != null) res.headers.set("Access-Control-Allow-Origin", allowed);
  return res;
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
  // A pre-compressed file beside a served one ("" when there is none), cached as resolutions are.
  const encoded = new TtlCache<FileEntryStats | "">({
    ttlMs: options.cacheTtlMs ?? 60_000,
    max: options.cacheMax ?? 10_000,
  });

  async function encodedStats(storagePath: string): Promise<FileEntryStats | undefined> {
    const hit = encoded.get(storagePath);
    if (hit != null) return hit === "" ? undefined : hit;
    const stats = await statFile(files, storagePath);
    encoded.set(storagePath, stats ?? "");
    return stats ?? undefined;
  }

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
    const method = c.req.method;
    const preflight = method === "OPTIONS" && c.req.header("access-control-request-method") != null;
    // Before the host and the config, as without CORS: other methods cost nothing.
    if (method !== "GET" && method !== "HEAD" && !preflight) {
      return c.text("method not allowed", 405, { Allow: "GET, HEAD" });
    }

    const site = siteFromHost(c.req.header("host"));
    if (site == null) return c.text("bad request", 400);
    const config = await configFor(site);
    const allowed = allowedOrigin(config, c.req.header("origin"));

    if (preflight) {
      // Answered only for an origin the site lists; refused as before otherwise.
      if (allowed == null) return c.text("method not allowed", 405, { Allow: "GET, HEAD" });
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Max-Age": "600",
      };
      const asked = c.req.header("access-control-request-headers");
      if (asked != null) headers["Access-Control-Allow-Headers"] = asked;
      return withCors(new Response(null, { status: 204, headers }), config, allowed);
    }
    return withCors(await serve(c, site, config), config, allowed);
  });

  // biome-ignore lint/suspicious/noExplicitAny: Hono's context type is not exported in a usable form here
  async function serve(c: any, site: string, config: SiteConfig): Promise<Response> {
    const url = new URL(c.req.url);
    const found = await resolve(site, url.pathname);

    if (found.found) {
      // The redirect that must not be skipped: serving a directory index at
      // the un-slashed URL breaks every relative link inside the document.
      if (found.kind === "directory-index" && !url.pathname.endsWith("/")) {
        return c.redirect(`${url.pathname}/${url.search}`, 301);
      }
      return respond(c, site, found.storagePath, found.stats, config, c.req.method === "HEAD");
    }

    // Not found. SPA first -- a client-side router needs the document, with 200.
    if (config.spa) {
      const shell = `/${site}/index.html`;
      const stats = await statFile(files, shell);
      if (stats != null) {
        return respond(c, site, shell, stats, config, c.req.method === "HEAD");
      }
    }

    const custom = `/${site}${config.notFound}`;
    const customStats = await statFile(files, custom);
    if (customStats != null) {
      return respond(c, site, custom, customStats, config, c.req.method === "HEAD", 404);
    }
    return c.text("not found", 404, { "Cache-Control": config.cacheControl });
  }

  async function respond(
    // biome-ignore lint/suspicious/noExplicitAny: Hono's context type is not exported in a usable form here
    c: any,
    site: string,
    storagePath: string,
    fileStats: FileEntryStats,
    config: SiteConfig,
    headOnly: boolean,
    status = 200,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": contentTypeFor(storagePath),
      "Cache-Control": cacheControlFor(config, storagePath.slice(site.length + 1)),
    };
    // A pre-compressed copy, when the site publishes one and the client takes it. Not for a
    // range request: a range addresses the bytes of the file, not of an encoding of it.
    let stats = fileStats;
    let bodyPath = storagePath;
    let encoding: string | undefined;
    if (config.precompressed) {
      headers.Vary = "Accept-Encoding";
      if (c.req.header("range") == null) {
        const accepted = acceptedEncodings(c.req.header("accept-encoding"));
        for (const e of ENCODINGS) {
          if (!accepted.has(e.name)) continue;
          const found = await encodedStats(storagePath + e.suffix);
          if (found == null) continue;
          stats = found;
          bodyPath = storagePath + e.suffix;
          encoding = e.name;
          headers["Content-Encoding"] = e.name;
          break;
        }
      }
    }
    if (stats.size != null) headers["Content-Length"] = String(stats.size);
    if (stats.lastModified != null) {
      headers["Last-Modified"] = new Date(stats.lastModified).toUTCString();
    }
    // Each encoding is its own representation, with its own validator.
    const etag = etagFor(stats, encoding);
    if (etag != null) headers.ETag = etag;
    headers["Accept-Ranges"] = "bytes";

    // RFC 9110: If-None-Match takes precedence; If-Modified-Since is only
    // consulted when no entity tag was supplied.
    const ifNoneMatch = c.req.header("if-none-match");
    const ifModifiedSince = c.req.header("if-modified-since");
    let notModified = false;
    if (ifNoneMatch != null && etag != null) {
      notModified = ifNoneMatch
        .split(",")
        .map((t: string) => t.trim())
        .some((t: string) => t === etag || t === "*");
    } else if (ifModifiedSince != null && stats.lastModified != null) {
      const since = Date.parse(ifModifiedSince);
      // Last-Modified has one-second resolution, so compare at that resolution
      // or a sub-second mtime makes every conditional request a miss.
      notModified = !Number.isNaN(since) && Math.floor(stats.lastModified / 1000) * 1000 <= since;
    }

    if (notModified) {
      // A 304 carries validators but never Content-Length or a body.
      const { "Content-Length": _dropped, ...revalidation } = headers;
      return new Response(null, { status: 304, headers: revalidation });
    }

    // Ranges are only meaningful when the size is known.
    if (stats.size != null && status === 200) {
      const range = parseRange(c.req.header("range"), stats.size);
      if (range === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${stats.size}` },
        });
      }
      if (range != null) {
        const length = range.end - range.start + 1;
        const partial = {
          ...headers,
          "Content-Length": String(length),
          "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
        };
        if (headOnly) return new Response(null, { status: 206, headers: partial });
        return new Response(toStream(files.read(storagePath, { start: range.start, length })), {
          status: 206,
          headers: partial,
        });
      }
    }

    if (headOnly) return new Response(null, { status, headers });
    return new Response(toStream(files.read(bodyPath)), { status, headers });
  }

  return app;
}

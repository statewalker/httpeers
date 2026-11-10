/**
 * A site's own options, from `.site/config.json`.
 *
 * This directory exists because routing no longer needs it: a site's storage
 * prefix IS its domain, so there is no mapping to record. What is left is the
 * behaviour the server cannot infer.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { statFile } from "./lookup.js";
import { SITE_CONFIG_DIR } from "./resolve.js";

export interface SiteConfig {
  /** Serve `/index.html` with 200 for unmatched paths, for client-side routing. */
  spa: boolean;
  /** The page to serve, with 404, when nothing matches and `spa` is false. */
  notFound: string;
  /** `Cache-Control` for every response from this site that no `cacheRules` entry matches. */
  cacheControl: string;
  /**
   * `Cache-Control` by path prefix, for a site whose build hashes some file names: e.g.
   * `{ "prefix": "/_astro/", "cacheControl": "public, max-age=31536000, immutable" }`. The
   * longest matching prefix wins; a path no rule matches gets `cacheControl`.
   */
  cacheRules: CacheRule[];
  /**
   * Serve `<file>.br` or `<file>.gz`, when the site publishes one beside a file, to clients that
   * accept that encoding (`Content-Encoding`, `Vary: Accept-Encoding`). Off by default: it costs
   * a lookup per encoding for each file served.
   */
  precompressed: boolean;
  /**
   * Origins whose pages may read this site from their scripts (CORS), or
   * `["*"]` for any. Empty, the default: none, and `OPTIONS` is refused.
   */
  cors: string[];
}

export interface CacheRule {
  /** A path prefix of the site, starting with "/" (`/_astro/`). */
  prefix: string;
  cacheControl: string;
}

/**
 * `no-cache` means "cache it, but revalidate every time" -- not "do not cache".
 *
 * WHY IT IS THE DEFAULT. Nothing here guarantees a site's assets are
 * content-hashed, so a long `max-age` would leave a re-published stylesheet
 * stale in browsers for that whole period with no way to flush it. Paired with
 * the weak `ETag`, repeat requests cost a 304 and nothing more. A site whose
 * build hashes filenames opts into real caching through this file.
 */
export const DEFAULT_SITE_CONFIG: SiteConfig = {
  spa: false,
  notFound: "/404.html",
  cacheControl: "public, no-cache",
  cacheRules: [],
  precompressed: false,
  cors: [],
};

/** The `Cache-Control` of a file the site serves at `path`: the longest matching rule's, or the site's. */
export function cacheControlFor(config: SiteConfig, path: string): string {
  let best: CacheRule | undefined;
  for (const rule of config.cacheRules)
    if (path.startsWith(rule.prefix) && (best == null || rule.prefix.length > best.prefix.length))
      best = rule;
  return best?.cacheControl ?? config.cacheControl;
}

/** Read a whole file as UTF-8. Only ever used for the config file. */
export async function readAllText(files: FilesApi, storagePath: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(storagePath)) chunks.push(chunk);
  return new TextDecoder().decode(
    chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

export async function readSiteConfig(files: FilesApi, site: string): Promise<SiteConfig> {
  const path = `/${site}/${SITE_CONFIG_DIR}/config.json`;
  if ((await statFile(files, path)) == null) return DEFAULT_SITE_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(await readAllText(files, path));
  } catch (err) {
    // Loud, but not fatal: a typo must not take a site offline, and every
    // default below is the safe one. Silent would be undebuggable.
    console.warn(
      `sites: ${site} has a malformed ${SITE_CONFIG_DIR}/config.json, ignoring it:`,
      (err as Error).message,
    );
    return DEFAULT_SITE_CONFIG;
  }

  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    spa: typeof o.spa === "boolean" ? o.spa : DEFAULT_SITE_CONFIG.spa,
    notFound: typeof o.notFound === "string" ? o.notFound : DEFAULT_SITE_CONFIG.notFound,
    cacheControl:
      typeof o.cacheControl === "string" ? o.cacheControl : DEFAULT_SITE_CONFIG.cacheControl,
    cacheRules: Array.isArray(o.cacheRules)
      ? cacheRules(site, o.cacheRules)
      : DEFAULT_SITE_CONFIG.cacheRules,
    precompressed:
      typeof o.precompressed === "boolean" ? o.precompressed : DEFAULT_SITE_CONFIG.precompressed,
    cors: Array.isArray(o.cors) ? corsOrigins(site, o.cors) : DEFAULT_SITE_CONFIG.cors,
  };
}

/** The well-formed entries of `cacheRules`; the others are dropped one by one, loudly. */
function cacheRules(site: string, entries: unknown[]): CacheRule[] {
  const rules: CacheRule[] = [];
  for (const entry of entries) {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (
      typeof e.prefix === "string" &&
      e.prefix.startsWith("/") &&
      typeof e.cacheControl === "string"
    )
      rules.push({ prefix: e.prefix, cacheControl: e.cacheControl });
    else
      console.warn(
        `sites: ${site} lists ${JSON.stringify(entry)} under cacheRules, which is no { prefix: "/…", cacheControl }; ignoring it`,
      );
  }
  return rules;
}

/**
 * The listed origins as browsers send them (`https://a.example`: lowercase, no
 * trailing slash, no path), so a listed `https://A.example/` still matches.
 * Entries that are no origin are dropped one by one, loudly, and so is `null`:
 * it is the origin of every sandboxed frame and `data:` or `file:` page.
 */
function corsOrigins(site: string, entries: unknown[]): string[] {
  const origins: string[] = [];
  for (const entry of entries) {
    const origin = entry === "*" ? "*" : originOf(entry);
    if (origin == null) {
      console.warn(
        `sites: ${site} lists ${JSON.stringify(entry)} under cors, which is no origin; ignoring it`,
      );
    } else if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

function originOf(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  try {
    const { origin } = new URL(entry);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

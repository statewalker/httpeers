/**
 * A site's own options, from `.site/config.json`.
 *
 * This directory exists because routing no longer needs it: a site's storage
 * prefix IS its domain, so there is no mapping to record. What is left is two
 * behaviours the server cannot infer.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { statFile } from "./lookup.js";
import { SITE_CONFIG_DIR } from "./resolve.js";

export interface SiteConfig {
  /** Serve `/index.html` with 200 for unmatched paths, for client-side routing. */
  spa: boolean;
  /** The page to serve, with 404, when nothing matches and `spa` is false. */
  notFound: string;
  /** `Cache-Control` for every response from this site. */
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
};

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
  };
}

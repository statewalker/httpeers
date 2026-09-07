/**
 * The container entrypoint. Everything environment-shaped lives here, so
 * `serve.ts` stays a function of its arguments and the tests never touch
 * `process.env`.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./serve.js";
import { createFilesApi } from "./store.js";

const port = Number(process.env.SITES_PORT ?? 3000);
const files = createFilesApi(process.env);

const app = createApp({
  files,
  cacheTtlMs:
    process.env.SITES_CACHE_TTL_MS != null ? Number(process.env.SITES_CACHE_TTL_MS) : undefined,
  cacheMax: process.env.SITES_CACHE_MAX != null ? Number(process.env.SITES_CACHE_MAX) : undefined,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sites: listening on ${info.port}, adapter ${process.env.SITES_ADAPTER ?? "s3"}`);
});

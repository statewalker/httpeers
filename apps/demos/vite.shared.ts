/**
 * What every demo page's Vite config needs, in one place.
 *
 * Biscuit needs nothing here: `httpeers-access` evaluates tokens and policy in
 * pure TypeScript (`@statewalker/webrun-biscuit`), so there is no `.wasm` to
 * serve, no entry to alias and no module to keep out of the optimizer.
 */

import { join } from "node:path";
import type { UserConfig } from "vite";

export function demoConfig(page: string): UserConfig {
  return {
    root: join("src", page),
    publicDir: join(process.cwd(), "public"),
    build: {
      outDir: join(process.cwd(), "dist", page),
      emptyOutDir: true,
      // NO ServiceWorker ENTRY. The worker is a ready-made IIFE the library
      // already ships (`webrun-http-browser/dist/sw-worker.js`, built for
      // `importScripts`), and it is COPIED into `public/` rather than rebuilt.
      //
      // Bundling it as an ESM entry produced a ZERO-BYTE `sw.js`: the source is
      // one side-effect-only import, the package is marked side-effect-free,
      // and the bundler correctly removed everything. A registered worker that
      // is an empty file fails in a way nothing reports -- the page registers,
      // activates, and then routes nothing.
      //
      // Copying also keeps the URL stable, which matters more here than
      // anywhere else: `mountEdge` registers the worker BY URL, and a hashed
      // filename would orphan the previous registration on every deploy.
    },
  };
}

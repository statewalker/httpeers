/**
 * What every demo page's Vite config needs, in one place.
 *
 * Biscuit needs nothing here: `httpeers-access` evaluates tokens and policy in
 * pure TypeScript (`@statewalker/webrun-biscuit`), so there is no `.wasm` to
 * serve, no entry to alias and no module to keep out of the optimizer.
 */

import { join } from "node:path";
import type { Plugin, UserConfig } from "vite";

/**
 * Drop emitted files that nothing in the output refers to.
 *
 * `webrun-http-browser`'s `dist/index.js` has default arguments of the form
 * `new URL("../public-relay/", import.meta.url)`. Vite resolves those at
 * TRANSFORM time, before tree-shaking removes the functions holding them, and
 * emits a copy of the library's whole 91 KB `index.js` that no page loads.
 * The app page imports the library's relay client (`session-frame.ts`), so it
 * would ship that copy. The same plugin guards `apps/session-shell`.
 */
function dropUnreferencedAssets(): Plugin {
  return {
    name: "demos:drop-unreferenced-assets",
    generateBundle(_options, bundle) {
      const texts = Object.values(bundle).map((file) =>
        file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "",
      );
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type !== "asset" || name.endsWith(".html")) continue;
        const base = name.slice(name.lastIndexOf("/") + 1);
        if (!texts.some((text) => text.includes(base))) delete bundle[name];
      }
    },
  };
}

export function demoConfig(page: string): UserConfig {
  return {
    plugins: [dropUnreferencedAssets()],
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

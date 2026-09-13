/**
 * What every demo page's Vite config needs, in one place.
 *
 * THE BISCUIT ALIASES ARE NOT OPTIONAL, and the reason is measured rather than
 * inherited (see `httpeers-browser-conformance/tests/biscuit-seam.test.ts`):
 *
 *   - biscuit-wasm's entry runs `__wbg_set_wasm(wasm)` where `wasm` is a
 *     `.wasm` import — an instantiated module under Node, a URL STRING under
 *     Vite. Left in place it loads whenever anything imports the package and
 *     arms the binding with a string. The page then dies outright on the first
 *     call, with no exception to read.
 *   - a pre-bundled copy would be a SECOND module instance, so the one the
 *     loader arms is not the one the library calls.
 *
 * Aliasing the entry to the binding module removes the first; excluding it
 * from the optimizer removes the second. `src/shared/biscuit.ts` then arms it
 * explicitly, once, before anything touches a token.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";

/**
 * biscuit-wasm's `module/` directory — where `biscuit_bg.js`, the wasm and the
 * snippets live.
 *
 * Its exports map is `{ "import": "./module/biscuit.js" }`: one condition, one
 * subpath, no wildcard. So the only file it will resolve is the very one we
 * must not load, and we use it purely to find the directory its siblings are
 * in. See the alias below for why loading it is the problem.
 */
function biscuitModuleDir(): string {
  // `import.meta.resolve` honours the `import` condition, which is the ONLY
  // thing that map exposes. Both CJS alternatives throw:
  // `require.resolve("@biscuit-auth/biscuit-wasm")` finds no `require`
  // condition, and even `.../package.json` is not a declared subpath.
  return dirname(fileURLToPath(import.meta.resolve("@biscuit-auth/biscuit-wasm")));
}

export const SNIPPET_IMPORT = "./snippets/biscuit-auth-314ca57174ae0e6d/inline0.js";

export function demoConfig(page: string): UserConfig {
  const biscuit = biscuitModuleDir();
  return {
    root: join("src", page),
    publicDir: join(process.cwd(), "public"),
    optimizeDeps: { exclude: ["@biscuit-auth/biscuit-wasm"] },
    resolve: {
      alias: [
        { find: /^@biscuit-auth\/biscuit-wasm$/, replacement: join(biscuit, "biscuit_bg.js") },
        { find: "#biscuit-snippet", replacement: join(biscuit, SNIPPET_IMPORT) },
      ],
    },
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

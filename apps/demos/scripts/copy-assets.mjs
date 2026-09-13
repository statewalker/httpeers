/**
 * Copy the two binary artefacts the pages serve but do not build.
 *
 * NEITHER IS CHECKED IN, deliberately. Both are outputs of packages in this
 * workspace, and a committed copy is a copy that goes stale silently -- the
 * exact failure mode where a source fix ships as an unchanged bundle.
 *
 *   - `biscuit_bg.wasm` is fetched at runtime by `src/shared/biscuit.ts`. It
 *     cannot be bundled: the loader instantiates it from bytes.
 *   - `sw.js` is `webrun-http-browser`'s ready-made IIFE worker. Bundling it as
 *     an ESM entry yields a ZERO-BYTE file -- one side-effect-only import from
 *     a side-effect-free package -- and a registered worker that is an empty
 *     file fails in a way nothing reports.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
mkdirSync(publicDir, { recursive: true });

// Resolved through the `import` condition: biscuit-wasm's exports map exposes
// nothing else, not even `./package.json`.
const biscuitDir = dirname(fileURLToPath(import.meta.resolve("@biscuit-auth/biscuit-wasm")));
copyFileSync(join(biscuitDir, "biscuit_bg.wasm"), join(publicDir, "biscuit_bg.wasm"));

const swWorker = fileURLToPath(import.meta.resolve("@statewalker/webrun-http-browser/sw-worker"));
copyFileSync(swWorker, join(publicDir, "sw.js"));

console.log("copied biscuit_bg.wasm and sw.js into public/");

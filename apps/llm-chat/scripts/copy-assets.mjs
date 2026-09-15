/**
 * Copy the one artefact `mesh.html` serves but does not build: `public/sw.js`.
 *
 * NOT CHECKED IN, deliberately (as in `apps/demos/scripts/copy-assets.mjs`): a committed copy of a
 * package's output goes stale silently. It is `webrun-http-browser`'s ready-made IIFE worker;
 * bundling it as an ESM entry yields a zero-byte file, and a registered worker that is an empty
 * file routes nothing without reporting why.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
mkdirSync(publicDir, { recursive: true });

const swWorker = fileURLToPath(import.meta.resolve("@statewalker/webrun-http-browser/sw-worker"));
copyFileSync(swWorker, join(publicDir, "sw.js"));

console.log("copied sw.js into public/");

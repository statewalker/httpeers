/**
 * Copy the one artefact the pages serve but do not build.
 *
 * NOT CHECKED IN, deliberately. It is an output of a package in this
 * workspace, and a committed copy is a copy that goes stale silently -- the
 * exact failure mode where a source fix ships as an unchanged bundle.
 *
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

const swWorker = fileURLToPath(import.meta.resolve("@statewalker/webrun-http-browser/sw-worker"));
copyFileSync(swWorker, join(publicDir, "sw.js"));

console.log("copied sw.js into public/");

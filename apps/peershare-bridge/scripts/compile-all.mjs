#!/usr/bin/env node
/**
 * `node scripts/compile-all.mjs [outDir] [target…]`: one self-contained Bridge
 * per platform (all of TARGETS when none is named), cross-compiled by Bun.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { TARGETS } from "./targets.js";

const [outDir = "dist", ...only] = process.argv.slice(2);
const main = resolve(import.meta.dirname, "../src/main.ts");
mkdirSync(outDir, { recursive: true });
for (const { target, file } of TARGETS.filter(
  (t) => only.length === 0 || only.includes(t.target),
)) {
  execFileSync(
    "bun",
    ["build", "--compile", "--minify", `--target=${target}`, main, "--outfile", join(outDir, file)],
    { stdio: "inherit" },
  );
}

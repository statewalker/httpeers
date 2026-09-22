/**
 * Ensures `packages/httpeers-qr`'s two PRODUCTION dependencies
 * (`qrcode-generator`, `jsqr`) are resolvable from `/work/node_modules`
 * before `bin/invite.ts` imports `encode.ts`/`decode.ts` -- which, being
 * static `import`s, are resolved by Node before any of `invite.ts`'s own
 * code runs. That is why this is a SEPARATE process, run first: if the
 * dependency were missing when `invite.ts` itself started loading, it would
 * already be too late to install it.
 *
 * VERSIONS ARE DERIVED, NEVER DUPLICATED. An earlier version of this script
 * hardcoded `qrcode-generator@2.0.4 jsqr@1.4.0` -- correct on the day it was
 * written, and silently wrong the moment `packages/httpeers-qr/package.json`
 * bumps either one, since nothing would re-check the pair. This reads
 * `dependencies.jsqr` and `dependencies["qrcode-generator"]` from that file
 * directly and installs exactly what it declares (the declared RANGE, e.g.
 * `^1.4.0`, passed straight to `npm install` -- not stripped to an exact
 * version -- so resolution follows the same semantics the package itself
 * asked for). There is exactly one place these versions are decided, and it
 * is not here.
 *
 * WHY /work/node_modules SPECIFICALLY. Node's ESM resolver only walks UP
 * the directory tree from the importing file looking for `node_modules` --
 * never sideways, and NOT via `NODE_PATH` (verified experimentally: that
 * variable is a CommonJS-`require`-only mechanism and is silently ignored
 * for `import`). The nearest ancestor of `packages/httpeers-qr/src/*.ts`
 * this script may write into is the repo root, `/work` --
 * `packages/httpeers-qr`'s own `node_modules` is pnpm-managed already (and
 * in a genuinely bare clone would not exist at all) and is not this
 * script's to touch.
 *
 * A NEUTRAL SCRATCH DIRECTORY FOR THE ACTUAL `npm install`, because `/work`
 * has its own `package.json` using pnpm's `"catalog:"` protocol, which
 * plain npm does not understand and refuses outright the moment it is
 * anywhere on npm's project-detection path (verified: `npm install
 * --prefix /work ...` fails with `EUNSUPPORTEDPROTOCOL` even for packages
 * that have nothing to do with the catalog entries).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const REPO_ROOT = "/work";
const QR_PACKAGE_JSON = `${REPO_ROOT}/packages/httpeers-qr/package.json`;
const TARGET_NODE_MODULES = `${REPO_ROOT}/node_modules`;
const SCRATCH_DIR = "/tmp/qr-deps";
const DEPENDENCY_NAMES = ["jsqr", "qrcode-generator"] as const;

interface PackageJson {
  dependencies?: Record<string, string>;
}

interface DepSpec {
  name: (typeof DEPENDENCY_NAMES)[number];
  range: string;
}

/** Reads the two dependency ranges this script installs, straight from `packages/httpeers-qr`'s own `package.json` -- fails loudly, naming the file and the missing key, rather than falling back to anything hardcoded. */
function derivedSpecs(): DepSpec[] {
  let raw: string;
  try {
    raw = readFileSync(QR_PACKAGE_JSON, "utf8");
  } catch (err) {
    throw new Error(`qr-deps: cannot read ${QR_PACKAGE_JSON}: ${(err as Error).message}`);
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`qr-deps: ${QR_PACKAGE_JSON} is not valid JSON: ${(err as Error).message}`);
  }

  const deps = pkg.dependencies ?? {};
  return DEPENDENCY_NAMES.map((name) => {
    const range = deps[name];
    if (!range) {
      throw new Error(
        `qr-deps: ${QR_PACKAGE_JSON} has no dependencies.${JSON.stringify(name)} -- refusing to guess a version`,
      );
    }
    return { name, range };
  });
}

function main(): void {
  const specs = derivedSpecs();
  const missing = specs.filter((spec) => !existsSync(`${TARGET_NODE_MODULES}/${spec.name}`));
  if (missing.length === 0) {
    console.log(
      `qr-deps: already installed (${specs.map((s) => `${s.name}@${s.range}`).join(", ")})`,
    );
    return;
  }

  mkdirSync(SCRATCH_DIR, { recursive: true });
  const packageArgs = specs.map((spec) => `${spec.name}@${spec.range}`);
  console.log(`qr-deps: npm install --prefix ${SCRATCH_DIR} ${packageArgs.join(" ")}`);
  // execFileSync, not exec/execSync -- no shell involved, so a range like
  // "^1.4.0" needs no quoting and cannot be misread as a shell operator.
  execFileSync(
    "npm",
    ["install", "--prefix", SCRATCH_DIR, "--no-audit", "--no-fund", "--silent", ...packageArgs],
    { stdio: "inherit" },
  );

  mkdirSync(TARGET_NODE_MODULES, { recursive: true });
  for (const spec of specs) {
    cpSync(`${SCRATCH_DIR}/node_modules/${spec.name}`, `${TARGET_NODE_MODULES}/${spec.name}`, {
      recursive: true,
    });
  }
  console.log(`qr-deps: installed ${packageArgs.join(", ")} into ${TARGET_NODE_MODULES}`);
}

main();

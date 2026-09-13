/**
 * Every entry point of every package, resolved the way a dependent resolves
 * it.
 *
 * WHAT THIS CATCHES THAT NOTHING ELSE DOES. A package's own `tsc --noEmit`
 * compiles its source with its own settings and proves nothing about the
 * `exports` map. The per-package `consumer.test.ts` files do test that — but
 * only three packages have one, and every one of them tested only `.`. A
 * SUBPATH (`./node`, `./browser`, `./issuer`, `./engine`) resolves through its
 * own export condition and, unlike the root, has no legacy top-level `types`
 * field to fall back to. So a typo in one is invisible everywhere until
 * somebody installs the published package and cannot import it.
 *
 * This enumerates the maps rather than listing entries by hand, so an entry
 * added to any package is covered the day it is added and nobody has to
 * remember this file exists.
 *
 * `import * as ns` ON PURPOSE. This asks one question — does the entry
 * RESOLVE, with reachable types — and asking it namespace-wide means the check
 * does not go stale as exports come and go. Whether the right SYMBOLS are
 * exported is `consumers.ts`'s job, next door, and it names them.
 *
 * ONLY THE `NodeNext` CONFIG. `moduleResolution: "Bundler"` falls back to the
 * legacy `types` field when a condition does not resolve, so it cannot see the
 * breakage this exists to find; a row that cannot fail is worse than no row.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(PKG, "..");

function findUp(relative: string): string {
  let dir = PKG;
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`exports test: could not find ${relative} above ${PKG}`);
}

const TSC = findUp("node_modules/.bin/tsc");
const TYPES = findUp("node_modules/@types");

interface Entry {
  /** Directory name under `packages/`. */
  dir: string;
  /** The published package name. */
  name: string;
  /** `.` or `./something`. */
  subpath: string;
}

/** Every publishable entry of every sibling, read off the `exports` maps themselves. */
function entries(): Entry[] {
  const found: Entry[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, unknown>;
    };
    // This package itself is private and has no exports map; so is anything
    // else that is never published.
    if (pkg.private === true || pkg.name == null || pkg.exports == null) continue;
    for (const subpath of Object.keys(pkg.exports)) {
      found.push({ dir, name: pkg.name, subpath });
    }
  }
  return found;
}

const ENTRIES = entries();

function compile(entry: Entry): { ok: boolean; output: string } {
  const specifier = entry.subpath === "." ? entry.name : `${entry.name}${entry.subpath.slice(1)}`;
  const dir = mkdtempSync(join(tmpdir(), "httpeers-exports-"));
  try {
    mkdirSync(join(dir, "node_modules/@statewalker"), { recursive: true });
    // EVERY sibling is linked, not just the one under test: these packages
    // depend on each other, and a `.d.ts` that re-exports a type from a
    // sibling cannot be checked without it.
    for (const sibling of readdirSync(PACKAGES)) {
      const manifest = join(PACKAGES, sibling, "package.json");
      if (!existsSync(manifest)) continue;
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
      if (name == null) continue;
      symlinkSync(join(PACKAGES, sibling), join(dir, "node_modules", name), "dir");
    }
    symlinkSync(TYPES, join(dir, "node_modules/@types"), "dir");
    writeFileSync(
      join(dir, "use.ts"),
      `import * as ns from "${specifier}";\nexport const entry: unknown = ns;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          strict: true,
          noEmit: true,
          // About the exports map, not upstream `.d.ts` hygiene — and what a
          // real consumer has. Resolution failures are not skipped by it,
          // which is the whole of what this test asks.
          skipLibCheck: true,
          types: ["node"],
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["use.ts"],
      }),
    );
    execFileSync(TSC, ["--project", join(dir, "tsconfig.json")], { stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("every published entry point resolves for a consumer", () => {
  it("found the packages and their entries at all", () => {
    // GUARDS THE GUARD. An enumeration that finds nothing makes the whole
    // suite pass while measuring nothing.
    expect(ENTRIES.length).toBeGreaterThan(8);
    const names = ENTRIES.map((e) => `${e.name}${e.subpath.slice(1)}`);
    // The two subpaths added most recently, named explicitly so that a change
    // which silently drops an entry from a map fails HERE rather than by this
    // suite quietly getting shorter.
    expect(names).toContain("@statewalker/httpeers-member/browser");
    expect(names).toContain("@statewalker/httpeers-qr/browser");
  });

  for (const entry of ENTRIES) {
    const specifier = entry.subpath === "." ? entry.name : `${entry.name}${entry.subpath.slice(1)}`;
    it(`${specifier}`, () => {
      expect(
        existsSync(join(PACKAGES, entry.dir, "dist")),
        `${entry.dir}/dist is missing — run a build first (turbo build, or pnpm -r run build)`,
      ).toBe(true);
      const { ok, output } = compile(entry);
      expect(output).toBe("");
      expect(ok).toBe(true);
    }, 120_000);
  }
});

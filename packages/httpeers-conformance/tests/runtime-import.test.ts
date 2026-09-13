/**
 * Every non-browser entry point, actually IMPORTED — not type-checked.
 *
 * WHY THIS EXISTS, AND WHAT IT CAUGHT. `exports.test.ts` next door compiles
 * `import * as ns from "<entry>"` against every entry and proves the map
 * resolves and the types are reachable. It does not run anything. So
 * `@statewalker/httpeers-member/node` — a published entry point — sat green
 * through 637 tests while being **impossible to import**:
 *
 *     Cannot find module '../../../build/Release/node_datachannel.node'
 *
 * `nodePlatform` reaches `@libp2p/webrtc`, which needs `node-datachannel`, a
 * native module whose `install` script pnpm 10 blocks unless the package is
 * named in `onlyBuiltDependencies`. It was not, so the prebuild was never
 * fetched. Nothing type-checked could ever have seen this: a `.d.ts` is
 * perfectly happy about a binary that does not exist.
 *
 * A compile check and a runtime check are different claims and the gap between
 * them is where this lived.
 *
 * BROWSER ENTRIES ARE EXCLUDED, AND ONLY THOSE. `./browser` exists to touch
 * things Node has not got — a camera, IndexedDB, a ServiceWorker adapter — so
 * requiring it to import here would be requiring it not to do its job. Every
 * OTHER entry is claimed to be isomorphic, and this is that claim under test
 * rather than in a comment.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(PKG, "..");

interface Entry {
  dir: string;
  name: string;
  subpath: string;
  /** The built file this entry resolves to, so the import needs no package resolution of its own. */
  file: string;
}

/** Every publishable, non-browser entry, read off the `exports` maps themselves. */
function entries(): Entry[] {
  const found: Entry[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, { import?: string }>;
    };
    if (pkg.private === true || pkg.name == null || pkg.exports == null) continue;
    for (const [subpath, condition] of Object.entries(pkg.exports)) {
      // The one exclusion, and it is by NAME rather than by guessing from the
      // file's contents — a browser entry that stopped being browser-only
      // should be renamed, not silently promoted into this suite.
      if (subpath === "./browser") continue;
      const rel = condition.import;
      if (rel == null) continue;
      found.push({ dir, name: pkg.name, subpath, file: join(PACKAGES, dir, rel) });
    }
  }
  return found;
}

const ENTRIES = entries();

describe("every isomorphic entry point imports under Node", () => {
  it("found the entries at all", () => {
    // GUARDS THE GUARD. An enumeration that finds nothing passes while
    // measuring nothing.
    expect(ENTRIES.length).toBeGreaterThan(6);
    const names = ENTRIES.map((e) => `${e.name}${e.subpath.slice(1)}`);
    expect(names).toContain("@statewalker/httpeers-member/node");
    // And the exclusion really excluded something, or the rule above is dead
    // code that would not notice a browser entry appearing in this list.
    expect(names).not.toContain("@statewalker/httpeers-member/browser");
  });

  for (const entry of ENTRIES) {
    const specifier = entry.subpath === "." ? entry.name : `${entry.name}${entry.subpath.slice(1)}`;
    it(`${specifier}`, async () => {
      expect(
        existsSync(entry.file),
        `${entry.file} is missing — run a build first (turbo build)`,
      ).toBe(true);
      // Imported by FILE URL, so this measures the module graph and not the
      // resolver; `exports.test.ts` is what measures the resolver.
      const ns = (await import(pathToFileURL(entry.file).href)) as Record<string, unknown>;
      // An entry that imports but exports nothing is a build that produced an
      // empty file, which is its own kind of broken.
      expect(Object.keys(ns).length).toBeGreaterThan(0);
    }, 60_000);
  }
});

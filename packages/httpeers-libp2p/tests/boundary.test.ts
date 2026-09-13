/**
 * The boundary, inverted: libp2p is allowed here and nowhere else.
 *
 * This package exists SO THAT the others can be free of it. That makes its own
 * rule the opposite one — libp2p is the point — but the isomorphism constraint
 * does not go away: the root export must still run in a page. So `node:`
 * builtins and DOM-only globals stay forbidden, and anything platform-bound
 * (tcp, the filesystem, IndexedDB) belongs in a `./node` or `./browser`
 * subpath rather than here.
 *
 * The prototype got this wrong in a way worth naming: its node factory
 * hard-coded `@libp2p/tcp`, so importing the transport module at all pulled a
 * Node-only transport into a browser bundle.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Anything that pins this package to one runtime. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["a node: builtin", /from\s+["']node:/],
  // Node-only transports and stores belong in `./node`, not the root.
  ["@libp2p/tcp", /from\s+["']@libp2p\/tcp["']/],
  // Access is a sibling, not a dependency: the graph runs core -> access and
  // core -> libp2p, and the two must never point at each other.
  ["httpeers-access", /from\s+["']@statewalker\/httpeers-access/],
  ["biscuit-wasm", /from\s+["']@biscuit-auth\//],
];

/**
 * DOM-ONLY globals.
 *
 * `Request`, `Response`, `Headers`, `URL`, `AbortController` and `AbortSignal`
 * are deliberately absent from this list: they are WinterCG, present in Node,
 * Deno, Bun, browsers and workers alike, and this package is built on them.
 * Confusing "browser API" with "DOM API" is what would make this list wrong.
 */
const DOM_ONLY = /\b(document|window|navigator|localStorage|sessionStorage)\b/;

/**
 * The PLATFORM entry points, listed by name.
 *
 * `./node` exists to hold `tcp()` and `./browser` to hold WebRTC; the rule
 * they are exempt from is the rule they exist to break. Listing them rather
 * than pattern-matching is the point — a new platform file has to be added
 * here deliberately, which is a line in a diff somebody can argue with, and
 * the alternative (exempting anything matching `*-node.ts`, say) lets a file
 * become platform-bound by being renamed.
 */
const PLATFORM_ENTRIES = new Set(["node.ts", "browser.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Strip comments: they legitimately discuss browsers, and a false positive here teaches people to weaken the test. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("the isomorphism boundary", () => {
  const files = sources(SRC);
  const named = files.map((f) => f.slice(SRC.length + 1));

  it("finds the source files at all", () => {
    // GUARDS THE GUARD. A scan that matches nothing makes every check below
    // pass while measuring nothing — the shape of vacuous test that is worse
    // than no test, because it reports safety.
    expect(files.length).toBeGreaterThan(1);
    expect(named).toContain("index.ts");
  });

  it("every platform entry named here exists, and every one that exists is named", () => {
    // Guards the exemption itself. A name left in this list after the file is
    // gone silently widens it for a future file of the same name; a platform
    // file that is not in the list should be failing the checks below, and if
    // it is not, something else is wrong.
    const platform = named.filter((n) => PLATFORM_ENTRIES.has(n));
    expect(platform.sort()).toEqual([...PLATFORM_ENTRIES].filter((n) => named.includes(n)).sort());
  });

  for (const file of files) {
    const name = file.slice(SRC.length + 1);
    it.skipIf(PLATFORM_ENTRIES.has(name))(`${name} imports no platform`, () => {
      const code = codeOf(file);
      for (const [what, pattern] of FORBIDDEN) {
        expect(code, `${name} imports ${what}`).not.toMatch(pattern);
      }
    });

    it(`${name} touches no DOM-only global`, () => {
      expect(codeOf(file), name).not.toMatch(DOM_ONLY);
    });
  }

  it("does not depend on httpeers-access", () => {
    // The boundary is a package.json claim too. A dependency appearing here is
    // a design decision, and should fail until somebody makes it deliberately.
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@statewalker/httpeers-access");

    // `@libp2p/tcp` IS a dependency, and should be: `./node` imports it, so
    // it is a real runtime requirement of that entry point. The invariant
    // worth asserting is not "tcp is absent from the manifest" — an earlier
    // version of this test claimed that and was simply wrong once `./node`
    // existed — but that nothing in the ROOT graph imports it, which the
    // per-file checks above enforce. A browser consumer installs the package
    // and never pulls tcp into a bundle, because nothing it imports reaches it.
    expect(Object.keys(pkg.dependencies ?? {})).toContain("@libp2p/tcp");
  });
});

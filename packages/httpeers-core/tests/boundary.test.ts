/**
 * The package's central claim, as a test rather than a comment.
 *
 * The package this one is extracted from states exactly this rule in a comment
 * and names the command that proves it:
 *
 *   "THE ONLY FILE IN THIS PACKAGE THAT IMPORTS libp2p — verify with
 *    `grep -rlE "^import.*libp2p" src/`; it must list only this file."
 *
 * That grep has been failing for some time. A second file started importing
 * `@libp2p/crypto`, `@libp2p/interface` and `@libp2p/peer-id`, recorded a
 * DIFFERENT invariant of its own a few lines away ("exactly two entries"), and
 * nobody reconciled the two — in the one package whose entire claim is a
 * boundary. An invariant nobody runs is a wish.
 *
 * So the rule is red-or-green here, and the guard has a guard: if the file
 * scan ever matches nothing, every check below would pass vacuously, which is
 * the failure mode that makes a test worse than no test.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Anything that pins this package to one runtime. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["a node: builtin", /from\s+["']node:/],
  ["libp2p", /from\s+["']libp2p["']/],
  ["@libp2p/*", /from\s+["']@libp2p\//],
  ["@chainsafe/*", /from\s+["']@chainsafe\//],
  ["@multiformats/*", /from\s+["']@multiformats\//],
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
    expect(files.length).toBeGreaterThan(5);
    expect(named).toContain("index.ts");
  });

  for (const file of files) {
    const name = file.slice(SRC.length + 1);
    it(`${name} imports no platform`, () => {
      const code = codeOf(file);
      for (const [what, pattern] of FORBIDDEN) {
        expect(code, `${name} imports ${what}`).not.toMatch(pattern);
      }
    });

    it(`${name} touches no DOM-only global`, () => {
      expect(codeOf(file), name).not.toMatch(DOM_ONLY);
    });
  }

  it("declares no runtime dependencies", () => {
    // The boundary is a package.json claim too. A dependency appearing here is
    // a design decision, and should fail until somebody makes it deliberately.
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

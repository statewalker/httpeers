/**
 * The boundary, inverted where it must be and kept where it matters.
 *
 * This package is ALLOWED WebAssembly — Biscuit is its whole job — and it is
 * allowed `multiformats`, which is how a peerId's own public key is recovered
 * without libp2p. What it may not have is the thing the extraction exists to
 * cut: `libp2p` and `@libp2p/*` must not appear in `src/`, or verification
 * drags a transport stack into every consumer that only wanted to check a
 * token.
 *
 * `tests/` is deliberately NOT scanned. One test file imports libp2p on
 * purpose — agreeing with libp2p is the claim `selfCertifyingKeys` makes, and
 * the only honest way to check it is against libp2p itself.
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
  // `@multiformats/*` (multiaddr) is a transport concern and stays out;
  // `multiformats` (no @) is the codec library and is allowed — see the
  // dependency assertion below, which pins exactly which.
  ["@multiformats/*", /from\s+["']@multiformats\//],
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
    expect(files.length).toBeGreaterThan(3);
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

  it("declares only the three dependencies it is allowed", () => {
    // The boundary is a package.json claim too. A dependency appearing here is
    // a design decision, and should fail until somebody makes it deliberately.
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@biscuit-auth/biscuit-wasm",
      "@statewalker/httpeers-core",
      "multiformats",
    ]);
    // The point of the package, as a dependency claim: no libp2p, at any
    // version, under any name.
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => d.includes("libp2p"))).toEqual([]);
  });
});

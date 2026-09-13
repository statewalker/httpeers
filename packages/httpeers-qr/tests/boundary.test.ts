/**
 * The isomorphism boundary, measured by REACHABILITY from the root entry —
 * the same shape `httpeers-member` carries, and for the same reason: the rule
 * is not "these files may be platform-bound", it is "nothing a root import
 * pulls in may be".
 *
 * `./browser.ts` scans from a camera, so it names `document` and imports
 * `html5-qrcode`. That is its whole purpose, and a rule that forbade it there
 * would forbid the file. What the rule actually protects is `./index.ts`: the
 * day somebody re-exports the camera from the root, a server rendering an
 * invitation and a worker decoding one both break, and this test says so.
 *
 * ONE OTHER DIFFERENCE from core's. This package legitimately has runtime
 * dependencies, so the dependency check is an ALLOW-LIST rather than "none".
 * Both entries are pure computation over data — `qrcode-generator` builds a
 * module matrix, `jsqr` reads one out of pixels — and neither reaches for a
 * platform. A third appearing there is a design decision and should fail until
 * somebody makes it. `html5-qrcode` is an optional PEER dependency, which is
 * how the camera stays out of a consumer that only encodes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

const ROOT_ENTRY = "index.ts";
const PLATFORM_ENTRIES = ["browser.ts"];

/** Anything that pins this package to one runtime. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["a node: builtin", /from\s+["']node:/],
  ["html5-qrcode", /from\s+["']html5-qrcode["']/],
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

/** Strip comments: they legitimately discuss browsers, and a false positive here teaches people to weaken the test. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** The `./x.js` specifiers a file imports or re-exports, resolved to `./x.ts`. */
function localImports(file: string): string[] {
  const out: string[] = [];
  for (const m of codeOf(file).matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)) {
    const candidate = resolve(dirname(file), (m[1] as string).replace(/\.js$/, ".ts"));
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

/** Everything reachable from `entry`, `entry` included. */
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...localImports(file));
  }
  return seen;
}

const rootClosure = closureOf(ROOT_ENTRY);
const named = (file: string): string => file.slice(SRC.length + 1);

describe("the isomorphism boundary", () => {
  it("finds the root entry and follows it somewhere", () => {
    // GUARDS THE GUARD. A closure that is just `index.ts` makes every check
    // below pass while measuring nothing — the shape of vacuous test that is
    // worse than no test, because it reports safety.
    expect(rootClosure.size).toBeGreaterThan(2);
    expect([...rootClosure].map(named)).toContain("decode.ts");
  });

  for (const file of [...rootClosure].sort()) {
    const name = named(file);
    it(`${name} — reachable from the root — imports no platform`, () => {
      const code = codeOf(file);
      for (const [what, pattern] of FORBIDDEN) {
        expect(code, `${name} imports ${what}`).not.toMatch(pattern);
      }
    });

    it(`${name} — reachable from the root — touches no DOM-only global`, () => {
      expect(codeOf(file), name).not.toMatch(DOM_ONLY);
    });
  }

  it("the camera really is unreachable from the root", () => {
    // The other half of the claim, and the one that would actually break a
    // consumer: `./browser.ts` must exist AND stay behind its own entry.
    for (const entry of PLATFORM_ENTRIES) {
      expect(existsSync(join(SRC, entry)), `${entry} exists`).toBe(true);
      expect([...rootClosure].map(named), `${entry} is reachable from index.ts`).not.toContain(
        entry,
      );
    }
  });

  it("declares only the two pure dependencies it is allowed", () => {
    // The boundary is a package.json claim too. A dependency appearing here is
    // a design decision, and should fail until somebody makes it deliberately.
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["jsqr", "qrcode-generator"]);
    // The camera library is a peer, and an OPTIONAL one — a consumer that only
    // encodes must not be made to install it.
    const full = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(Object.keys(full.peerDependencies ?? {})).toContain("html5-qrcode");
    expect(full.peerDependenciesMeta?.["html5-qrcode"]?.optional).toBe(true);
  });
});

/**
 * The isomorphism boundary, measured by REACHABILITY rather than by filename.
 *
 * A member is the package that runs in BOTH a Node process and a page — rung
 * 01's whole claim — so the ROOT entry (`./index.ts`) must reach neither
 * platform. `./node.ts` holds `tcp()`; `./browser.ts` holds IndexedDB, the
 * ServiceWorker edge and WebRTC.
 *
 * WHY THIS TEST CHANGED SHAPE. It used to exempt a hard-coded list of
 * FILENAMES, which answered the wrong question. The rule is not "these two
 * files may be platform-bound"; it is "nothing a root import pulls in may be".
 * Under the old shape, `edge.ts` — browser-only by construction, it imports a
 * ServiceWorker adapter — was neither exempt nor allowed to exist, and the
 * only ways out were to weaken the rule or to pretend the file was
 * isomorphic. Under this shape it is simply not reachable from `index.ts`,
 * which is both true and the thing that actually matters. The day somebody
 * adds `export * from "./edge.js"` to the root, this test fails and names the
 * import chain that did it.
 *
 * The exempt set is therefore the two PLATFORM ROOTS and everything only they
 * reach — computed, not listed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** The three entry points `package.json` publishes, as source files. */
const ROOT_ENTRY = "index.ts";
const PLATFORM_ENTRIES = ["node.ts", "browser.ts"];

/** Anything that pins a module to one runtime. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["a node: builtin", /from\s+["']node:/],
  ["@libp2p/tcp", /from\s+["']@libp2p\/tcp["']/],
  // Its Node build loads a native module (`node_datachannel.node`), so this
  // is not merely browser-flavoured: importing it breaks a Node member.
  ["@libp2p/webrtc", /from\s+["']@libp2p\/webrtc["']/],
  ["idb-keyval", /from\s+["']idb-keyval["']/],
  ["a ServiceWorker adapter", /from\s+["']@statewalker\/webrun-http-browser/],
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
const DOM_ONLY = /\b(document|window|navigator|localStorage|sessionStorage|indexedDB)\b/;

/** Strip comments: they legitimately discuss browsers, and a false positive here teaches people to weaken the test. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** The `./x.js` specifiers a file imports or re-exports, resolved to `./x.ts`. */
function localImports(file: string): string[] {
  const code = codeOf(file);
  const out: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)) {
    const spec = m[1] as string;
    const candidate = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
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
    // worse than no test, because it reports safety. A member's root reaches
    // the lifecycle, the edge dispatch, the join blob and more.
    expect(rootClosure.size).toBeGreaterThan(5);
    expect([...rootClosure].map(named)).toContain("start-member.ts");
  });

  it("every platform entry this test names exists", () => {
    for (const entry of PLATFORM_ENTRIES) expect(existsSync(join(SRC, entry))).toBe(true);
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

  it("the platform-only modules really are unreachable from the root", () => {
    // The other half of the claim. Naming them is not an exemption — it is an
    // assertion that the browser-bound modules stay behind `./browser.ts`,
    // which is what makes the loop above meaningful rather than lucky.
    for (const name of ["edge.ts", "page-wake.ts", "browser-platform.ts", "browser-profile.ts"]) {
      expect(existsSync(join(SRC, name)), `${name} exists`).toBe(true);
      expect([...rootClosure].map(named), `${name} is reachable from index.ts`).not.toContain(name);
    }
  });

  it("each platform entry reaches its own platform, and not the other's", () => {
    // Guards the entries themselves: a `./browser` that quietly stopped
    // pulling in the browser profile would be a broken publish that every
    // other test here would call healthy.
    const browser = [...closureOf("browser.ts")].map(named);
    const node = [...closureOf("node.ts")].map(named);
    expect(browser).toContain("browser-profile.ts");
    expect(browser).not.toContain("node.ts");
    expect(node).not.toContain("browser-profile.ts");
  });

  it("depends on the transport, but on no platform", () => {
    // The boundary is a package.json claim too. A dependency appearing here is
    // a design decision, and should fail until somebody makes it deliberately.
    // A member DOES depend on the transport — it dials, reserves and serves —
    // which is the difference between it and the hub. What it must not have is
    // a platform: tcp and WebRTC belong to the platform entries, IndexedDB to
    // `./browser`.
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toContain("@statewalker/httpeers-libp2p");
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@libp2p/tcp");
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@libp2p/webrtc");
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("idb-keyval");
  });
});

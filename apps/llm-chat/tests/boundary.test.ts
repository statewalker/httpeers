/**
 * The chat code never reaches httpeers, and core/ never reaches React or the DOM.
 *
 * Measured by REACHABILITY from the entry points, not by a list of filenames: whatever an entry
 * imports, directly or transitively, is checked, so a new file is covered the moment something
 * imports it. The standalone page must carry no mesh code, and this is how that is proven.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** Local `./x.js` specifiers, resolved to the `.ts` or `.tsx` file behind them. */
function localImports(file: string): string[] {
  const out: string[] = [];
  for (const match of codeOf(file).matchAll(/\b(?:from|import)\s+["'](\.[^"']*)["']/g)) {
    const base = resolve(dirname(file), (match[1] as string).replace(/\.js$/, ""));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, base]) {
      if (existsSync(candidate) && candidate.match(/\.tsx?$/)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

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

const named = (file: string): string => file.slice(SRC.length + 1);
/** `from "x"`, bare `import "x"`, and dynamic `import("x")` alike. */
const importOf = (pattern: string): RegExp =>
  new RegExp(`(?:\\bfrom|\\bimport)\\s*\\(?\\s*["'](?:${pattern})`);
const HTTPEERS = importOf("@statewalker/httpeers");
const REACT = importOf("react[\"'/]|react-dom|@assistant-ui/");
const DOM_ONLY = /\b(document|window|localStorage|sessionStorage)\b/;

const core = closureOf("core/index.ts");
const page = closureOf("pages/standalone.tsx");

describe("the chat boundary", () => {
  it("follows the entries somewhere (guards against a vacuous pass)", () => {
    expect([...core].map(named)).toContain("core/chat-controller.ts");
    expect([...page].map(named)).toEqual(
      expect.arrayContaining(["ui/ChatApp.tsx", "ui/Thread.tsx", "core/idb.ts"]),
    );
  });

  for (const file of [...page].sort()) {
    it(`${named(file)} — reachable from the standalone page — imports no httpeers`, () => {
      expect(codeOf(file)).not.toMatch(HTTPEERS);
    });
  }

  for (const file of [...core].sort()) {
    it(`${named(file)} — reachable from core — imports no React and no DOM-only global`, () => {
      expect(codeOf(file)).not.toMatch(REACT);
      expect(codeOf(file)).not.toMatch(DOM_ONLY);
    });
  }
});

/**
 * The chat code never reaches httpeers, and core/ never reaches React or the DOM.
 *
 * Measured by REACHABILITY from the entry points, not by a list of filenames: whatever an entry
 * imports, directly or transitively, is checked, so a new file is covered the moment something
 * imports it. The standalone page must carry no mesh code, and this is how that is proven.
 *
 * DYNAMIC IMPORTS ARE EDGES TOO. A lazy `import("./x.js")` still ships `x` in the page's bundle
 * graph, so the walk follows it exactly like a static `from "./x.js"`. `pages/mesh.tsx` is the one
 * entry allowed to reach httpeers; it is walked only to prove it reuses the chat.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * Local `./x.js` specifiers — `from "./x.js"`, bare `import "./x.js"` and dynamic
 * `import("./x.js")` — resolved to the `.ts` or `.tsx` file behind them.
 */
function localImports(file: string): string[] {
  const out: string[] = [];
  for (const match of codeOf(file).matchAll(/\b(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
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

function closureOf(entry: string, root = SRC): Set<string> {
  const seen = new Set<string>();
  const queue = [join(root, entry)];
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

  it("follows a dynamic import, so a lazy httpeers import is caught (guards the rule itself)", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-chat-boundary-"));
    try {
      writeFileSync(
        join(root, "entry.tsx"),
        'export const load = () => import("./lazy.js");\nexport const other = await import( "./eager.js" );\n',
      );
      writeFileSync(
        join(root, "lazy.ts"),
        'export const m = import("@statewalker/httpeers-member");\n',
      );
      writeFileSync(join(root, "eager.ts"), "export const x = 1;\n");
      const closure = [...closureOf("entry.tsx", root)].map((f) => f.slice(root.length + 1));
      expect(closure.sort()).toEqual(["eager.ts", "entry.tsx", "lazy.ts"]);
      expect(codeOf(join(root, "lazy.ts"))).toMatch(HTTPEERS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the mesh page reuses the chat and is the only page that reaches mesh code", () => {
    const mesh = closureOf("pages/mesh.tsx");
    expect([...mesh].map(named)).toEqual(
      expect.arrayContaining([
        "ui/ChatApp.tsx",
        "core/idb.ts",
        "mesh/discover.ts",
        "mesh/session.ts",
      ]),
    );
    expect(
      [...page].map(named).filter((f) => f.startsWith("mesh/") || f.startsWith("pages/mesh")),
    ).toEqual([]);
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

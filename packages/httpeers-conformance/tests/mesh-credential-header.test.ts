/**
 * Every httpeers library speaks the SAME credential header, and none of them
 * speaks `Authorization`.
 *
 * `Authorization` belongs to the application a mesh request is addressed to.
 * When the mesh kept its membership token there, the two collided: LiteLLM's
 * Playground put its own key in that header, the ServiceWorker edge would not
 * overwrite it, and the hub refused the key as a `malformed token`. The fix
 * moved the token to `MESH_TOKEN_HEADER`, spelled once in `httpeers-core`.
 *
 * A per-package unit test proves each writer and reader in isolation; this one
 * proves no package was missed and none will quietly drift back. It reads the
 * SOURCE of every library package, because a header name is a string literal
 * that no type checker can follow across packages.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_SRC = join(PACKAGES, "httpeers-core", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const LIBRARY_SOURCES = readdirSync(PACKAGES)
  .map((name) => join(PACKAGES, name, "src"))
  .filter((src) => {
    try {
      return statSync(src).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(sourceFiles);

/** Code only: a comment explaining why `Authorization` is not used is fine. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the mesh credential header across every httpeers library", () => {
  it("scans a real set of library sources", () => {
    // An empty scan would pass every assertion below vacuously.
    expect(LIBRARY_SOURCES.length).toBeGreaterThan(20);
    expect(LIBRARY_SOURCES.some((f) => f.includes("httpeers-member"))).toBe(true);
    expect(LIBRARY_SOURCES.some((f) => f.includes("httpeers-access"))).toBe(true);
  });

  it("no library reads or writes an Authorization header", () => {
    const offenders = LIBRARY_SOURCES.filter((file) =>
      /["'`]authorization["'`]/i.test(withoutComments(readFileSync(file, "utf8"))),
    ).map((file) => relative(PACKAGES, file));
    expect(offenders).toEqual([]);
  });

  it("no library builds a Bearer credential for the mesh", () => {
    const offenders = LIBRARY_SOURCES.filter((file) =>
      /Bearer \$\{/.test(withoutComments(readFileSync(file, "utf8"))),
    ).map((file) => relative(PACKAGES, file));
    expect(offenders).toEqual([]);
  });

  it("only httpeers-core spells the header name; everyone else imports it", () => {
    const offenders = LIBRARY_SOURCES.filter(
      (file) =>
        !file.startsWith(CORE_SRC) &&
        withoutComments(readFileSync(file, "utf8")).includes(`"${MESH_TOKEN_HEADER}"`),
    ).map((file) => relative(PACKAGES, file));
    expect(offenders).toEqual([]);
  });
});

/** The root entry point stays isomorphic: nothing under src/ but src/bridge/ imports a `node:` module. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("the isomorphic entry point imports no node: modules", () => {
  const src = join(import.meta.dirname, "../src");
  const offenders = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .filter((e) => /from "node:|import\("node:/.test(readFileSync(join(src, e.name), "utf8")))
    .map((e) => e.name);
  expect(offenders).toEqual([]);
});

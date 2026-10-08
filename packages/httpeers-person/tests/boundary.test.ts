/**
 * The package's claim — isomorphic, no dependencies — as a test. If the file
 * scan finds nothing, every check would pass vacuously, so it is guarded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = readdirSync(join(root, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(join(root, "src", f), "utf8") }));

describe("boundary", () => {
  it("scans some sources", () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
  });

  it("imports nothing but its own files", () => {
    for (const { file, text } of sources) {
      for (const [, spec] of text.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\//);
      }
    }
  });

  it("declares no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

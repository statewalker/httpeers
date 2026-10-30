/**
 * M8 — one Bridge per platform, cross-compiled here. Each file is checked to
 * be an executable for its platform by its first bytes; only the host's own
 * build can be run here (tests/binary.test.ts runs it).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TARGETS } from "../scripts/targets.js";

const hasBun = (() => {
  try {
    execFileSync("bun", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
const out = mkdtempSync(join(tmpdir(), "peershare-targets-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function firstBytes(file: string, n = 4): number[] {
  const buf = Buffer.alloc(n);
  const fd = openSync(file, "r");
  readSync(fd, buf, 0, n, 0);
  return [...buf];
}

const MAGIC: Record<string, number[]> = {
  linux: [0x7f, 0x45, 0x4c, 0x46], // ELF
  darwin: [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit, little-endian
  windows: [0x4d, 0x5a], // "MZ": a PE executable
};

describe.skipIf(!hasBun)("M8 — the Bridge for every platform", () => {
  it("covers Linux, macOS and Windows on x64 and arm64", () => {
    expect(TARGETS.map((t) => t.target).sort()).toEqual([
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-linux-arm64",
      "bun-linux-x64",
      "bun-windows-x64",
    ]);
  });

  it.each(TARGETS)(
    "$target is an executable for its platform",
    ({ target, os, file }) => {
      execFileSync("node", [join(import.meta.dirname, "../scripts/compile-all.mjs"), out, target], {
        stdio: "ignore",
      });
      const path = join(out, file);
      const magic = MAGIC[os] as number[];
      expect(firstBytes(path, magic.length)).toEqual(magic);
      console.log(`${file}: ${(statSync(path).size / 1e6).toFixed(0)} MB`);
      rmSync(path);
    },
    180_000,
  );
});

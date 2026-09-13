/**
 * Can every prototype be built on the published API? `tsc` answers.
 *
 * Rung 07 established this technique for two consumers an adversarial review
 * had declared unbuildable; this widens it to the whole ladder. An API is
 * sufficient when the things that already exist can be built on it, and the
 * only way to find out is to write them and compile — prose cannot tell you,
 * and a review agrees with whatever the reviewer already believes.
 *
 * `tests/consumers.ts` is never executed. It is COMPILED, against
 * the built `dist/` of all eight packages, and a missing export or a narrowed
 * parameter surfaces here as a failure rather than in wave 5.
 *
 * Three gaps were found this way and closed: `createGateway` (rung 08, and an
 * explicit requirement — the mesh as ordinary HTTP), the duplex altitude
 * (rung 09, also explicitly asked for, because a fetch-only contract cannot
 * express a WebSocket), and `guardStream` (rung 10, revoking a stream that is
 * already open). None of the three appears in the design document.
 *
 * WHY THIS IS ITS OWN PACKAGE AND NOT `httpeers-core/tests/`: a check that
 * depends on everything has to be a leaf, or the dependency graph has a cycle
 * turbo refuses to run. See this package's README.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

function findUp(relative: string): string {
  let dir = PKG;
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`prototypes test: could not find ${relative} above ${PKG}`);
}

describe("every prototype, against the published API", () => {
  it("compiles", () => {
    // The package's own tsconfig already includes `tests/**`, so this is the
    // same compile the suite runs — asserted explicitly so the file cannot be
    // quietly dropped from the build and stop checking anything.
    expect(existsSync(join(PKG, "tests/consumers.ts"))).toBe(true);

    const tsc = findUp("node_modules/.bin/tsc");
    expect(() =>
      execFileSync(tsc, ["--noEmit", "-p", join(PKG, "tsconfig.json")], { stdio: "pipe" }),
    ).not.toThrow();
  }, 300_000);
});

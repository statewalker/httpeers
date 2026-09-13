/**
 * The consumer's view — the only place a broken `exports` map can be seen.
 *
 * `tsc --noEmit` inside a package compiles its own source with its own
 * settings, so it proves nothing about what a downstream project receives: not
 * that `exports` resolves, not that the `.d.ts` files are reachable, not that
 * a type survived the build. This compiles files that import the package by
 * its PUBLIC NAME, against the BUILT artefact, the way a dependent would.
 *
 * THIS PACKAGE HAS THREE ENTRY POINTS, AND EACH IS TESTED SEPARATELY. The
 * sibling tests only ever exercised `.`, which is exactly where a broken
 * subpath hides: `./browser` and `./node` resolve through their own export
 * conditions, and a typo in either is invisible from the root. That is not
 * hypothetical here — `./browser` was added in the same iteration as this
 * test.
 *
 * The `httpeers-core` test carries the reasoning for the three-config matrix
 * in full.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * FIND the toolchain, never assume where it lives — pnpm hoists to the
 * ASSEMBLY root when this repository is checked out beside its siblings, and a
 * hard-coded `../../node_modules/.bin/tsc` then fails with a bare ENOENT that
 * says nothing about why.
 */
function findUp(relative: string): string {
  let dir = PKG;
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`consumer test: could not find ${relative} above ${PKG}`);
}

const TSC = findUp("node_modules/.bin/tsc");
const TYPES = findUp("node_modules/@types");

/** One per entry point. Only public entries, never a deep path into `dist/`. */
const ENTRIES: Array<[name: string, source: string]> = [
  [
    "the root entry",
    `
import type { MemberHandle, MemberPlatform, PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createGateway, createPeerSession, invitationFromQrText, startMember } from "@statewalker/httpeers-member";

export const check = {
  startMember,
  createGateway,
  createPeerSession,
  qr: invitationFromQrText("nope"),
};
export type Check = { h: MemberHandle; p: MemberPlatform; s: PeerSession; st: SessionState };
`,
  ],
  [
    "the ./node entry",
    `
import { createNodeMemberNode, nodePlatform } from "@statewalker/httpeers-member/node";
export const check = { createNodeMemberNode, nodePlatform };
`,
  ],
  [
    "the ./browser entry",
    `
import { browserPlatform, createSession, idbBackend, idbBytesBackend, mountEdge } from "@statewalker/httpeers-member/browser";
export const check = { browserPlatform, createSession, idbBackend, idbBytesBackend, mountEdge };
`,
  ],
];

/**
 * The shapes a real consumer takes. All must compile.
 *
 * THE `NodeNext` ROW IS THE ONE THAT TESTS THE `exports` MAP: `Bundler`
 * resolution falls back to the legacy top-level `types` field when an export
 * condition does not resolve, so it cannot see a broken map at all. For a
 * SUBPATH there is no legacy fallback to fall back to, which makes this row
 * the only thing standing between a typo in `./browser` and a consumer who
 * cannot import it.
 */
const CONFIGS: Array<[name: string, compilerOptions: Record<string, unknown>]> = [
  [
    "a Node project",
    { types: ["node"], lib: ["ES2022"], module: "ESNext", moduleResolution: "Bundler" },
  ],
  [
    "a browser project",
    { types: [], lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler" },
  ],
  [
    "a NodeNext project — the only row that honours the exports map",
    { types: ["node"], lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext" },
  ],
];

function compile(
  source: string,
  compilerOptions: Record<string, unknown>,
): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "httpeers-member-consumer-"));
  try {
    mkdirSync(join(dir, "node_modules/@statewalker"), { recursive: true });
    symlinkSync(PKG, join(dir, "node_modules/@statewalker/httpeers-member"), "dir");
    // @types/node has to be resolvable from the fixture, so borrow the repo's.
    symlinkSync(TYPES, join(dir, "node_modules/@types"), "dir");
    writeFileSync(join(dir, "use.ts"), source);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          strict: true,
          noEmit: true,
          // `skipLibCheck`, because this test is about OUR exports map and not
          // about upstream `.d.ts` hygiene. `@libp2p/interface`'s declarations
          // name `EventInit` and `JsonWebKey`, which only the DOM lib supplies,
          // so without this the Node rows fail on somebody else's types and say
          // nothing about this package. It is also what a real consumer has —
          // `skipLibCheck` is on in essentially every project template.
          //
          // IT DOES NOT WEAKEN WHAT THIS CATCHES. A broken `exports` map is a
          // module RESOLUTION failure, not a lib check, and `use.ts` itself is
          // still fully checked — so a missing or renamed export still fails
          // here. Verified by breaking the map deliberately.
          skipLibCheck: true,
          ...compilerOptions,
        },
        include: ["use.ts"],
      }),
    );
    execFileSync(TSC, ["--project", join(dir, "tsconfig.json")], { stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a downstream project can use the built package", () => {
  beforeAll(() => {
    // The artefact under test is `dist/`, so it has to exist. `pnpm test`
    // builds first; this is the guard for anyone running vitest directly.
    execFileSync(TSC, ["-p", join(PKG, "tsconfig.build.json")], { stdio: "pipe" });
  }, 180_000);

  for (const [entry, source] of ENTRIES) {
    for (const [config, options] of CONFIGS) {
      it(`compiles ${entry} against ${config}`, () => {
        const { ok, output } = compile(source, options);
        expect(output).toBe("");
        expect(ok).toBe(true);
      }, 180_000);
    }
  }
});

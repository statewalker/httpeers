/**
 * The consumer's view — the only place a broken `exports` map can be seen.
 *
 * `tsc --noEmit` inside a package compiles its own source with its own
 * settings, so it proves nothing about what a downstream project receives: not
 * that `exports` resolves, not that the `.d.ts` files are reachable, not that
 * a type survived the build. This compiles a file that imports the package by
 * its PUBLIC NAME, against the BUILT artefact, the way a dependent would.
 *
 * It earned its place on the first run, twice over. It found that the package
 * exports `provide`, not `set`, on a mount table — a mistake in the caller,
 * which is exactly the kind of thing a consumer hits first. And it found that
 * the emitted `.d.ts` files name the GLOBAL `Request` and `Response`, so a
 * project configured with neither `lib: ["DOM"]` nor `@types/node` gets
 * seventeen `Cannot find name 'Request'` errors from inside our own types.
 *
 * That second finding is not a bug to fix by redeclaring the globals — doing
 * so would collide with the real declarations for every consumer who does have
 * them. It is a REQUIREMENT to state and to test: the package needs its host
 * project to declare the WinterCG globals, which every real runtime target
 * does. So the test compiles under both shapes a real consumer takes.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(PKG, "../..");
const TSC = join(REPO, "node_modules/.bin/tsc");

/** What a dependent writes. Only the public entry point, never a deep path. */
const CONSUMER = `
import {
  ANONYMOUS,
  createMemberStore,
  createMounts,
  type FetchHandler,
  json,
  RULE_SET_BRAND,
  type RuleSet,
  validateRoles,
} from "@statewalker/httpeers-core";

const rules: RuleSet = {
  [RULE_SET_BRAND]: true,
  version: 1,
  rules: ['capability("x:read") <- role("member");'],
  policies: [],
};

const store = createMemberStore(rules, () => 0);
store.add("peer-a", ["member"]);

const hello: FetchHandler = async () => json({ ok: true });
const mounts = createMounts();
mounts.provide("/hello", hello);

export const check = {
  anonymous: ANONYMOUS,
  roles: store.get("peer-a")?.roles,
  unknownRole: validateRoles(rules, ["nope"], "ctx"),
  mounted: mounts.match("/hello") !== null,
};
`;

/**
 * The shapes a real consumer takes. All must compile: a package that works
 * under only one of them is not isomorphic, whatever its imports say.
 *
 * THE `NodeNext` ROW IS THE ONE THAT TESTS THE `exports` MAP, and it was added
 * after the first two were caught passing with a DELIBERATELY BROKEN map
 * (`"types": "./dist/nope.d.ts"`). `moduleResolution: "Bundler"` falls back to
 * the legacy top-level `types` field when an export condition does not
 * resolve, so it cannot see the breakage at all. `NodeNext` honours `exports`
 * strictly and fails with `Cannot find module`. Without this row the whole
 * suite was decorative on the point it exists to make.
 */
const CONFIGS: Array<[name: string, compilerOptions: Record<string, unknown>]> = [
  [
    "a Node project (@types/node supplies the globals)",
    { types: ["node"], lib: ["ES2022"], module: "ESNext", moduleResolution: "Bundler" },
  ],
  [
    "a browser project (the DOM lib supplies them)",
    { types: [], lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler" },
  ],
  [
    "a NodeNext project — the only row that honours the exports map",
    { types: ["node"], lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext" },
  ],
];

function compile(compilerOptions: Record<string, unknown>): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "httpeers-consumer-"));
  try {
    mkdirSync(join(dir, "node_modules/@statewalker"), { recursive: true });
    symlinkSync(PKG, join(dir, "node_modules/@statewalker/httpeers-core"), "dir");
    // @types/node has to be resolvable from the fixture, so borrow the repo's.
    symlinkSync(join(REPO, "node_modules/@types"), join(dir, "node_modules/@types"), "dir");
    writeFileSync(join(dir, "use.ts"), CONSUMER);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          strict: true,
          noEmit: true,
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
  }, 120_000);

  for (const [name, options] of CONFIGS) {
    it(`compiles against ${name}`, () => {
      const { ok, output } = compile(options);
      expect(output).toBe("");
      expect(ok).toBe(true);
    }, 120_000);
  }
});

/**
 * The consumer's view — and here it checks THREE entry points, not one.
 *
 * The sibling `httpeers-core` test carries the reasoning in full, including
 * why the `NodeNext` row is the only one that reads the `exports` map at all.
 * This package has `.`, `./issuer` and `./engine`, and a subpath that resolves
 * from source while failing from `dist` is exactly the breakage no test inside
 * the package can see.
 *
 * The split is also asserted here as a FACT about the graph, not a convention:
 * a member imports the root and must not thereby acquire minting.
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
import type { FetchHandler } from "@statewalker/httpeers-core";
import { json } from "@statewalker/httpeers-core";
import {
  access,
  type IssuerKeys,
  type RuleSet,
  ruleSet,
  selfCertifyingKeys,
  verifyToken,
  withAccess,
} from "@statewalker/httpeers-access";
import { generateSigner, mintToken, RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { initBiscuit } from "@statewalker/httpeers-access/engine";

const rules: RuleSet = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: ['allow if capability("app:read"), resource("/data");'],
});

const keys: IssuerKeys = selfCertifyingKeys();
const next: FetchHandler = async (request) => json({ sub: access(request)?.claims?.sub });

export const check = {
  guarded: withAccess({ issuer: "12D3KooWIssuer", rules, keys, provenPeer: () => "12D3KooWPeer" })(
    next,
  ),
  verify: verifyToken,
  mint: mintToken,
  signer: generateSigner,
  registry: RevocationRegistry,
  engine: initBiscuit,
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
    symlinkSync(PKG, join(dir, "node_modules/@statewalker/httpeers-access"), "dir");
    // This package's own types reference core's, so a consumer resolves both.
    symlinkSync(
      join(REPO, "packages/httpeers-core"),
      join(dir, "node_modules/@statewalker/httpeers-core"),
      "dir",
    );
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
    // Both artefacts: a consumer of this package resolves core's types too,
    // so a stale core `dist` would fail here for a reason that is not ours.
    execFileSync(TSC, ["-p", join(REPO, "packages/httpeers-core/tsconfig.build.json")], {
      stdio: "pipe",
    });
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

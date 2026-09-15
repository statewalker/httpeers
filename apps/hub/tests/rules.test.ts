/**
 * `rules.dl`: written from the defaults once, the operator's afterwards.
 *
 * Module rules are appended at LOAD, never written, so an operator's file
 * never has to be edited when a module changes its own rules.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityNames, roleNames, ruleSet } from "@statewalker/httpeers-access";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_POLICIES, DEFAULT_RULES, loadOrCreateRules } from "../src/rules.js";
import type { ServiceModule } from "../src/service-module.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-rules-"));
  dirs.push(dir);
  return dir;
}

const echo: ServiceModule = {
  id: "echo",
  advertisement: { id: "echo", kind: "test-service", title: "Echo" },
  rules: ['capability("app:echo.use") <- role("member");'],
  policies: ['allow if capability("app:echo.use"), resource($r), $r.starts_with("/echo/");'],
  handler: async () => new Response("echo"),
};

describe("loadOrCreateRules", () => {
  it("writes the defaults as JSON on first load, and only then", async () => {
    const dir = await tempDir();
    loadOrCreateRules(dir, []);
    const written = await readFile(join(dir, "rules.dl"), "utf8");
    expect(JSON.parse(written)).toEqual({
      version: 1,
      rules: [...DEFAULT_RULES.rules],
      policies: [...DEFAULT_RULES.policies],
    });

    loadOrCreateRules(dir, [echo]);
    expect(await readFile(join(dir, "rules.dl"), "utf8")).toBe(written);
  });

  it("carries the mesh protocol's capabilities and roles by default", async () => {
    const rules = loadOrCreateRules(await tempDir(), []);
    expect(capabilityNames(rules)).toEqual(
      expect.arrayContaining(["std:mesh.read", "std:presence.write", "std:mesh.admin"]),
    );
    expect(roleNames(rules)).toEqual(expect.arrayContaining(["member", "admin"]));
    expect(rules.policies.some((p) => p.includes("/.well-known"))).toBe(true);
  });

  it("appends each module's rules and policies at load time without writing them", async () => {
    const dir = await tempDir();
    const rules = loadOrCreateRules(dir, [echo]);
    // Compared through `ruleSet`, which stores each statement in canonical form.
    const expected = ruleSet({
      rules: [...DEFAULT_RULES.rules, ...echo.rules],
      policies: [...DEFAULT_RULES.policies, ...CORE_POLICIES, ...echo.policies],
    });
    expect(rules.rules).toEqual(expected.rules);
    expect(rules.policies).toEqual(expected.policies);
    expect(await readFile(join(dir, "rules.dl"), "utf8")).not.toContain("app:echo.use");
  });

  it("grants the admin API to std:mesh.admin without writing the core policy either", async () => {
    const dir = await tempDir();
    const rules = loadOrCreateRules(dir, []);
    expect(rules.policies.some((p) => p.includes("/hub/api"))).toBe(true);
    expect(await readFile(join(dir, "rules.dl"), "utf8")).not.toContain("/hub/api");
  });

  it("grants the admin API even to a rules.dl written before it existed", async () => {
    const dir = await tempDir();
    // The exact shape `loadOrCreateRules` wrote under Task 3, with no mention
    // of `/hub/api` anywhere -- an operator's data directory from before this
    // task landed.
    await writeFile(
      join(dir, "rules.dl"),
      JSON.stringify({
        version: 1,
        rules: [...DEFAULT_RULES.rules],
        policies: [...DEFAULT_RULES.policies],
      }),
    );
    const rules = loadOrCreateRules(dir, []);
    expect(rules.policies.some((p) => p.includes("/hub/api"))).toBe(true);
  });

  it("respects a file the operator edited", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "rules.dl"),
      JSON.stringify({
        version: 7,
        rules: ['capability("std:mesh.read") <- role("guest");'],
        policies: ['allow if capability("std:mesh.read"), resource("/.well-known");'],
      }),
    );
    const rules = loadOrCreateRules(dir, [echo]);
    expect(rules.version).toBe(7);
    expect(roleNames(rules)).toContain("guest");
    expect(roleNames(rules)).not.toContain("admin");
    expect(rules.rules.at(-1)).toBe(ruleSet({ rules: echo.rules }).rules[0]);
  });

  it("refuses a file that is not the rules document rather than replacing it", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "rules.dl"), "capability(oops");
    expect(() => loadOrCreateRules(dir, [])).toThrow(/rules\.dl/);
    expect(await readFile(join(dir, "rules.dl"), "utf8")).toBe("capability(oops");

    await writeFile(join(dir, "rules.dl"), JSON.stringify({ version: 1, rules: "nope" }));
    expect(() => loadOrCreateRules(dir, [])).toThrow(/rules\.dl/);
  });
});

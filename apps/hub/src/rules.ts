/**
 * The hub's rules: `rules.dl`, created from the defaults once, the operator's
 * from then on.
 *
 * THE FILE IS JSON, `{ "version": 1, "rules": string[], "policies": string[] }`
 * -- the input `ruleSet()` takes, so parsing is `JSON.parse` and nothing else.
 * It keeps the `.dl` name because that is what an operator looks for.
 *
 * MODULE RULES ARE APPENDED AT LOAD, NEVER WRITTEN. A module's rules are part
 * of its code and change with it; writing them into the operator's file would
 * freeze one version of them there, and a later module release would be
 * silently governed by its predecessor's policy.
 *
 * CORE POLICIES -- today, only the admin REST API's -- ARE APPENDED THE SAME
 * WAY, FOR THE SAME REASON, AND FOR ONE MORE: an existing `/data/hub/rules.dl`
 * predates the admin API and was written to disk before it existed. If the
 * `/hub/api` policy lived only in `DEFAULT_RULES` -- written once, on first
 * start -- every hub upgraded in place would keep an old file that never
 * grants `std:mesh.admin` access to it, and the admin API would 403 on an
 * operator's own hub until they hand-edited `rules.dl`. Appending it at load,
 * like a module's policies, means every hub gets it on the next start, old
 * data directory or new, with nothing to migrate.
 *
 * SKIPPED WHEN NOTHING DERIVES `std:mesh.admin`. An operator's file may have
 * replaced the defaults with a rule set that has no admin concept at all
 * (`rules.test.ts`'s "respects a file the operator edited"); `ruleSet()`
 * refuses to build a policy naming a capability no rule can derive (A-10 /
 * X-02), so appending the core policy unconditionally would turn a merely
 * unusual file into a hub that fails to start. This checks first and leaves
 * the file's own policies untouched when the capability is absent -- exactly
 * as if the core policy did not exist, which for that hub it might as well
 * not.
 *
 * AN UNREADABLE FILE STOPS THE START. It is never replaced by the defaults: an
 * operator who narrowed the policy and made a typo must not get the wide
 * default back without being told.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityNames, type RuleSet, ruleSet } from "@statewalker/httpeers-access";
import { ADMIN_CAPABILITY } from "@statewalker/httpeers-hub";
import { writeFileAtomicSync } from "./fs-atomic.js";
import type { ServiceModule } from "./service-module.js";

export const RULES_FILE = "rules.dl";

export interface RulesDocument {
  version: number;
  rules: string[];
  policies: string[];
}

/**
 * The mesh protocol's rules -- the demos' base policy without its demo
 * application capabilities. Policy names capabilities, never roles; `std:` is
 * the protocol's prefix.
 */
export const DEFAULT_RULES: RulesDocument = {
  version: 1,
  rules: [
    // What every member needs to take part in the mesh at all.
    'capability("std:mesh.read")      <- role("member");',
    'capability("std:presence.write") <- role("member");',
    'capability("std:mesh.admin")     <- role("admin");',
    // Admin implies member.
    'role("member")                   <- role("admin");',
    // Present but granting nothing of its own: a member the mesh view hides.
    'role("member")                   <- role("hidden");',
  ],
  policies: [
    'allow if capability("std:mesh.read"), resource("/.well-known")' +
      ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
    'allow if capability("std:mesh.admin"), resource("/admin")' +
      ' or capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
  ],
};

/**
 * Appended at load time, never written -- see the module comment. Grants the
 * admin REST API (spec §5.4) to whoever already holds `std:mesh.admin`,
 * exactly the mesh mount's own policy (`daemon.ts`'s `withAccess`) so the
 * mesh and the local door apply the same rule to the same handler.
 */
export const CORE_POLICIES: string[] = [
  'allow if capability("std:mesh.admin"), resource("/hub/api")' +
    ' or capability("std:mesh.admin"), resource($r), $r.starts_with("/hub/api/");',
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readRulesDocument(file: string): RulesDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `rules: ${file} is not JSON (${(error as Error).message}). Expected ` +
        '{ "version": 1, "rules": [...], "policies": [...] }; fix or delete it to restore the defaults.',
    );
  }
  const doc = parsed as Partial<RulesDocument> | null;
  if (
    doc == null ||
    typeof doc !== "object" ||
    typeof doc.version !== "number" ||
    !isStringArray(doc.rules) ||
    !isStringArray(doc.policies)
  ) {
    throw new Error(
      `rules: ${file} must be { "version": number, "rules": string[], "policies": string[] }`,
    );
  }
  return { version: doc.version, rules: doc.rules, policies: doc.policies };
}

export function loadOrCreateRules(dir: string, modules: ServiceModule[]): RuleSet {
  const file = join(dir, RULES_FILE);
  if (!existsSync(file)) {
    writeFileAtomicSync(file, `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`);
  }
  const doc = readRulesDocument(file);
  const rules = [...doc.rules, ...modules.flatMap((m) => m.rules)];
  try {
    // Checked against the rules ALONE (no policies yet): does anything here
    // derive the capability the core policy gates? See the module comment on
    // why an operator's rules that dropped `std:mesh.admin` entirely must
    // skip it rather than fail to start.
    const canAdmin = capabilityNames(
      ruleSet({ version: doc.version, rules, policies: [] }),
    ).includes(ADMIN_CAPABILITY);
    return ruleSet({
      version: doc.version,
      rules,
      policies: [
        ...doc.policies,
        ...(canAdmin ? CORE_POLICIES : []),
        ...modules.flatMap((m) => m.policies),
      ],
    });
  } catch (error) {
    throw new Error(
      `rules: ${file} plus the modules' rules do not load: ${(error as Error).message}`,
    );
  }
}

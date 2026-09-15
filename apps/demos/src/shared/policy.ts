/**
 * This deployment's rules, in Datalog.
 *
 * APP POLICY, NOT LIBRARY DEFAULT. `httpeers-access` deliberately ships no
 * `DEFAULT_RULES`: the one it used to export derived `std:` capabilities for a
 * demo mount and no `app:` capability at all, so every caller who reached for
 * it as a starting point mounted an application under it and got a permanent
 * silent denial. Rules are a parameter, and these are this app's.
 *
 * POLICY NAMES CAPABILITIES, NEVER ROLES. `std:` is the mesh protocol's own
 * prefix; anything this application invents takes `app:`.
 *
 * Built lazily and memoised: `ruleSet()` parses and validates the Datalog, and
 * a page that never evaluates a policy should not pay for that at load.
 */

import { type RuleSet, ruleSet } from "@statewalker/httpeers-access";

let built: RuleSet | undefined;

/** The mesh's rules. Memoised, so the cost is paid once. */
export function meshRules(): RuleSet {
  built ??= ruleSet({
    version: 1,
    rules: [
      // Mesh protocol capabilities every member needs to participate at all.
      'capability("std:mesh.read")      <- role("member");',
      'capability("std:presence.write") <- role("member");',
      // What this application's own services are gated on.
      'capability("app:images.read")    <- role("member");',
      'capability("app:search.query")   <- role("member");',
      'capability("app:proxy.use")      <- role("member");',
      // Admin implies member -- transitivity is what a rule does, so there is no
      // separate `implies` feature to maintain.
      'capability("std:mesh.admin")     <- role("admin");',
      'role("member")                   <- role("admin");',
      // Present but granting nothing of its own: a member the mesh view hides.
      'role("member")                   <- role("hidden");',
    ],
    policies: [
      'allow if capability("std:mesh.read"), resource("/.well-known")' +
        ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
      'allow if capability("app:images.read"), resource($r), $r.starts_with("/images");',
      'allow if capability("app:search.query"), resource($r), $r.starts_with("/search");',
      // BOTH FORMS, and deliberately: `/proxy` is the route LISTING and
      // `/proxy/...` is a proxied call. A bare `starts_with("/proxy")` would
      // also grant `/proxying-something-else`, which is why the exact match
      // and the slash-prefixed match are written separately.
      'allow if capability("app:proxy.use"), resource("/proxy")' +
        ' or capability("app:proxy.use"), resource($r), $r.starts_with("/proxy/");',
      'allow if capability("std:mesh.admin"), resource("/admin")' +
        ' or capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
    ],
  });
  return built;
}

/** The mount-prefix first segment, and the ServiceWorker adapter key. One per origin. */
export const EDGE_KEY = "peers";

/**
 * The node's rules and policies, in Datalog (ADR-0019, spec §6.4-6.5).
 *
 * Replaces `access-tree.ts` (a walked `.access` tree) and `vocabulary.ts` (a
 * role→capability document with transitive `implies`). Those were five
 * mechanisms — a root→leaf walk, inheritance, deeper-may-widen, per-method
 * sub-entries, and a separate vocabulary — where Datalog has one, and in
 * Datalog transitivity is simply what a rule does.
 *
 * THE TOKEN CARRIES ROLES; THE NODE HOLDS THE RULES (ADR-0016 amendment).
 * The hub mints identity and role facts. This file is the other half: the
 * rules deriving capabilities from roles, and the policies governing this
 * node's own resources. Nothing remote influences a decision — a `RuleSet`
 * is constructed locally and never fetched, so there is nothing on the
 * permissive path to tamper with.
 *
 *     capability("app:notes.read")  <- role("app:reader");
 *     role("app:reader")            <- role("app:editor");   // transitive, for free
 *     allow if resource($r), $r.starts_with("/notes"), operation("GET"),
 *              capability("app:notes.read");
 *
 * FAIL FAST, NOT CLOSED — and Datalog has its own version of the mistake.
 * `withAccessTree` refused to start on a policy naming an undeclared
 * capability, because "a policy that denies everyone through a typo is
 * indistinguishable from one that is working". The Datalog form of that typo
 * is subtler and just as silent: a rule body naming a predicate NOTHING
 * asserts and NO rule derives simply never fires, and the resulting permanent
 * denial looks exactly like a working policy. `ruleSet()` therefore refuses to
 * build such a value, listing every problem rather than the first:
 *
 *   - a rule or policy that does not parse                       (was: a runtime throw)
 *   - a body predicate nothing supplies and no rule derives       (the new silent typo)
 *   - a policy naming a capability no rule can derive             (A-10, X-02)
 *   - a rule deriving a fact the node or the token asserts        (a forged input)
 *   - a policy text in `rules`, or a rule text in `policies`      (see ORDER, below)
 *
 * `time_ms`, NOT `time` — Ruling 83, inherited from `tokens.ts`. Prototype 10
 * asserts a date-valued `time($t)`; this package's clock is `() => number`
 * everywhere and `revocation.ts` orders `iat` against `changedAt` at
 * MILLISECOND resolution, which `clock.ts`'s `createMonotonicClock` exists to
 * make strict. Biscuit's date terms are RFC3339 SECONDS, so routing time
 * through them would throw away exactly the resolution that fix depends on.
 * The verifier supplies `time_ms` and never `time`, so a rule ported verbatim
 * from prototype 10 does not silently compare two different notions of time —
 * it names a predicate nothing supplies, and `ruleSet()` refuses it by name at
 * construction. That is the reconciliation: loud at build, not merely closed at
 * request time.
 *
 * ORDER: DENY FIRST. Biscuit evaluates policies in order and the first match
 * wins, so an `allow` written above a `deny` would beat it. A-05 says a `deny`
 * beats any `allow` that also matches, so `ruleSet()` emits every `deny`
 * before every `allow`, each group in the order the author wrote it. This is
 * also why a policy smuggled into `rules` is a construction error rather than
 * a curiosity: it would be added outside that ordering.
 *
 * SEGMENT BOUNDARIES ARE NOT PREFIXES. `$r.starts_with("/test")` also matches
 * `/testing`, which the tree's `/test/` key did not. The idiom that reproduces
 * "this resource AND everything under it" in one policy is an `or` variant:
 *
 *     allow if capability("std:test"), resource("/test")
 *           or capability("std:test"), resource($r), $r.starts_with("/test/");
 *
 * `DEFAULT_RULES` below is written that way, and so is every policy this
 * package's own tests rely on.
 */
import { AuthorizerBuilder, Policy, Rule } from "@biscuit-auth/biscuit-wasm";
import type {
  FetchHandler,
  MeshClaims,
  PeerIdStr,
  UsesTransportIdentity,
} from "@statewalker/httpeers-core";
import { json, lookupClaims, lookupPeer } from "@statewalker/httpeers-core";
import { LIMITS, warmUpTokens } from "./tokens.js";

// ---------------------------------------------------------------------------
// The fact vocabulary a rule may consume
// ---------------------------------------------------------------------------

/**
 * Facts the NODE asserts about itself and the request. Never read from a
 * token — that is A-04, and it is why these are listed here rather than
 * discovered from whatever a token happens to carry.
 */
const NODE_FACTS = ["operation", "resource", "self_peer", "connection_peer", "time_ms"] as const;

/**
 * Facts carried by a verified token's AUTHORITY block, as `MeshClaims`.
 * `tokens.ts`'s `readClaims` reads them through an authority-scoped
 * authorizer, so an appended block cannot inject any of them — which is what
 * makes "an appended block cannot grant a role" (A-23) true here too.
 */
const TOKEN_FACTS = ["subject", "mesh", "role", "issued_at", "expires_at"] as const;

const SUPPLIED = new Set<string>([...NODE_FACTS, ...TOKEN_FACTS]);

/**
 * A rule may derive `role` — role implication is the whole point — and
 * anything of its own (`capability`, an application's own helper predicate).
 * It may not derive a fact the node or the token states, because a rule that
 * did could manufacture the very inputs a policy is meant to test.
 */
const UNDERIVABLE = new Set<string>([...NODE_FACTS, "subject", "mesh", "issued_at", "expires_at"]);

// ---------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------

const BUILT: unique symbol = Symbol.for("httpeers.ruleSet");

/**
 * An immutable, validated rule set (ADR-0007: a value, swapped atomically).
 *
 * Only `ruleSet()` produces one. The brand is not decoration: a caller who
 * could assemble a `RuleSet` from an object literal would bypass every check
 * above, and a rule set that was never validated is exactly the silent
 * permanent denial this module exists to refuse.
 */
export interface RuleSet {
  readonly [BUILT]: true;
  /** Bumped by the author on every edit; carried in the heartbeat version vector. */
  readonly version: number;
  /** Capability derivation and role implication, canonicalized, one rule each. */
  readonly rules: readonly string[];
  /** `deny` policies first, then `allow`, each group in authored order. */
  readonly policies: readonly string[];
}

/** Every problem with a rule set, never just the first. */
export class RuleSetError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid rule set:\n  - ${problems.join("\n  - ")}`);
    this.name = "RuleSetError";
  }
}

export function assertValid(problems: string[]): void {
  if (problems.length > 0) throw new RuleSetError(problems);
}

export interface RuleSetDefs {
  version?: number;
  rules?: readonly string[];
  policies?: readonly string[];
}

/**
 * Build and validate a rule set. Throws `RuleSetError` listing EVERY problem.
 *
 * See the module comment for what counts as a problem and why refusing to
 * start beats denying every request forever.
 */
export function ruleSet(defs: RuleSetDefs = {}): RuleSet {
  const problems: string[] = [];

  const rules: string[] = [];
  const heads: string[] = [];
  defs.rules?.forEach((source, i) => {
    const text = trimStatement(source);
    if (text === "") {
      problems.push(`rules[${i}]: empty`);
      return;
    }
    let canonical: string;
    try {
      canonical = Rule.fromString(text).toString();
    } catch (error) {
      problems.push(`rules[${i}]: ${parseProblem(text, error)}`);
      return;
    }
    rules.push(canonical);
    heads.push(canonical.split("<-")[0] ?? "");
  });

  const denies: string[] = [];
  const allows: string[] = [];
  defs.policies?.forEach((source, i) => {
    const text = trimStatement(source);
    if (text === "") {
      problems.push(`policies[${i}]: empty`);
      return;
    }
    let canonical: string;
    try {
      canonical = Policy.fromString(text).toString();
    } catch (error) {
      problems.push(`policies[${i}]: ${parseProblem(text, error)}`);
      return;
    }
    (canonical.startsWith("deny") ? denies : allows).push(canonical);
  });

  const policies = [...denies, ...allows];
  const derivable = new Set(heads.flatMap((head) => predicatesIn(head)));

  // A rule that derives what the node or the token asserts.
  heads.forEach((head, i) => {
    for (const p of predicatesIn(head)) {
      if (UNDERIVABLE.has(p)) {
        problems.push(
          `rules[${i}]: derives '${p}', which the node or the token asserts -- ` +
            "a rule may not manufacture it",
        );
      }
    }
  });

  // The silent typo: a body predicate nothing supplies and no rule derives.
  const checkBody = (where: string, head: string, whole: string): void => {
    const body = whole.slice(head.length);
    for (const p of predicatesIn(body)) {
      if (!SUPPLIED.has(p) && !derivable.has(p)) {
        problems.push(
          `${where}: names predicate '${p}', which nothing asserts and no rule derives -- ` +
            `it can never hold, so this ${where.startsWith("rules") ? "rule" : "policy"} is dead`,
        );
      }
    }
  };
  rules.forEach((text, i) => {
    checkBody(`rules[${i}]`, heads[i] ?? "", text);
  });
  policies.forEach((text, i) => {
    checkBody(`policies[${i}]`, "", text);
  });

  // A-10 / X-02: a capability no rule can derive. Skipped when a rule derives
  // `capability` into a VARIABLE, since the set is then open by construction.
  const openCapabilities = heads.some((head) => /capability\(\s*\$/.test(head));
  const derivableCapabilities = new Set(heads.flatMap((head) => literalsOf("capability", head)));
  if (!openCapabilities) {
    const named = (where: string, text: string, skipHead: string): void => {
      for (const cap of literalsOf("capability", text.slice(skipHead.length))) {
        if (!derivableCapabilities.has(cap)) {
          problems.push(`${where}: names capability '${cap}', which no rule derives`);
        }
      }
    };
    rules.forEach((text, i) => {
      named(`rules[${i}]`, text, heads[i] ?? "");
    });
    policies.forEach((text, i) => {
      named(`policies[${i}]`, text, "");
    });
  }

  assertValid(problems);

  return Object.freeze({
    [BUILT]: true as const,
    version: defs.version ?? 1,
    rules: Object.freeze(rules),
    policies: Object.freeze(policies),
  });
}

/** Guards the seam `RuleSet`'s brand describes — see that interface. */
function assertBuilt(value: RuleSet): void {
  if (value?.[BUILT] !== true) {
    throw new RuleSetError([
      "a rule set must be built by ruleSet(), which validates it -- an object literal is not one",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Reading a rule set
// ---------------------------------------------------------------------------

/**
 * Every role name the rules mention, sorted.
 *
 * There is no role registry any more, so this IS the registry: a role exists
 * for this node exactly when some rule fires on it. Used to validate the roles
 * an invitation or a membership record names, and to populate an admin UI's
 * role list.
 */
export function roleNames(rules: RuleSet): string[] {
  return [...new Set(rules.rules.flatMap((r) => literalsOf("role", r)))].sort();
}

/** Every capability some rule can derive, sorted. Empty when derivation is open. */
export function capabilityNames(rules: RuleSet): string[] {
  return [
    ...new Set(rules.rules.flatMap((r) => literalsOf("capability", r.split("<-")[0] ?? ""))),
  ].sort();
}

/**
 * The capabilities `roles` derive through `rules` — the replacement for
 * `expandRoles`, and the same guarantee: an unknown role derives nothing,
 * because no rule fires for it (A-07). Version skew therefore degrades to
 * FEWER permissions, never more.
 */
export function deriveCapabilities(rules: RuleSet, roles: readonly string[]): Set<string> {
  assertBuilt(rules);
  warmUpTokens();
  const builder = new AuthorizerBuilder();
  for (const role of roles) {
    if (typeof role !== "string") continue; // never let a non-string reach wasm
    builder.addCodeWithParameters("role({role});", { role }, {});
  }
  addRules(builder, rules);
  const authorizer = builder.buildUnauthenticated();
  const facts = authorizer.queryWithLimits(Rule.fromString("held($c) <- capability($c)"), LIMITS);
  return new Set(
    facts
      .map((fact: { terms(): unknown[] }) => fact.terms()[0])
      .filter((term): term is string => typeof term === "string"),
  );
}

/** Roles named in an invitation or a membership record must be roles some rule knows. */
export function validateRoles(rules: RuleSet, roles: readonly string[], context: string): string[] {
  const known = new Set(roleNames(rules));
  return roles.filter((r) => !known.has(r)).map((r) => `${context}: unknown role '${r}'`);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** What the node knows about the request, and about itself. Never read from a token (A-04). */
export interface RequestFacts {
  operation: string;
  resource: string;
  selfPeer?: PeerIdStr;
  connectionPeer?: PeerIdStr;
  /** Milliseconds. Asserted as `time_ms` — see the module comment on Ruling 83. */
  now?: number;
}

export interface Decision {
  allowed: boolean;
  /** The policy that matched — the modern form of "which entry governed" (P8, A-06). */
  matched?: string;
  /** Every check that failed, as `authorizer check <id>: <rule>`. Usually empty. */
  failed: string[];
  /** Human-readable, for a response BODY. Never a header. */
  reason: string;
}

/**
 * Evaluate `rules` against one request.
 *
 * WHY THIS DOES NOT RE-VERIFY THE TOKEN. The binding middleware
 * (`peer-handlers.ts`) has already run `verifyToken`, which authorized the
 * token's OWN checks — binding, expiry, mesh, and any constraint this verifier
 * does not understand (A-20) — against an authority-scoped authorizer, and
 * cached the result. This is the second half: the node's own rules against
 * those verified claims. Splitting them is what keeps a tokenless request
 * decidable (a public policy still matches with no role facts at all) and what
 * keeps "no usable token" a 401 while "not permitted" is a 403.
 */
export function authorize(
  rules: RuleSet,
  facts: RequestFacts,
  claims: MeshClaims | null,
): Decision {
  assertBuilt(rules);
  warmUpTokens();

  const build = (extraCapability?: string) => {
    const builder = new AuthorizerBuilder();
    builder.addCodeWithParameters(
      "operation({operation}); resource({resource}); time_ms({now});",
      { operation: facts.operation, resource: facts.resource, now: facts.now ?? Date.now() },
      {},
    );
    if (facts.selfPeer != null) {
      builder.addCodeWithParameters("self_peer({peer});", { peer: facts.selfPeer }, {});
    }
    if (facts.connectionPeer != null) {
      builder.addCodeWithParameters("connection_peer({peer});", { peer: facts.connectionPeer }, {});
    }
    if (claims != null) {
      builder.addCodeWithParameters(
        "subject({sub}); mesh({mesh}); issued_at({iat}); expires_at({exp});",
        { sub: claims.sub, mesh: claims.mesh, iat: claims.iat, exp: claims.exp },
        {},
      );
      for (const role of claims.roles) {
        if (typeof role !== "string") continue;
        builder.addCodeWithParameters("role({role});", { role }, {});
      }
    }
    if (extraCapability != null) {
      builder.addCodeWithParameters("capability({cap});", { cap: extraCapability }, {});
    }
    addRules(builder, rules);
    // ONE addCode for the whole policy block, so the index `authorizeWithLimits`
    // returns indexes THIS array and the matched policy can be named (A-06).
    if (rules.policies.length > 0) {
      builder.addCode(`${rules.policies.join(";\n")};`);
    }
    return builder.buildUnauthenticated();
  };

  try {
    const index = build().authorizeWithLimits(LIMITS);
    const matched = rules.policies[index];
    return { allowed: true, matched, failed: [], reason: `allowed by policy: ${matched ?? ""}` };
  } catch (error) {
    return denial(rules, facts, error, build);
  }
}

function denial(
  rules: RuleSet,
  facts: RequestFacts,
  error: unknown,
  build: (extraCapability?: string) => { authorizeWithLimits(limits: unknown): number },
): Decision {
  if (hasKey(error, "RunLimit")) {
    // P9 / A-25: a pathological rule set denies instead of becoming a DoS.
    return {
      allowed: false,
      failed: [],
      reason: `evaluation budget exhausted (${String(error.RunLimit)})`,
    };
  }

  const unauthorized = hasKey(error, "FailedLogic")
    ? (error.FailedLogic as Record<string, unknown>)
    : undefined;
  const detail = unauthorized?.Unauthorized as
    | { policy?: { Deny?: number; Allow?: number }; checks?: unknown }
    | undefined;
  const failed = failedChecks(detail?.checks);

  const denyIndex = detail?.policy?.Deny;
  if (typeof denyIndex === "number") {
    const matched = rules.policies[denyIndex];
    return { allowed: false, matched, failed, reason: `denied by policy: ${matched ?? ""}` };
  }
  if (failed.length > 0) {
    return { allowed: false, failed, reason: `unsatisfied constraint: ${failed.join("; ")}` };
  }

  // NoMatchingPolicy: nothing allowed it. Biscuit reports no checks for this
  // case — there were none to fail — so on its own it is a bare boolean, which
  // A-06 forbids. THE SUFFICIENCY PROBE recovers the actionable half by
  // EVALUATION rather than by reading a structure: re-run the same decision
  // once per capability the rules can derive, and report the ones that would
  // have flipped it. That is the tree's `requires one of: ...` reconstructed
  // from what actually ran, and it is exact — each name reported is a
  // capability that was tried and did allow this very request. Only on the
  // denial path, and bounded, so a pathological rule set cannot make a denial
  // expensive.
  const candidates = capabilityNames(rules);
  if (candidates.length > 0 && candidates.length <= MAX_PROBED_CAPABILITIES) {
    const sufficient: string[] = [];
    for (const cap of candidates) {
      try {
        build(cap).authorizeWithLimits(LIMITS);
        sufficient.push(cap);
      } catch {
        /* this capability would not have helped */
      }
    }
    if (sufficient.length > 0) {
      return { allowed: false, failed, reason: `requires one of: ${sufficient.join(", ")}` };
    }
  }
  return {
    allowed: false,
    failed,
    reason: `no policy allows ${facts.operation} ${facts.resource}`,
  };
}

/**
 * The probe above costs one authorization per capability, on the denial path
 * only. A rule set with more capabilities than this gets the generic reason
 * rather than a denial that is slower than the request it refuses.
 */
const MAX_PROBED_CAPABILITIES = 64;

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

export interface PolicyInit {
  rules: RuleSet;
  usesTransportIdentity: UsesTransportIdentity;
  /** This peer's own id, asserted as `self_peer`. Optional; omitted, no policy can name it. */
  selfPeer?: PeerIdStr;
  /** Injected clock for `time_ms`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Policy as middleware — the seam `withAccessTree` occupied.
 *
 * BINDING OUTSIDE, POLICY INSIDE, unchanged: the claims read here come from
 * `lookupClaims`, which is populated by the binding middleware's `getClaims`
 * call. Reverse the nesting and every request looks tokenless.
 */
export function withPolicy(init: PolicyInit) {
  assertBuilt(init.rules);
  const now = init.now ?? Date.now;

  return (next: FetchHandler): FetchHandler =>
    async (req) => {
      if (await init.usesTransportIdentity(req)) return next(req);

      const { pathname } = new URL(req.url);
      const claims = (lookupClaims(req) ?? null) as MeshClaims | null;
      // What the TRANSPORT proved, not what the token said — the same source
      // `getClaims` fed to `verifyToken`'s binding check (A-04). `ANONYMOUS`
      // is a symbol and `undefined` is a lost binding; neither is a peerId, so
      // both assert no `connection_peer` at all.
      const peer = lookupPeer(req);
      const decision = authorize(
        init.rules,
        {
          operation: req.method,
          resource: pathname,
          selfPeer: init.selfPeer,
          connectionPeer: typeof peer === "string" ? peer : undefined,
          now: now(),
        },
        claims,
      );

      if (!decision.allowed) {
        // A caller with no usable token gets 401 rather than 403 — the same
        // mapping the tree made, and the distinction a client acts on: fetch a
        // token, versus stop asking.
        //
        // UNREACHABLE IN A COMPOSED PEER, and deliberately kept anyway. The
        // binding middleware sits OUTSIDE this (see `peer.ts`) and already
        // refuses both an absent and a refused token, with the finer status
        // split Task 34 added; by the time policy runs, claims are either
        // verified or the request was a bootstrap that returned above. This
        // branch is the fallback for `withPolicy` used standalone, where
        // nothing has looked a token up at all — which is why it says only
        // "required" and does not try to say why: `lookupClaims` reports
        // usable claims, and a policy has no business distinguishing the two
        // unusable states.
        if (claims == null) return json({ error: "membership token required" }, 401);
        return json({ error: decision.reason }, 403);
      }
      return next(req);
    };
}

// ---------------------------------------------------------------------------
// There is no DEFAULT_RULES here, and that is deliberate
// ---------------------------------------------------------------------------
//
// The prototype exported one. It derived `std:mesh.read`, `std:presence.write`,
// `std:test` and `std:mesh.admin`, and — crucially — NO `app:` capability at
// all, because it existed to serve the demo's `/test` mount. Every caller that
// met it assumed it was a sensible starting point, mounted an application
// under it, and got a permanent silent denial: no rule fires for an `app:`
// capability, so nothing is derived, so the policy refuses.
//
// A default that is wrong for every real use is worse than no default,
// because it is reached for first. `rules` is a parameter now (spec §5), and
// a caller that wants the demo's policy writes six lines of `ruleSet({...})`
// and can see what they say.

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function addRules(builder: AuthorizerBuilder, rules: RuleSet): void {
  if (rules.rules.length > 0) builder.addCode(`${rules.rules.join(";\n")};`);
}

/** `Rule`/`Policy.fromString` reject a trailing `;`, but every authored line has one. */
function trimStatement(source: string): string {
  return String(source).trim().replace(/;\s*$/, "").trim();
}

function parseProblem(text: string, error: unknown): string {
  const language = (error as { Language?: { ParseError?: { errors?: unknown } } })?.Language;
  const errors = language?.ParseError?.errors;
  const first = Array.isArray(errors) ? (errors[0] as { message?: string; input?: string }) : null;
  const detail = first?.message ?? first?.input ?? String(error);
  return `does not parse (${detail}) in: ${text}`;
}

/**
 * Every predicate name in a fragment of canonical Datalog.
 *
 * A predicate is an identifier immediately followed by `(`. The negative
 * lookbehind on `.` is what keeps `$r.starts_with("/x")` — an expression on a
 * term, not a fact — out of the result.
 */
function predicatesIn(text: string): string[] {
  return [...text.matchAll(/(?<![.\w$])([a-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1] as string);
}

/** Every string literal appearing as the sole argument of `<predicate>("...")`. */
function literalsOf(predicate: string, text: string): string[] {
  const pattern = new RegExp(`${predicate}\\(\\s*"([^"]*)"\\s*\\)`, "g");
  return [...text.matchAll(pattern)].map((m) => m[1] as string);
}

function failedChecks(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((check: unknown) => {
    if (hasKey(check, "Authorizer")) {
      const auth = check.Authorizer as { check_id: number; rule: string };
      return `authorizer check ${auth.check_id}: ${auth.rule}`;
    }
    if (hasKey(check, "Block")) {
      const block = check.Block as { block_id: number; check_id: number; rule: string };
      return `block ${block.block_id} check ${block.check_id}: ${block.rule}`;
    }
    return JSON.stringify(check);
  });
}

function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

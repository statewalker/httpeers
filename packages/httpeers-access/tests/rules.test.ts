/**
 * The node's rules and policies, in Datalog (ADR-0019, spec §6.4-6.5).
 *
 * Replaces `access-tree.test.ts` (33 cases) and `vocabulary.test.ts` (17).
 * ADR-0019 is explicit that those two mechanisms stop shipping while their
 * PROPERTIES remain requirements, so this file is organised by property
 * rather than by function: deny by default, no privilege creep, an unknown
 * role granting nothing, an unknown constraint denying, and explainable
 * denials. The equivalence table at the bottom is the same eleven decisions
 * `access-tree.test.ts` asserted about `DEFAULT_ACCESS_TREE`, now asserted
 * about `DEMO_RULES` — that is the evidence the swap changed no decision.
 *
 * What is NOT carried over is what tested a mechanism rather than a property:
 * the ancestor walk, `/x` vs `/x/` canonicalization and the duplicate-key
 * refusal have no referent once there are no keys. What those keys EXPRESSED
 * is carried over and tested here without them — per-method policy, a deeper
 * path more open than the one above it, and an explicit deny beating a
 * granting ancestor (which is now A-05's deny-beats-allow).
 *
 * Three properties are proved END TO END, through a real token, rather than
 * against claims handed in by the test: "an appended block cannot grant a
 * role" (with its control), "the node's facts are never taken from the token"
 * and "an unknown constraint denies". `tokens.test.ts` proves the first and
 * last at the token layer; what is proved here is that the POLICY layer
 * inherits them — that a forged role never reaches a policy, and that a token
 * carrying a constraint this verifier cannot satisfy never produces claims for
 * a policy to consider.
 */
import { Biscuit, BlockBuilder, PublicKey, SignatureAlgorithm } from "@biscuit-auth/biscuit-wasm";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { MeshClaims } from "@statewalker/httpeers-core";
import { cacheClaims } from "@statewalker/httpeers-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authorize,
  capabilityNames,
  deriveCapabilities,
  RuleSetError,
  roleNames,
  ruleSet,
  validateRoles,
  withPolicy,
} from "../src/rules.js";
import type { Signer } from "../src/signer.js";
import { mintToken, TokenVerificationError, verifyToken } from "../src/tokens.js";

/**
 * The policy that used to ship as `DEMO_RULES`, kept here as TEST DATA —
 * which is all it ever was.
 *
 * It was dropped from the package (spec §5) because it derives no `app:`
 * capability at all: it existed for the demo's `/test` mount, and every caller
 * who reached for it as a sensible starting point mounted an application under
 * it and got a permanent silent denial. A default that is wrong for every real
 * use is worse than no default.
 *
 * Every assertion below is unchanged, so the equivalence these tests establish
 * — decision for decision against the `DEFAULT_ACCESS_TREE` + `DEFAULT_VOCABULARY`
 * pair this rule set replaced — still holds. What changed is that the policy is
 * now written where it is used instead of exported as advice.
 */
const DEMO_RULES = ruleSet({
  version: 1,
  rules: [
    'capability("std:mesh.read")      <- role("member");',
    'capability("std:presence.write") <- role("member");',
    'capability("std:test")           <- role("member");',
    'capability("std:mesh.admin")     <- role("admin");',
    'role("member")                   <- role("admin");',
    'role("member")                   <- role("hidden");',
  ],
  policies: [
    'allow if capability("std:mesh.read"), resource("/.well-known")' +
      ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
    'allow if capability("std:test"), resource("/test")' +
      ' or capability("std:test"), resource($r), $r.starts_with("/test/");',
    'allow if capability("std:mesh.admin"), resource("/admin")' +
      ' or capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
  ],
});

const claims = (...roles: string[]): MeshClaims => ({
  sub: "peerA",
  iss: "hub",
  mesh: "hub",
  roles,
  iat: 1_000,
  exp: 1_000_000,
  // Node POLICY never reads the audience: it is enforced by the token's own
  // check at verification time, against the destination's `self_peer`
  // (ADR-0020), so by the time `authorize` sees claims the question is
  // settled. Stated, not defaulted -- `MeshClaims` has three explicit states.
  audience: "unrestricted",
});
const member = claims("member");
const admin = claims("admin");

const decide = (
  rules: Parameters<typeof authorize>[0],
  path: string,
  who: MeshClaims | null,
  method = "GET",
) => authorize(rules, { operation: method, resource: path, now: 2_000 }, who);

// ---------------------------------------------------------------------------
// P3 — deny by default
// ---------------------------------------------------------------------------

describe("deny by default", () => {
  it("a rule set with no policies denies everything", () => {
    const rules = ruleSet({});
    expect(decide(rules, "/anything", admin).allowed).toBe(false);
  });

  it("a resource no policy names is denied even for an admin", () => {
    expect(decide(DEMO_RULES, "/nothing/here", admin).allowed).toBe(false);
  });

  it("nothing grants DELETE, so nothing permits it -- there is no entry to write", () => {
    // Prototype 10's T10-04. The tree needed an explicit `{ anyOf: [] }` to say
    // this; Datalog says it by saying nothing.
    const rules = ruleSet({
      rules: ['capability("app:notes.read") <- role("member");'],
      policies: [
        'allow if capability("app:notes.read"), operation("GET"), resource($r), $r.starts_with("/notes/");',
      ],
    });
    expect(decide(rules, "/notes/x", member, "GET").allowed).toBe(true);
    expect(decide(rules, "/notes/x", member, "DELETE").allowed).toBe(false);
  });

  it("a deny policy beats an allow that also matches, whatever order they were written in (A-05)", () => {
    // `ruleSet()` emits every deny before every allow, because Biscuit takes
    // the FIRST matching policy and an allow written above a deny would win.
    const rules = ruleSet({
      policies: ['allow if resource($r), $r.starts_with("/x");', 'deny if resource("/x/secret");'],
    });
    expect(rules.policies[0]?.startsWith("deny")).toBe(true);
    expect(decide(rules, "/x/public", member).allowed).toBe(true);
    expect(decide(rules, "/x/secret", member).allowed).toBe(false);
    expect(decide(rules, "/x/secret", member).reason).toMatch(/^denied by policy: deny if/);
  });
});

// ---------------------------------------------------------------------------
// What the tree could express, and what it needed a second mechanism for
// ---------------------------------------------------------------------------

describe("per-method policy, without a per-method mechanism", () => {
  // The tree needed a `methods` sub-entry that replaced its directory entry
  // wholesale. `operation` is an ordinary fact, so this is one more term in an
  // ordinary policy — the mechanism that already existed.
  const rules = ruleSet({
    rules: [
      'capability("std:mesh.read") <- role("member");',
      'capability("std:mesh.admin") <- role("admin");',
      'role("member") <- role("admin");',
    ],
    policies: [
      'allow if capability("std:mesh.read"), operation("GET"), resource($r), $r.starts_with("/notes/");',
      'allow if capability("std:mesh.admin"), operation("PUT"), resource($r), $r.starts_with("/notes/");',
    ],
  });

  it("read is allowed to members, write only to admins", () => {
    expect(decide(rules, "/notes/x", member, "GET").allowed).toBe(true);
    expect(decide(rules, "/notes/x", member, "PUT").allowed).toBe(false);
    expect(decide(rules, "/notes/x", admin, "PUT").allowed).toBe(true);
  });

  it("a method nothing names is denied, with no entry saying so", () => {
    expect(decide(rules, "/notes/x", admin, "DELETE").allowed).toBe(false);
  });
});

describe("a deeper path may be MORE open than the one above it", () => {
  // The tree called this "deeper-may-widen" and got it from its walk order.
  // Here it is two policies, and neither has to know about the other.
  const rules = ruleSet({
    rules: ['capability("std:mesh.read") <- role("member");'],
    policies: [
      'allow if capability("std:mesh.read"), resource($r), $r.starts_with("/docs/");',
      'allow if resource($r), $r.starts_with("/docs/public/");',
    ],
  });

  it("grants the open subtree to a caller with no claims at all, and still gates its parent", () => {
    expect(decide(rules, "/docs/public/index.html", null).allowed).toBe(true);
    expect(decide(rules, "/docs/readme", null).allowed).toBe(false);
    expect(decide(rules, "/docs/readme", member).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capability derivation — the vocabulary, as rules
// ---------------------------------------------------------------------------

describe("capability derivation", () => {
  it("a role confers the capabilities its rules derive", () => {
    expect([...deriveCapabilities(DEMO_RULES, ["member"])].sort()).toEqual([
      "std:mesh.read",
      "std:presence.write",
      "std:test",
    ]);
  });

  it("implication is transitive, and transitivity is just what a rule does", () => {
    // `role("member") <- role("admin")` is one mechanism, not a second one
    // beside capability derivation. The old vocabulary needed `implies` for
    // this and a transitive expander to resolve it.
    const caps = deriveCapabilities(DEMO_RULES, ["admin"]);
    expect(caps.has("std:mesh.admin")).toBe(true);
    expect(caps.has("std:mesh.read")).toBe(true);
  });

  it("several roles union their capabilities", () => {
    expect(deriveCapabilities(DEMO_RULES, ["member", "admin"]).has("std:mesh.admin")).toBe(true);
  });

  it("an unknown role derives NOTHING, because no rule fires for it (A-07)", () => {
    // Never a fallback. Version skew degrades to FEWER permissions, never more,
    // which is what makes a rolling policy update safe.
    expect([...deriveCapabilities(DEMO_RULES, ["nonesuch"])]).toEqual([]);
  });

  it("a cycle terminates rather than hanging", () => {
    const rules = ruleSet({
      rules: [
        'capability("x:a") <- role("a");',
        'capability("x:b") <- role("b");',
        'role("a") <- role("b");',
        'role("b") <- role("a");',
      ],
    });
    expect([...deriveCapabilities(rules, ["a"])].sort()).toEqual(["x:a", "x:b"]);
  });

  it("roleNames and capabilityNames read the registry off the rules themselves", () => {
    // There is no separate vocabulary document any more: a role exists for this
    // node exactly when some rule fires on it.
    expect(roleNames(DEMO_RULES)).toEqual(["admin", "hidden", "member"]);
    expect(capabilityNames(DEMO_RULES)).toEqual([
      "std:mesh.admin",
      "std:mesh.read",
      "std:presence.write",
      "std:test",
    ]);
  });

  it("catches an unknown role in an invitation", () => {
    expect(validateRoles(DEMO_RULES, ["member", "admni"], "invitation CODE-A")[0]).toMatch(
      /invitation CODE-A: unknown role 'admni'/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fail fast, not closed — the guard that replaces the tree's construction check
// ---------------------------------------------------------------------------

describe("fail fast, not closed", () => {
  it("refuses a policy naming a capability no rule derives (A-10, X-02)", () => {
    // The tree's `undeclared capability` check, unchanged in purpose: a policy
    // that can never fire is a permanent denial that looks exactly like a
    // working one.
    expect(() =>
      ruleSet({
        rules: ['capability("app:read") <- role("member");'],
        policies: ['allow if capability("app:raed");'],
      }),
    ).toThrow(/names capability 'app:raed', which no rule derives/);
  });

  it("refuses a rule body naming a predicate nothing asserts and no rule derives", () => {
    // THE DATALOG FORM OF THE SAME MISTAKE, and the one the tree had no
    // equivalent of: `rolle` is not a typo the language complains about, it is
    // simply a predicate that never holds, so the rule never fires and every
    // request is denied forever with no error anywhere.
    expect(() =>
      ruleSet({
        rules: ['capability("app:read") <- rolle("member");'],
        policies: ['allow if capability("app:read");'],
      }),
    ).toThrow(/names predicate 'rolle', which nothing asserts and no rule derives/);
  });

  it("refuses a rule ported from prototype 10 that asserts a DATE-valued time (Ruling 83)", () => {
    // Biscuit's date terms are RFC3339 SECONDS. `revocation.ts` orders `iat`
    // against `changedAt` at MILLISECOND resolution and `createMonotonicClock`
    // exists because a same-millisecond tie there was a real revocation bypass.
    // The verifier therefore supplies `time_ms` and never `time`, so a rule
    // ported verbatim is refused BY NAME at construction rather than silently
    // comparing two different notions of time.
    expect(() => ruleSet({ policies: ["allow if time($t), $t < 2026-08-22T00:00:00Z;"] })).toThrow(
      /names predicate 'time', which nothing asserts/,
    );
    expect(() => ruleSet({ policies: ["allow if time_ms($t), $t < 100;"] })).not.toThrow();
  });

  it("refuses a rule that derives a fact the node or the token asserts", () => {
    // A rule deriving `connection_peer` could manufacture the very input the
    // binding is tested against.
    expect(() => ruleSet({ rules: ['connection_peer("me") <- role("member");'] })).toThrow(
      /derives 'connection_peer', which the node or the token asserts/,
    );
  });

  it("refuses a policy smuggled into `rules`, and a rule smuggled into `policies`", () => {
    // Not pedantry: `ruleSet()` orders every deny before every allow, and a
    // policy added as a rule would sit outside that ordering.
    expect(() => ruleSet({ rules: ["allow if true;"] })).toThrow(/rules\[0\]: does not parse/);
    expect(() => ruleSet({ policies: ['capability("a") <- role("b");'] })).toThrow(
      /policies\[0\]: does not parse/,
    );
  });

  it("refuses Datalog that does not parse, instead of throwing on every request", () => {
    expect(() => ruleSet({ policies: ['allow if resource($r), $r.starts_with("/x"'] })).toThrow(
      RuleSetError,
    );
  });

  it("the error names EVERY problem, not just the first", () => {
    try {
      ruleSet({
        rules: ['capability("app:a") <- nope("x");'],
        policies: ['allow if capability("app:zzz");', "allow if alsonope(true);"],
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RuleSetError);
      expect((error as RuleSetError).problems).toHaveLength(3);
    }
  });

  it("a valid rule set builds cleanly, and an empty one is valid", () => {
    expect(() => ruleSet({})).not.toThrow();
    expect(() =>
      ruleSet({ rules: DEMO_RULES.rules, policies: ['allow if capability("std:test");'] }),
    ).not.toThrow();
  });

  it("`authorize` refuses a rule set ruleSet() never built", () => {
    const forged = { version: 1, rules: [], policies: [] } as unknown as typeof DEMO_RULES;
    expect(() => decide(forged, "/x", member)).toThrow(/must be built by ruleSet\(\)/);
  });
});

// ---------------------------------------------------------------------------
// P8 — a denial is attributable, and an allow names the policy that matched
// ---------------------------------------------------------------------------

describe("explainable decisions (A-06)", () => {
  const rules = ruleSet({
    rules: [
      'capability("std:mesh.admin") <- role("admin");',
      'capability("std:test") <- role("member");',
    ],
    policies: [
      'allow if capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
      'allow if capability("std:test"), resource($r), $r.starts_with("/test/");',
    ],
  });

  it("an allow names the policy that matched", () => {
    const d = decide(rules, "/admin/x", admin);
    expect(d.allowed).toBe(true);
    expect(d.matched).toMatch(/capability\("std:mesh\.admin"\)/);
  });

  it("a denial names the capabilities that would have sufficed", () => {
    // Biscuit reports NOTHING for a no-matching-policy denial — there were no
    // checks to fail — so on its own it is the bare boolean A-06 forbids. The
    // sufficiency probe recovers the actionable half BY EVALUATION: re-run the
    // same decision once per derivable capability and report the ones that
    // flip it. Every name reported was tried and did allow this very request.
    const d = decide(rules, "/admin/x", member);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("requires one of: std:mesh.admin");
  });

  it("... and says so plainly when no capability would have helped", () => {
    const d = decide(rules, "/nothing/here", admin);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no policy allows GET /nothing/here");
  });

  it("a deny policy is named verbatim", () => {
    const denying = ruleSet({
      policies: ['allow if resource($r), $r.starts_with("/x");', 'deny if operation("DELETE");'],
    });
    expect(decide(denying, "/x/y", member, "DELETE").reason).toBe(
      'denied by policy: deny if operation("DELETE")',
    );
  });
});

// ---------------------------------------------------------------------------
// P9 / A-25 — evaluation is bounded
// ---------------------------------------------------------------------------

describe("the evaluation budget", () => {
  it("a rule set that explodes combinatorially denies rather than hanging", () => {
    const rules = ruleSet({
      rules: [
        ...Array.from({ length: 120 }, (_, i) => `item("i${i}") <- role("member");`),
        "pair($a, $b) <- item($a), item($b);",
        'capability("app:x") <- pair($a, $b);',
      ],
      policies: ['allow if capability("app:x");'],
    });
    const d = decide(rules, "/x", member);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/evaluation budget exhausted/);
  });
});

// ---------------------------------------------------------------------------
// Segment boundaries — the one place a naive port would have WIDENED
// ---------------------------------------------------------------------------

describe("a policy governs its own path and its subtree, and nothing else", () => {
  it("does not leak to a sibling that merely shares a prefix", () => {
    // `$r.starts_with("/test")` alone would also match `/testing`, which the
    // tree's `/test/` key did not. The `or` variant is the idiom that does not.
    expect(decide(DEMO_RULES, "/test", member).allowed).toBe(true);
    expect(decide(DEMO_RULES, "/test/whoami", member).allowed).toBe(true);
    expect(decide(DEMO_RULES, "/test/deeply/nested", member).allowed).toBe(true);
    expect(decide(DEMO_RULES, "/testing", member).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

describe("withPolicy as middleware", () => {
  const rules = ruleSet({
    rules: [
      'capability("std:mesh.read") <- role("member");',
      'capability("std:mesh.admin") <- role("admin");',
      'role("member") <- role("admin");',
    ],
    policies: [
      'allow if capability("std:mesh.read"), resource($r), $r.starts_with("/notes/");',
      'allow if capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
      // "public": a policy that names no capability at all.
      'allow if resource($r), $r.starts_with("/pub/");',
    ],
  });

  function subject(usesTransportIdentity: () => boolean = () => false) {
    let reached = false;
    const handler = withPolicy({
      rules,
      usesTransportIdentity: async () => usesTransportIdentity(),
    })(async () => {
      reached = true;
      return new Response("ok");
    });
    return { handler, reached: () => reached };
  }

  it("bypasses policy entirely on a bootstrap (transport-identity) request", async () => {
    const s = subject(() => true);
    const res = await s.handler(new Request("http://peer/admin/x"));
    expect(res.status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("admits when the cached claims derive the required capability", async () => {
    const s = subject();
    const req = new Request("http://peer/notes/x");
    cacheClaims(req, { status: "verified", claims: member });
    expect((await s.handler(req)).status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("denies with 403 and the sufficiency reason when claims are present but insufficient", async () => {
    const s = subject();
    const req = new Request("http://peer/admin/x");
    cacheClaims(req, { status: "verified", claims: member });
    const res = await s.handler(req);
    expect(res.status).toBe(403);
    expect(s.reached()).toBe(false);
    expect(await res.json()).toEqual({ error: "requires one of: std:mesh.admin" });
  });

  it("denies with 401 when no claims were ever cached for a path that requires them", async () => {
    const s = subject();
    const res = await s.handler(new Request("http://peer/notes/x"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "membership token required" });
  });

  it("admits a policy that names no capability, with no claims cached at all", async () => {
    const s = subject();
    expect((await s.handler(new Request("http://peer/pub/x"))).status).toBe(200);
    expect(s.reached()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through a real token: the two properties the policy layer INHERITS
// ---------------------------------------------------------------------------

describe("end to end, through a real token", () => {
  let hubKey: Ed25519PrivateKey;
  let hubSigner: Signer;
  let hubPeerId: string;
  const MEMBER = "12D3KooWMemberPeerIdForTests";
  const now = () => 1_000_000;

  const rules = ruleSet({
    rules: ['capability("std:mesh.admin") <- role("admin");'],
    policies: ['allow if capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");'],
  });

  beforeAll(async () => {
    hubKey = await generateKeyPair("Ed25519");
    hubSigner = { mesh: peerIdFromPrivateKey(hubKey).toString(), seed: hubKey.raw.slice(0, 32) };
    hubPeerId = peerIdFromPrivateKey(hubKey).toString();
  });

  const rootKey = () => PublicKey.fromBytes(hubKey.publicKey.raw, SignatureAlgorithm.Ed25519);

  /** What any peer holding the token bytes can do — Biscuit's next-key travels with the token. */
  const appendBlock = (token: string, code: string): string => {
    const block = new BlockBuilder();
    block.addCode(code);
    return Biscuit.fromBase64(token, rootKey()).appendBlock(block).toBase64();
  };

  it("an appended block cannot grant a role, so it cannot reach a policy either (A-23)", async () => {
    const token = await mintToken({
      signer: hubSigner,
      sub: MEMBER,
      roles: [],
      ttlMs: 60_000,
      now,
    });
    const forged = appendBlock(token, 'role("admin");');

    const verified = await verifyToken(forged, {
      issuer: hubPeerId,
      connectionPeer: MEMBER,
      now,
    });
    const d = authorize(rules, { operation: "GET", resource: "/admin/x", now: now() }, verified);

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("requires one of: std:mesh.admin");
  });

  it("... and THE CONTROL: the very same policy DOES match when the hub granted the role", async () => {
    // Without this pair the assertion above proves nothing — a denial is also
    // what a policy that can NEVER match looks like. Prototype 10's T10-12b.
    // Same policy, same authorizer; the only difference is WHICH BLOCK carries
    // `role("admin")`.
    const token = await mintToken({
      signer: hubSigner,
      sub: MEMBER,
      roles: ["admin"],
      ttlMs: 60_000,
      now,
    });

    const verified = await verifyToken(token, { issuer: hubPeerId, connectionPeer: MEMBER, now });
    const d = authorize(rules, { operation: "GET", resource: "/admin/x", now: now() }, verified);

    expect(d.allowed).toBe(true);
    expect(d.matched).toMatch(/std:mesh\.admin/);
  });

  it("the node's own facts are never taken from the token (A-04)", async () => {
    // `authorize` builds an UNAUTHENTICATED authorizer: the only thing that
    // crosses from the token is `MeshClaims`, so `resource` and `operation`
    // are the node's, structurally, and a token that asserts its own cannot be
    // believed even in principle.
    const token = await mintToken({
      signer: hubSigner,
      sub: MEMBER,
      roles: ["admin"],
      ttlMs: 60_000,
      now,
    });
    const lying = appendBlock(token, 'resource("/admin/x"); operation("GET");');

    const verified = await verifyToken(lying, { issuer: hubPeerId, connectionPeer: MEMBER, now });
    const d = authorize(
      rules,
      { operation: "GET", resource: "/nothing/here", now: now() },
      verified,
    );

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no policy allows GET /nothing/here");
  });

  it("a constraint this verifier has never heard of DENIES -- no claims ever reach a policy (A-20)", async () => {
    // The fail-closed direction, and the easy one to get backwards: an unknown
    // constraint must refuse, not be ignored. It never becomes a policy
    // question at all, because verification produces no claims.
    const token = await mintToken({
      signer: hubSigner,
      sub: MEMBER,
      roles: ["admin"],
      ttlMs: 60_000,
      now,
    });
    const narrowed = appendBlock(token, "check if quantum_safe(true);");

    await expect(
      verifyToken(narrowed, { issuer: hubPeerId, connectionPeer: MEMBER, now }),
    ).rejects.toBeInstanceOf(TokenVerificationError);

    // ... and with no claims, the policy layer denies, and says which kind of
    // failure it was: no usable token, not an insufficient one.
    const handler = withPolicy({ rules, usesTransportIdentity: async () => false })(
      async () => new Response("ok"),
    );
    const res = await handler(new Request("http://peer/admin/x"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Equivalence with the `.access` tree it replaces
// ---------------------------------------------------------------------------

describe("equivalence with DEFAULT_ACCESS_TREE + DEFAULT_VOCABULARY", () => {
  // The same eleven decisions `access-tree.test.ts` asserted, unchanged. This
  // is the acceptance criterion for the swap: ADR-0019 replaced the MECHANISM,
  // and these are the decisions that must not have moved with it.
  const cases: Array<[string, MeshClaims | null, boolean]> = [
    ["/.well-known/mesh", member, true],
    ["/.well-known/mesh", admin, true],
    ["/.well-known/mesh", null, false],
    ["/.well-known/capabilities", member, true],
    ["/test/whoami", member, true],
    ["/test/echo", admin, true],
    ["/test/whoami", null, false],
    ["/admin/invitations", admin, true],
    ["/admin/invitations", member, false],
    ["/nothing/here", admin, false],
    ["/nothing/here", member, false],
  ];

  for (const [path, who, expected] of cases) {
    const label = who == null ? "anonymous" : who.roles.join("+");
    it(`${path} for ${label} -> ${expected ? "allow" : "deny"}`, () => {
      expect(decide(DEMO_RULES, path, who).allowed).toBe(expected);
    });
  }
});

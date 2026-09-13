/**
 * A-2: revocation as a pulled, cached deny list.
 *
 * Unit-only: the registry and the cache, no network, no clock. Assembled-peer
 * end-to-end coverage (the heartbeat's version vector, "fetch only when the
 * policy version moves", offline enforcement, downgrade-without-lockout) is
 * exercised once `peer.ts` exists — see the report for why that is out of
 * scope here.
 */
import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../src/revocation.js";
import { RevocationCache, RevocationRegistry } from "../src/revocation.js";

describe("A-2 unit: registry", () => {
  it("revocation is a role change to the empty set", () => {
    const now = 1000;
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000, now: () => now });
    r.revoke("peerA");
    expect(r.list()).toEqual([{ peerId: "peerA", changedAt: 1000, roles: [] }]);
  });

  it("bumps the policy version on every change", () => {
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000 });
    const v0 = r.policyVersion();
    r.revoke("a");
    r.changeRoles("b", ["member"]);
    expect(r.policyVersion()).toBeGreaterThan(v0 + 1);
  });

  it("is self-pruning past the token lifetime", () => {
    let now = 1000;
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000, now: () => now });
    r.revoke("a");
    now += 5_000;
    expect(r.list()).toHaveLength(1); // still inside the horizon
    now += 10_000;
    expect(r.list()).toHaveLength(0); // no live token could be affected
  });

  it("pruning does NOT bump the version", () => {
    let now = 1000;
    const r = new RevocationRegistry({ maxTokenTtlMs: 1_000, now: () => now });
    r.revoke("a");
    const v = r.policyVersion();
    now += 5_000;
    r.prune();
    expect(r.policyVersion()).toBe(v);
  });
});

/**
 * `RevocationRegistry.check` — added so a peer that OWNS the registry (the
 * hub itself) can enforce revocation on its own endpoints directly, with no
 * cache and nothing to pull (see `revocation.ts`'s module comment). Same
 * decision logic as `RevocationCache.check` below, checked here against the
 * registry's own live entries instead of a fetched snapshot.
 */
describe("A-2 unit: registry.check — the hub checking itself, no cache", () => {
  it("accepts a token minted AFTER the change — re-admission works", () => {
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000, now: () => 1000 });
    r.revoke("a");
    expect(r.check({ sub: "a", iat: 1500 })).toBeNull();
  });

  it("refuses a token minted BEFORE the change", () => {
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000, now: () => 1000 });
    r.revoke("a");
    expect(r.check({ sub: "a", iat: 500 })).toMatch(/revoked/);
  });

  it("distinguishes a role change from a revocation", () => {
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000, now: () => 1000 });
    r.changeRoles("a", ["member"]);
    expect(r.check({ sub: "a", iat: 500 })).toMatch(/roles changed/);
  });

  it("ignores peers with no entry", () => {
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000 });
    r.revoke("a");
    expect(r.check({ sub: "b", iat: 1 })).toBeNull();
  });

  it("is live, not a snapshot: a change made after construction is seen immediately, no update() call needed", () => {
    const r = new RevocationRegistry({ maxTokenTtlMs: 10_000, now: () => 1000 });
    expect(r.check({ sub: "a", iat: 500 })).toBeNull(); // no entry yet: accepted
    r.revoke("a"); // changedAt = 1000, later than iat = 500
    expect(r.check({ sub: "a", iat: 500 })).toMatch(/revoked/); // seen on the very next call
  });
});

describe("A-2 unit: cache", () => {
  const cache = (
    entries: ChangeEntry[],
    opts: { maxStalenessMs?: number; now?: () => number } = {},
  ) => {
    const c = new RevocationCache(opts);
    c.update(1, entries);
    return c;
  };

  it("accepts a token minted AFTER the change — re-admission works", () => {
    const c = cache([{ peerId: "a", changedAt: 1000, roles: [] }]);
    expect(c.check({ sub: "a", iat: 1500 })).toBeNull();
  });

  it("refuses a token minted BEFORE the change", () => {
    const c = cache([{ peerId: "a", changedAt: 1000, roles: [] }]);
    expect(c.check({ sub: "a", iat: 500 })).toMatch(/revoked/);
  });

  it("distinguishes a role change from a revocation", () => {
    const c = cache([{ peerId: "a", changedAt: 1000, roles: ["member"] }]);
    expect(c.check({ sub: "a", iat: 500 })).toMatch(/roles changed/);
  });

  it("ignores peers with no entry", () => {
    const c = cache([{ peerId: "a", changedAt: 1000, roles: [] }]);
    expect(c.check({ sub: "b", iat: 1 })).toBeNull();
  });

  it("refuses everything once the cache is stale", () => {
    let now = 1000;
    const c = new RevocationCache({ maxStalenessMs: 100, now: () => now });
    c.update(1, []);
    expect(c.check({ sub: "x", iat: 1 })).toBeNull();
    now += 500;
    expect(c.check({ sub: "x", iat: 1 })).toMatch(/stale/);
  });

  it("never expires when no staleness bound is set — deliberate and dangerous", () => {
    let now = 1000;
    const c = new RevocationCache({ now: () => now });
    c.update(1, []);
    now += 10 ** 9;
    expect(c.check({ sub: "x", iat: 1 })).toBeNull();
  });
});

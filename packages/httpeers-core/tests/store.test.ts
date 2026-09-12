import { describe, expect, it } from "vitest";
import { RULE_SET_BRAND, type RuleSet } from "../src/rule-set.js";
import { createAdvertisementStore, createMemberStore, createPresenceStore } from "../src/store.js";

/**
 * A minimal rule set mentioning exactly the role names these tests use — the
 * tests are about `MemberStore`'s own behaviour, not about policy content.
 * Since ADR-0019 a role "exists" for a node exactly when some rule fires on
 * it, so declaring the two roles means writing the two rules that read them.
 *
 * BUILT AS A LITERAL, not by `ruleSet()`, because `ruleSet()` canonicalises
 * through the Biscuit parser and lives in `@statewalker/httpeers-access`. That
 * costs this file nothing: the store reads a rule set only through
 * `validateRoles` → `roleNames`, which is a regex over the rule text, and
 * these rules are already in canonical form.
 *
 * What is therefore NOT covered here: that `ruleSet()` accepts these rules and
 * canonicalises them to exactly this text. That belongs to the builder, and is
 * tested beside it in `httpeers-access` (wave 2) — if the canonical form ever
 * diverges from what is written here, that is the test which must catch it.
 */
const TEST_RULES: RuleSet = {
  [RULE_SET_BRAND]: true,
  version: 1,
  rules: ['capability("x:read") <- role("read");', 'capability("x:write") <- role("write");'],
  policies: [],
};

describe("createMemberStore", () => {
  it("adds, reads, and lists members", () => {
    const store = createMemberStore(TEST_RULES, () => 100);

    const added = store.add("peer-a", ["read"]);

    expect(added).toEqual({ peerId: "peer-a", roles: ["read"], updatedAt: 100 });
    expect(store.get("peer-a")).toEqual(added);
    expect(store.list()).toEqual([added]);
  });

  it("replaces roles on setRoles, stamped with the current clock", () => {
    let time = 100;
    const store = createMemberStore(TEST_RULES, () => time);
    store.add("peer-a", ["read"]);

    time = 200;
    const updated = store.setRoles("peer-a", ["read", "write"]);

    expect(updated).toEqual({ peerId: "peer-a", roles: ["read", "write"], updatedAt: 200 });
    expect(store.get("peer-a")).toEqual(updated);
  });

  it("setRoles rejects a role no rule knows", () => {
    const store = createMemberStore(TEST_RULES, () => 100);
    store.add("peer-a", ["read"]);

    expect(() => store.setRoles("peer-a", ["superadmin"])).toThrow(/unknown role 'superadmin'/);
    // Rejected before the write: the stale roles are untouched.
    expect(store.get("peer-a")).toEqual({ peerId: "peer-a", roles: ["read"], updatedAt: 100 });
  });

  it("removes a member", () => {
    const store = createMemberStore(TEST_RULES);
    store.add("peer-a", ["read"]);

    store.remove("peer-a");

    expect(store.get("peer-a")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("is durable: membership does not expire on its own", () => {
    let time = 0;
    const store = createMemberStore(TEST_RULES, () => time);
    store.add("peer-a", ["read"]);

    time = 1_000_000_000;

    expect(store.get("peer-a")).toBeDefined();
  });
});

describe("createPresenceStore", () => {
  it("accepts a first heartbeat and reports presence", () => {
    const store = createPresenceStore(() => 1_000);

    const result = store.heartbeat("peer-a", 1, 5_000);

    expect(result).toEqual({
      accepted: true,
      record: { peerId: "peer-a", seq: 1, expiresAt: 6_000 },
    });
    expect(store.isPresent("peer-a")).toBe(true);
  });

  it("accepts a higher sequence number and refreshes the TTL", () => {
    let time = 1_000;
    const store = createPresenceStore(() => time);
    store.heartbeat("peer-a", 1, 5_000);

    time = 2_000;
    const result = store.heartbeat("peer-a", 2, 5_000);

    expect(result).toEqual({
      accepted: true,
      record: { peerId: "peer-a", seq: 2, expiresAt: 7_000 },
    });
  });

  it("rejects a write whose sequence is not greater than the stored one (monotonic, per peer)", () => {
    const store = createPresenceStore(() => 1_000);
    store.heartbeat("peer-a", 5, 5_000);

    const replay = store.heartbeat("peer-a", 5, 5_000); // exact replay
    const stale = store.heartbeat("peer-a", 3, 5_000); // delayed retry, older seq

    expect(replay).toEqual({ accepted: false, reason: "stale-sequence" });
    expect(stale).toEqual({ accepted: false, reason: "stale-sequence" });
    // the accepted record (seq 5) must survive both rejected writes
    expect(store.get("peer-a")).toMatchObject({ seq: 5 });
  });

  it("does not compare sequence numbers across different peers", () => {
    const store = createPresenceStore(() => 1_000);
    store.heartbeat("peer-a", 100, 5_000);

    // peer-b starts its own sequence at 1 — unrelated to peer-a's counter.
    const result = store.heartbeat("peer-b", 1, 5_000);

    expect(result.accepted).toBe(true);
  });

  it("a delayed retry cannot resurrect a peer that has since left", () => {
    const time = 1_000;
    const store = createPresenceStore(() => time);
    store.heartbeat("peer-a", 1, 5_000);
    store.heartbeat("peer-a", 2, 5_000); // peer-a's real, newer state

    // A stale retry of the first heartbeat, arriving late over the network.
    const stale = store.heartbeat("peer-a", 1, 5_000);

    expect(stale).toEqual({ accepted: false, reason: "stale-sequence" });
    expect(store.get("peer-a")).toMatchObject({ seq: 2 });
  });

  it("reports a peer absent once its TTL has passed", () => {
    let time = 1_000;
    const store = createPresenceStore(() => time);
    store.heartbeat("peer-a", 1, 5_000);

    time = 7_000; // past expiresAt (6_000)

    expect(store.isPresent("peer-a")).toBe(false);
  });

  it("sweep removes only expired records and returns their peerIds", () => {
    let time = 1_000;
    const store = createPresenceStore(() => time);
    store.heartbeat("peer-a", 1, 1_000); // expires at 2_000
    store.heartbeat("peer-b", 1, 10_000); // expires at 11_000

    time = 3_000;
    const removed = store.sweep();

    expect(removed).toEqual(["peer-a"]);
    expect(store.get("peer-a")).toBeUndefined();
    expect(store.get("peer-b")).toBeDefined();
  });
});

describe("createAdvertisementStore", () => {
  it("posts and lists an advertisement", () => {
    const store = createAdvertisementStore(() => 500);

    const ad = store.post("peer-a", "echo-service", { path: "/echo" });

    expect(ad).toEqual({
      peerId: "peer-a",
      key: "echo-service",
      payload: { path: "/echo" },
      postedAt: 500,
    });
    expect(store.get("peer-a", "echo-service")).toEqual(ad);
  });

  it("keys entries by (peerId, key), not by peerId alone", () => {
    const store = createAdvertisementStore(() => 0);
    store.post("peer-a", "echo-service", { v: 1 });
    store.post("peer-a", "other-service", { v: 2 });
    store.post("peer-b", "echo-service", { v: 3 });

    expect(store.list("peer-a")).toHaveLength(2);
    expect(store.list()).toHaveLength(3);
  });

  it("replacing an advertisement overwrites the prior one at the same key", () => {
    let time = 0;
    const store = createAdvertisementStore(() => time);
    store.post("peer-a", "echo-service", { v: 1 });

    time = 100;
    const replaced = store.post("peer-a", "echo-service", { v: 2 });

    expect(store.get("peer-a", "echo-service")).toEqual(replaced);
    expect(store.list("peer-a")).toHaveLength(1);
  });

  it("withdraws an advertisement", () => {
    const store = createAdvertisementStore();
    store.post("peer-a", "echo-service", {});

    store.withdraw("peer-a", "echo-service");

    expect(store.get("peer-a", "echo-service")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("does not expire entries on its own — it is a bulletin board, not TTL'd", () => {
    let time = 0;
    const store = createAdvertisementStore(() => time);
    store.post("peer-a", "echo-service", {});

    time = 1_000_000_000;

    expect(store.get("peer-a", "echo-service")).toBeDefined();
  });
});

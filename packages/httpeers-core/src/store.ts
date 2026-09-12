/**
 * The hub's three registries: members, presence, advertisements.
 *
 * All three are plain in-memory data structures with an injected clock
 * (`() => number`) so TTL and sequencing behaviour is deterministic under
 * test, with no real timers involved. Persistence is a later task's job —
 * nothing here touches the filesystem or a database.
 */

import type { RuleSet } from "./rule-set.js";
import { assertValid, validateRoles } from "./rule-set.js";
import type {
  Advertisement,
  AdvertisementStore,
  MemberRecord,
  MemberStore,
  PresenceRecord,
  PresenceStore,
  PresenceWriteResult,
} from "./types.js";

/**
 * Durable membership: who belongs to the mesh, and with what roles.
 *
 * `setRoles` validates its `roles` against `rules` before writing — "catch a
 * typo where it is made, not three hops later as a silent denial" (the v0.9.0
 * delta's own rationale). Since ADR-0019 there is no separate role registry to
 * validate against: a role exists for this node exactly when some rule fires
 * on it, which is what `validateRoles` reads. This is deliberately at the STORE,
 * not at whichever call site happens to reach `setRoles` today: a guard
 * placed at a call site is only as durable as that call site, and a later
 * one added without knowing the guard belongs here would ship an
 * unvalidated role write. `add` is NOT validated here — every caller that
 * feeds it caller-supplied roles (e.g. invitation redemption) validates
 * them earlier, at the point the roles were themselves accepted
 * (`InvitationStore.create` in `apps/httpeers-stack`), matching the
 * archived delta's own choice to guard `createInvitation` and `setRoles`,
 * never `addMember`.
 */
export function createMemberStore(rules: RuleSet, clock: () => number = Date.now): MemberStore {
  const members = new Map<string, MemberRecord>();

  return {
    add(peerId, roles) {
      const record: MemberRecord = { peerId, roles: [...roles], updatedAt: clock() };
      members.set(peerId, record);
      return record;
    },
    setRoles(peerId, roles) {
      assertValid(validateRoles(rules, roles, `setRoles(${peerId})`));
      const record: MemberRecord = { peerId, roles: [...roles], updatedAt: clock() };
      members.set(peerId, record);
      return record;
    },
    remove(peerId) {
      members.delete(peerId);
    },
    get(peerId) {
      return members.get(peerId);
    },
    list() {
      return [...members.values()];
    },
  };
}

/**
 * TTL'd, swept presence: who is live right now.
 *
 * Writes are monotonic per peer — see `PresenceStore` in types.ts for why.
 * The comparison is always `seq` against the peer's own last-accepted
 * `seq`, never wall-clock time and never across different peers.
 */
export function createPresenceStore(clock: () => number = Date.now): PresenceStore {
  const presence = new Map<string, PresenceRecord>();

  return {
    heartbeat(peerId, seq, ttlMs): PresenceWriteResult {
      const existing = presence.get(peerId);
      if (existing !== undefined && seq <= existing.seq) {
        return { accepted: false, reason: "stale-sequence" };
      }
      const record: PresenceRecord = { peerId, seq, expiresAt: clock() + ttlMs };
      presence.set(peerId, record);
      return { accepted: true, record };
    },
    isPresent(peerId) {
      const record = presence.get(peerId);
      return record !== undefined && record.expiresAt > clock();
    },
    get(peerId) {
      return presence.get(peerId);
    },
    list() {
      return [...presence.values()];
    },
    sweep() {
      const now = clock();
      const expired: string[] = [];
      for (const record of presence.values()) {
        if (record.expiresAt <= now) {
          expired.push(record.peerId);
        }
      }
      for (const peerId of expired) {
        presence.delete(peerId);
      }
      return expired;
    },
  };
}

/**
 * The bulletin board: what peers offer. Keyed by `(peerId, key)` via a
 * two-level `Map` — not a joined string — so there is no delimiter to pick
 * and therefore no way for a `peerId` or `key` value to collide with one.
 * Entries persist until withdrawn or replaced, not on a timer.
 */
export function createAdvertisementStore(clock: () => number = Date.now): AdvertisementStore {
  const board = new Map<string, Map<string, Advertisement>>();

  return {
    post(peerId, key, payload) {
      const ad: Advertisement = { peerId, key, payload, postedAt: clock() };
      let byKey = board.get(peerId);
      if (byKey === undefined) {
        byKey = new Map();
        board.set(peerId, byKey);
      }
      byKey.set(key, ad);
      return ad;
    },
    withdraw(peerId, key) {
      board.get(peerId)?.delete(key);
    },
    get(peerId, key) {
      return board.get(peerId)?.get(key);
    },
    list(peerId) {
      if (peerId !== undefined) {
        return [...(board.get(peerId)?.values() ?? [])];
      }
      const all: Advertisement[] = [];
      for (const byKey of board.values()) {
        all.push(...byKey.values());
      }
      return all;
    },
  };
}

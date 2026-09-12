/**
 * A-2: revocation, as a pulled and cached deny list.
 *
 * The heartbeat response carries a version vector; when the policy version
 * changes, the peer fetches the change list and caches it. Providers then
 * reject any token issued BEFORE the change:
 *
 *     reject if claims.iat < changedAt
 *
 * Three properties that make this work, none of them accidental:
 *
 *  1. REVOCATION AND ROLE CHANGE ARE THE SAME MECHANISM. Revocation is a role
 *     change to the empty set. A downgraded member is not locked out — their
 *     next heartbeat mints a token with the reduced roles. Upgrades need no
 *     enforcement at all, since the old token is merely less permissive.
 *
 *  2. NO CLOCK SYNCHRONISATION. Both `iat` and `changedAt` are minted by the
 *     hub, so the comparison is between two hub-issued timestamps. A provider
 *     must never substitute its own clock. Worth stating loudly: the obvious
 *     implementation — "is this token older than the revocation?" using
 *     `Date.now()` — quietly requires synchronised clocks across every peer.
 *
 *     ONE HUB-ISSUED CLOCK, NOT TWO. Both timestamps being hub-issued is not
 *     enough on its own — `Date.now()` has millisecond resolution, and
 *     minting a token then revoking that same peer are two independent
 *     calls that can land in the same millisecond (routinely, under load: a
 *     round trip that normally clears by a few ms can clear by one). `<`
 *     cannot tell which of two equal readings came first, and silently
 *     resolves the tie as "minted after the change" — the token is
 *     honoured, even though the hub's own call order proves the revocation
 *     came second. `check` below still compares `iat` against `changedAt`
 *     with ordinary `<`; what changes is that a hub mints tokens and
 *     records revocations through `clock.ts`'s `createMonotonicClock`,
 *     shared as ONE instance between `mintToken` and this registry (see
 *     `mesh.ts`'s `buildTestHub` / `main.ts`'s `startHub`) — two calls
 *     through that one instance can never return the same value, so a tie
 *     at this comparison becomes structurally impossible rather than
 *     merely unlikely.
 *
 *  3. THE LIST IS SELF-PRUNING. An entry can be dropped once
 *     `changedAt + maxTokenTtl < now`: no token old enough to be affected can
 *     still be valid. The list stays bounded by "peers changed in the last
 *     token lifetime", which is normally empty.
 *
 * The hub never sits on the critical path of a provider's request — the list
 * is pulled and cached, not consulted per request. `RevocationCache.check`
 * is deliberately synchronous: it is a pure in-memory lookup with nothing to
 * await, and an async signature would invite a future implementation to do
 * I/O on the request path, which is exactly what this design exists to
 * avoid. The `isRevoked` seam on the binding middleware (`peer-handlers.ts`)
 * is `async`, so wiring `check` to it is a wrap-at-the-call-site concern for
 * whichever task assembles the peer, not a reason to change this signature.
 *
 * TWO CONSUMERS OF THE SAME DECISION, NOT TWO MECHANISMS. A remote provider
 * has no direct line to the hub's own state, so it pulls a snapshot
 * (`RevocationCache`) on its own schedule and checks against that. The hub
 * itself has no such gap — it holds `RevocationRegistry`, the live source of
 * truth for its own change entries, in the same process. Requiring it to
 * also keep a synchronised `RevocationCache` just to reuse `.check()` would
 * add a cache with nothing to be stale relative to. `RevocationChecker`
 * below is the shared shape (`check(claims) -> reason | null`) both sides
 * satisfy: `RevocationCache` reads a pulled snapshot; `RevocationRegistry`'s
 * own `check` (added alongside `list`/`policyVersion`) reads its live
 * entries directly. `createPeer`'s `revocationCache` option
 * (`peer.ts`) accepts either — a peer wired against a `RevocationRegistry`
 * it owns enforces revocation on itself with no cache and no pull.
 */
import type { PeerIdStr } from "./types.js";

export interface ChangeEntry {
  peerId: PeerIdStr;
  /** Hub time at which this peer's authority changed. */
  changedAt: number;
  /** Roles after the change. Empty means revoked. Informational. */
  roles: string[];
}

/**
 * The shape `createPeer`'s `revocationCache` option actually needs: `null`
 * means accept, a string is the reason to refuse. Both `RevocationCache`
 * (a pulled snapshot) and `RevocationRegistry` (a live source of truth)
 * satisfy it — see the module comment for why that is two consumers of one
 * decision, not two mechanisms.
 */
export interface RevocationChecker {
  check(claims: { sub: PeerIdStr; iat: number }): string | null;
}

// ---------------------------------------------------------------------------
// Hub side
// ---------------------------------------------------------------------------

export interface RevocationRegistryInit {
  /** Longest life of any token this hub mints. Sets the pruning horizon. */
  maxTokenTtlMs: number;
  now?: () => number;
}

export class RevocationRegistry implements RevocationChecker {
  private readonly entries = new Map<PeerIdStr, ChangeEntry>();
  private version = 1;
  private readonly maxTokenTtl: number;
  private readonly now: () => number;

  constructor(init: RevocationRegistryInit) {
    this.maxTokenTtl = init.maxTokenTtlMs;
    this.now = init.now ?? (() => Date.now());
  }

  /** Revocation is a role change to the empty set. */
  revoke(peerId: PeerIdStr): void {
    this.changeRoles(peerId, []);
  }

  /**
   * Direct, synchronous check against this registry's own live entries — for
   * a peer that owns this registry (the hub itself) to enforce revocation on
   * its own endpoints, with no cache and nothing to pull: see the module
   * comment. Same decision logic as `RevocationCache.check` (same entry
   * shape, same `iat < changedAt` comparison) — duplicated rather than
   * shared through inheritance, since a registry that owns its entries and a
   * cache that was handed a snapshot of them are different things that
   * happen to compare the same way. No staleness dimension: unlike a pulled
   * cache, a registry cannot be stale relative to itself.
   */
  check(claims: { sub: PeerIdStr; iat: number }): string | null {
    const entry = this.entries.get(claims.sub);
    if (entry == null) return null;
    if (claims.iat >= entry.changedAt) return null; // minted after the change
    return entry.roles.length === 0 ? "membership revoked" : "roles changed; obtain a fresh token";
  }

  changeRoles(peerId: PeerIdStr, roles: string[]): void {
    this.entries.set(peerId, { peerId, changedAt: this.now(), roles });
    this.version++;
  }

  /** Drop entries no live token could be affected by. Returns how many went. */
  prune(): number {
    const horizon = this.now() - this.maxTokenTtl;
    let dropped = 0;
    for (const [id, e] of this.entries) {
      if (e.changedAt < horizon) {
        this.entries.delete(id);
        dropped++;
      }
    }
    // Pruning does NOT bump the version: a peer that missed the entry entirely
    // also holds no token old enough to care.
    return dropped;
  }

  policyVersion(): number {
    return this.version;
  }

  list(): ChangeEntry[] {
    this.prune();
    return [...this.entries.values()];
  }
}

// ---------------------------------------------------------------------------
// Provider side
// ---------------------------------------------------------------------------

export interface RevocationCacheInit {
  /**
   * Reject tokens once the cache is older than this. Availability versus
   * security: too short and a hub outage locks the mesh out, too long and a
   * partitioned provider honours revoked tokens. Omit to never expire, which
   * is a deliberate and dangerous choice.
   *
   * There is a case that no default is correct and this should be required.
   */
  maxStalenessMs?: number;
  now?: () => number;
}

export type StalenessMode = "fresh" | "stale";

export class RevocationCache implements RevocationChecker {
  private entries = new Map<PeerIdStr, ChangeEntry>();
  private version = 0;
  private fetchedAt = 0;
  private readonly maxStaleness?: number;
  private readonly now: () => number;

  constructor(init: RevocationCacheInit = {}) {
    this.maxStaleness = init.maxStalenessMs;
    this.now = init.now ?? (() => Date.now());
  }

  /** Called after fetching the list because the heartbeat reported a new version. */
  update(version: number, entries: ChangeEntry[]): void {
    this.entries = new Map(entries.map((e) => [e.peerId, e]));
    this.version = version;
    this.fetchedAt = this.now();
  }

  knownVersion(): number {
    return this.version;
  }

  staleness(): StalenessMode {
    if (this.maxStaleness == null) return "fresh";
    return this.now() - this.fetchedAt > this.maxStaleness ? "stale" : "fresh";
  }

  /**
   * `null` means accept. A string is the reason to refuse — deliberately not
   * a boolean, so a denial can be explained, as with access decisions.
   *
   * Takes a structural subset of `MeshClaims` (`sub`, `iat`), not the whole
   * shape, so this cache stays usable anywhere a `{ sub, iat }` pair is
   * available without pulling in the rest of the claims contract.
   */
  check(claims: { sub: PeerIdStr; iat: number }): string | null {
    if (this.staleness() === "stale") {
      return "revocation list is stale; refusing rather than guessing";
    }
    const entry = this.entries.get(claims.sub);
    if (entry == null) return null;
    if (claims.iat >= entry.changedAt) return null; // minted after the change
    return entry.roles.length === 0 ? "membership revoked" : "roles changed; obtain a fresh token";
  }
}

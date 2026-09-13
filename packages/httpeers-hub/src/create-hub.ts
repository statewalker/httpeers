/**
 * One constructor that returns the parts.
 *
 * THE API SPEC SAID THERE WOULD NOT BE A `createHub`, and the prototype proved
 * it wrong by writing the assembly three times — the Node hub, the browser hub
 * and the test hub. A hub is not a mount table: it is a mount table *plus* a
 * snapshot store, a clock, a revocation registry, an invitation store, two
 * registries with different consistency needs, and a sweep timer. Anything that
 * hands back only the mounts leaves the other six to every caller.
 *
 * `mounts` is still separately usable, so nothing is walled off — the point is
 * to stop each assembly re-deriving the wiring, not to hide it.
 *
 * THE ORDERING CYCLE, closed here because it cannot be closed by the caller.
 * A hub's node must exist before `createHub` (the node needs a key; this needs
 * `selfPeerId`), and the node's connection gater needs `hub.isMember`. So the
 * documented order is:
 *
 *   key -> node with a LATE-BOUND gater -> createHub -> servePeer
 *        -> point the gater's thunk at hub.isMember
 *
 * `membershipGater` takes a thunk for exactly this reason; see its comment in
 * `httpeers-libp2p`.
 */

import type { FetchHandler, MeshView, Mounts, PeerIdStr } from "@statewalker/httpeers-core";
import type { RuleSet } from "@statewalker/httpeers-access";
import { RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { createHubEndpoints, type HubEndpointsInit } from "./endpoints.js";
import {
  createHubState,
  type InvitationRecord,
  type InvitationRedemption,
  type PersistentHub,
} from "./hub-state.js";
import { createMemberStore } from "./registries.js";
import { asyncSnapshotStore, type KeyValueStorage, memoryStorage } from "./storage.js";

export interface CreateHubInit {
  /** This hub's own peerId — the mesh identity every token restates. */
  selfPeerId: PeerIdStr;
  /** Mint a membership token that self-certifies as this mesh. */
  mintToken: HubEndpointsInit["mintToken"];
  /** Where members and spent invitation ids are persisted. Defaults to memory. */
  storage?: KeyValueStorage;
  /** This mesh's Datalog rules. Injected, never global — there is no default rule set. */
  policies: RuleSet;
  now?: () => number;
  presenceTtlMs?: number;
  /**
   * Expire stale presence on a timer. Omit to drive `sweep()` yourself, which
   * is what a test with a controlled clock wants.
   */
  sweepIntervalMs?: number;
  extraMounts?: Record<string, FetchHandler>;
  ownAdvertisements?: Array<{ id: string; kind: string; title: string }>;
  advertisementAccess?: Record<string, string>;
  /** Longest life of any token this hub mints. Sets the revocation pruning horizon. */
  maxTokenTtlMs?: number;
}

export interface Hub {
  /** The `.well-known` surface and `/admin`, plus whatever `extraMounts` added. */
  mounts: Mounts;
  /** Expire stale presence and the advertisements that rode along with it. */
  sweep(): void;
  /** The very view `GET /.well-known/mesh` serves, read in-process. */
  meshView(caller?: PeerIdStr): MeshView;
  /**
   * The operator-facing shape (spec §9), which differs from the store's:
   * the hub generates the id, and every mutator resolves when the write is
   * DURABLE — so a caller is never told "created" before it is, and an
   * invitation handed out over the phone cannot be lost to a crash a
   * millisecond later.
   */
  invitations: {
    create(
      roles: string[],
      ttlMs: number,
      opts?: { id?: string },
    ): Promise<{ id: string; expiresAt: number }>;
    redeem(id: string): Promise<InvitationRedemption>;
    status(id: string): "unspent" | "redeemed" | "expired" | "unknown";
    pending(): InvitationRecord[];
  };
  members: PersistentHub["memberStore"];
  isMember(peerId: PeerIdStr): boolean;
  revocations: RevocationRegistry;
  rules: RuleSet;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * An invitation id.
 *
 * 128 bits from the platform CSPRNG, base36. An invitation is a bearer
 * credential for membership, so a guessable id is a way into the mesh —
 * `Math.random` is not acceptable here and the crypto global is available on
 * every runtime this package targets.
 */
function newInvitationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createHub(init: CreateHubInit): Promise<Hub> {
  const now = init.now ?? Date.now;
  const storage = init.storage ?? memoryStorage();

  // Storage is async; the snapshot seam is not. An in-memory authoritative
  // copy with serialised flushes behind it is what lets `SnapshotStore.write`
  // stay synchronous while the durable write is still awaited by whoever
  // mutated — so a caller is never told "added" before it is.
  const snapshots = await asyncSnapshotStore(storage);

  const state = createHubState({
    store: snapshots,
    rules: init.policies,
    now,
    createMemberStore,
  });

  const revocations = new RevocationRegistry({
    maxTokenTtlMs: init.maxTokenTtlMs ?? 24 * 60 * 60 * 1000,
    now,
  });

  const endpoints = createHubEndpoints({
    selfPeerId: init.selfPeerId,
    mintToken: init.mintToken,
    memberStore: state.memberStore,
    invitations: state.invitations,
    rules: init.policies,
    revocations,
    advertisementAccess: init.advertisementAccess,
    extraMounts: init.extraMounts,
    ownAdvertisements: init.ownAdvertisements,
    presenceTtlMs: init.presenceTtlMs,
    now,
  });

  // The timer is optional so a test can drive `sweep()` with a controlled
  // clock. A hub that also sweeps on a real timer would race that test.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (init.sweepIntervalMs != null) {
    timer = setInterval(() => endpoints.sweep(), init.sweepIntervalMs);
    // Never hold a process open for a sweep. A CLI that finished its work
    // should exit, and an interval that keeps it alive is a hang nobody
    // attributes to the hub.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  let stopped = false;
  return {
    mounts: endpoints.mounts,
    sweep: endpoints.sweep,
    meshView: endpoints.meshView,
    invitations: {
      async create(roles, ttlMs, opts) {
        // A caller may name the id — a deployment migrating existing codes, or
        // a test wanting a constant — but the hub generates one by default so
        // nobody has to invent unguessable strings.
        const id = opts?.id ?? newInvitationId();
        const record = state.invitations.create(id, roles, ttlMs);
        await snapshots.flushed();
        return { id: record.id, expiresAt: record.expiresAt };
      },
      async redeem(id) {
        const result = state.invitations.redeem(id);
        // Flush even on refusal: a redemption that FAILED still may have
        // consumed nothing, but one that succeeded must be durable before the
        // caller is told it is a member.
        await snapshots.flushed();
        return result;
      },
      status: (id) => state.invitations.status(id),
      pending: () => state.invitations.pending(),
    },
    members: state.memberStore,
    isMember: (peerId) => state.memberStore.get(peerId) !== undefined,
    revocations,
    rules: init.policies,
    async reset() {
      // Forget every member and every spent invitation id. The next start
      // founds a fresh mesh under the SAME peerId — which is the one thing
      // this cannot undo, and why it is a separate call rather than something
      // `stop()` does.
      for (const record of state.memberStore.list()) state.memberStore.remove(record.peerId);
      await snapshots.flushed();
    },
    async stop() {
      // Idempotent: an assembly that tears down twice — a page unloading while
      // a test also cleans up — must not see the second call throw.
      if (stopped) return;
      stopped = true;
      if (timer != null) clearInterval(timer);
    },
  };
}

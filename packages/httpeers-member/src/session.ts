/**
 * The page session: one persistent identity, resume-or-redeem on start, and
 * the three operator controls -- join, disconnect, reset identity -- with
 * no DOM anywhere in it.
 *
 * WHY EVERY CONSUMER PAGE SHARES THIS. Two pages differ in exactly one
 * thing: what they mount and advertise. Everything else -- read the saved
 * identity, try to resume, say which of the two "cannot resume" situations
 * this is, offer an invitation field, disconnect without surrendering
 * membership, reset the key -- is identical between them, down to the
 * wording, and duplicating it would have been duplicating the wording too.
 *
 * NO DOM, AND NOTHING BROWSER-ONLY IMPORTED. This module decides things --
 * which mesh to try, resume or redeem, what an operator is told -- and
 * deciding is exactly what is worth testing, so `tests/session.test.ts`
 * exercises every branch under Node with no browser, no relay and no
 * ServiceWorker. That is only possible because the platform, the two stores
 * and the reload are INJECTED rather than defaulted: `browserPlatform`
 * reaches `@libp2p/webrtc`, whose Node build loads a native module, so a
 * default here would have made importing this module a browser-only act.
 * `./browser.ts`'s `createSession` is where those defaults live instead.
 *
 * Pages render `SessionState` and call the four methods; they hold no state
 * of their own.
 *
 * THE CONFIG IS RESOLVED HERE, because `startMember` requires one and will
 * not fetch anything itself (see `StartMemberInit.config`). That moved the
 * `httpeers.json` read up into this module, which is the only place that
 * knows which of the three candidates -- a blob's mesh, the remembered one,
 * the deployment's -- applies to the attempt at hand.
 *
 * WHICH MESH IS TRIED, AND THE ONE RULE THAT MUST NOT BEND. When someone
 * supplies an invitation, the invitation decides: a join blob names its own
 * mesh, and a BARE invitation id still means "the mesh `httpeers.json`
 * names", i.e. the Node hub's -- the contract `./join-blob.ts` states and
 * the reason both deployments keep working. Only a RESUME (nobody supplied
 * anything) consults `./mesh-memory.ts`, and only because a mesh whose hub
 * is a browser page cannot be named any other way after the `?join=` query
 * has gone. See `./mesh-memory.ts`.
 *
 * DISCONNECT IS NOT LEAVING. `MemberHandle.stop()` drops presence and
 * keeps membership, which is what makes the page resumable afterwards with
 * no new invitation; see that method's own doc comment. This module never
 * calls anything that surrenders membership, and the one control that
 * destroys something -- `resetIdentity` -- says what it costs and is named
 * separately.
 */
import type { MeshConfig as HttpeersConfig, Mounts } from "@statewalker/httpeers-core";
import type { RuleSet } from "@statewalker/httpeers-access";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import type { IdentityStoreInit } from "./identity.js";
import { clearIdentity, loadOrCreateIdentity, peerIdOf, readIdentity } from "./identity.js";
import type { AdvertisementInput, PresenceRefusal } from "./join.js";
import type { JoinInput } from "./join-blob.js";
import { readJoinInputFromSearch, readJoinInputFromText } from "./join-blob.js";
import type { MeshMemory } from "./mesh-memory.js";
import type {
  JoinMethod,
  MemberHandle,
  MemberPlatform,
  MemberState,
  StartMemberInit,
} from "./start-member.js";
import { MemberJoinError, startMember } from "./start-member.js";

/** Why this page is asking for an invitation. The two that matter are the first two -- see `SessionPhase`. */
export type NeedsInvitationReason =
  /** This browser has never held an identity for this origin: a genuine first run. */
  | "no-identity"
  /** This browser holds an identity, the hub was reachable, and it does not know it. */
  | "unknown-identity"
  /** An invitation was supplied and the hub refused it (spent, expired, unknown). */
  | "invitation-refused"
  /** Nothing was supplied and nothing is remembered, so there is no mesh to even try. */
  | "no-mesh";

/**
 * Where the session is. Every one of these is a distinct thing to say on
 * screen, which is the only reason there are six.
 *
 * `needs-invitation` CARRIES ITS REASON because "no saved identity yet" and
 * "saved identity, but this hub does not know it" are not the same
 * situation and must not read the same (Task 28, requirement 3). The first
 * is a page that has never run; the second is a hub reset or a revoked
 * membership, and an operator told only "please paste an invitation" would
 * have no way to tell which had happened -- or that their saved identity is
 * intact and simply unrecognised.
 *
 * `blocked` is the duplicate-identity refusal, kept apart from `failed`
 * because it is not a fault to retry: two tabs are running one libp2p
 * identity, and something has to give before this page can proceed.
 */
/**
 * What `starting` reports.
 *
 * `"loading-config"` is the SESSION'S OWN step, not the member's: resolving
 * which mesh to try can mean an `httpeers.json` fetch, which is the one part
 * of a start that happens before `startMember` exists to have a state. Every
 * other value is `MemberState` verbatim, forwarded.
 */
export type SessionStartState = "loading-config" | MemberState;

export type SessionPhase =
  | { kind: "checking" }
  | { kind: "starting"; peerState: SessionStartState }
  | { kind: "live"; joinedBy: JoinMethod; note: string | null }
  | { kind: "needs-invitation"; reason: NeedsInvitationReason; message: string }
  | { kind: "disconnected"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "failed"; message: string };

/** Which controls make sense in the current phase. Derived here, once, rather than by each page re-deriving it from `phase.kind`. */
export interface SessionControls {
  join: boolean;
  disconnect: boolean;
  reconnect: boolean;
  reset: boolean;
}

export interface SessionState {
  phase: SessionPhase;
  /** The peerId this origin holds, or `null` when it has never had one. Known before anything is dialled. */
  identity: string | null;
  /** Live only while `phase.kind === "live"`. */
  handle: MemberHandle | null;
  controls: SessionControls;
}

/** `startMember`'s shape, as a seam -- see the module comment. */
export type StartPeer = (init: StartMemberInit) => Promise<MemberHandle>;

/** The identity store's three operations, as a seam. Defaults to `./identity.ts` over the real IndexedDB. */
export interface IdentityStore {
  read(): Promise<Ed25519PrivateKey | null>;
  loadOrCreate(): Promise<Ed25519PrivateKey>;
  clear(): Promise<void>;
}

export function createIdentityStore(init: IdentityStoreInit): IdentityStore {
  return {
    read: () => readIdentity(init),
    loadOrCreate: () => loadOrCreateIdentity(init),
    clear: () => clearIdentity(init),
  };
}

export interface PeerSessionInit {
  /** Everything `startMember` needs that is this PAGE's own, and nothing that is the session's. */
  key: string;
  mounts: Mounts;
  /** This page's own rule set, already built -- see `StartMemberInit.rules`. */
  rules: RuleSet;
  advertisements?: () => AdvertisementInput[];
  /**
   * How this host builds a node, mounts an edge and hears about wakes.
   * REQUIRED, and deliberately: see the module comment on why a default
   * would make importing this module browser-only.
   */
  platform: MemberPlatform;
  /** This page's `location.search`, read once at `start()`. */
  search: string;
  /** Fired on every state change, including the first. */
  onChange: (state: SessionState) => void;
  /** Where this origin's key lives. Required for the same reason `./mesh-memory.ts`'s backend is. */
  identity: IdentityStore;
  /** The mesh this origin last joined. Required for the same reason. */
  meshMemory: MeshMemory;
  /**
   * Reloading the host after a reset. REQUIRED because `location` is the one
   * DOM global this module would otherwise have to name; `./browser.ts`
   * supplies it.
   */
  reload: () => void;
  // --- seams, defaulted ----------------------------------------------------
  startPeer?: StartPeer;
  /**
   * The mesh this DEPLOYMENT names (`httpeers.json`).
   *
   * READ FOR TWO REASONS. It is the fallback mesh -- what a bare invitation
   * id means, and what a page with an identity but no remembered mesh tries.
   * And it explains a failure: when a page cannot resume against the mesh it
   * REMEMBERS and the deployment now names a different hub, that is almost
   * always a re-run of `pnpm bootstrap` (or a switch between the Node hub and
   * a hub page), and saying so is the difference between a two-minute fix and
   * an hour.
   */
  readDeploymentConfig?: () => Promise<HttpeersConfig | null>;
}

export interface PeerSession {
  /** Read the saved identity and try to resume. Call once, on page load. */
  start(): Promise<void>;
  /** Join with what someone typed or pasted: a blob, a bare invitation id, or a whole join link. */
  join(text: string): Promise<void>;
  /** Stop this peer: drop presence, KEEP membership -- see `MemberHandle.stop`. */
  disconnect(): Promise<void>;
  /** Come back after a `disconnect`, by resuming. No invitation involved. */
  reconnect(): Promise<void>;
  /** Forget this origin's key, so the next run is a different peer. Destructive -- see below. */
  resetIdentity(): Promise<void>;
  state(): SessionState;
}

function controlsFor(phase: SessionPhase): SessionControls {
  switch (phase.kind) {
    case "live":
      return { join: false, disconnect: true, reconnect: false, reset: true };
    case "disconnected":
      return { join: false, disconnect: false, reconnect: true, reset: true };
    // Every remaining phase leaves the invitation field open -- including
    // `failed`. A page that could not reach the relay will not be fixed by
    // an invitation, but an operator who has just been handed a link to a
    // DIFFERENT mesh has every reason to try it, and a form that vanished on
    // the wrong kind of failure would be the page deciding that for them.
    case "blocked":
      return { join: false, disconnect: false, reconnect: false, reset: true };
    case "checking":
    case "starting":
      return { join: false, disconnect: false, reconnect: false, reset: false };
    default:
      return { join: true, disconnect: false, reconnect: false, reset: true };
  }
}

/** A blob names its own mesh; a bare invitation id means "whichever mesh `httpeers.json` names" -- `./join-blob.ts`. */
function configOf(input: JoinInput): HttpeersConfig | undefined {
  return input.kind === "blob"
    ? { relayAddrs: input.blob.relayAddrs, hubPeerId: input.blob.hubPeerId }
    : undefined;
}

function invitationIdOf(input: JoinInput): string {
  return input.kind === "blob" ? input.blob.invitationId : input.invitationId;
}

/**
 * Where a deployment publishes the mesh it names.
 *
 * A SITE-ABSOLUTE PATH, so every page of an origin reads the same file
 * whatever directory it was served from. It left with `peer-runtime.ts` and
 * is declared here because this module is now the only thing that reads it.
 */
export const DEFAULT_HTTPEERS_CONFIG_URL = "/httpeers.json";

async function readDeploymentConfigOverHttp(): Promise<HttpeersConfig | null> {
  try {
    const res = await fetch(DEFAULT_HTTPEERS_CONFIG_URL);
    if (!res.ok) return null;
    return (await res.json()) as HttpeersConfig;
  } catch {
    // A diagnostic that cannot be read is simply not added to the message.
    return null;
  }
}

/**
 * The sentence added to a "this hub does not know you" message when the
 * deployment has visibly moved underneath the page.
 *
 * THE CASE THIS EXISTS FOR: `pnpm bootstrap` was re-run, so `httpeers.json`
 * now names a hub with a different peerId than the one this page last
 * joined. Everything about the page is fine, the hub it is talking to is
 * fine, and the membership is simply in a mesh that no longer exists. With
 * nothing said, that presents as "please paste an invitation" for reasons
 * an operator cannot see. Exported for its own test.
 */
export function describeMeshDrift(tried: string, deployment: HttpeersConfig | null): string | null {
  if (deployment == null || deployment.hubPeerId === tried) return null;
  return (
    ` This deployment's httpeers.json now names a different hub (${deployment.hubPeerId}), ` +
    "which is a different mesh -- so a membership in the old one cannot carry over. Re-running " +
    '"pnpm bootstrap" does that, and so does moving between the Node hub and a hub page.'
  );
}

export function createPeerSession(init: PeerSessionInit): PeerSession {
  const startPeer = init.startPeer ?? startMember;
  const identityStore = init.identity;
  const meshMemory = init.meshMemory;
  const readDeployment = init.readDeploymentConfig ?? readDeploymentConfigOverHttp;
  const reload = init.reload;

  let phase: SessionPhase = { kind: "checking" };
  let identity: string | null = null;
  let handle: MemberHandle | null = null;
  /** One attempt at a time. Two concurrent `startBrowserPeer` calls would build two libp2p nodes on ONE identity -- the very duplicate this session refuses when someone else does it. */
  let busy = false;

  const state = (): SessionState => ({ phase, identity, handle, controls: controlsFor(phase) });

  const set = (next: SessionPhase): void => {
    phase = next;
    init.onChange(state());
  };

  /**
   * One join attempt, whichever way it was provoked (page load, the form,
   * reconnect). `input` is what someone supplied, or `null` for a pure
   * resume.
   */
  const attempt = async (input: JoinInput | null): Promise<void> => {
    if (busy) return;
    busy = true;
    /** The mesh this attempt actually tried, for the drift diagnostic below. */
    let tried: HttpeersConfig | null = null;
    try {
      set({ kind: "starting", peerState: "loading-config" });

      // WHICH MESH, AND IN WHICH ORDER. A blob names its own and that is the
      // end of it. A BARE invitation id skips the memory entirely and means
      // the deployment's -- the contract `./join-blob.ts` states. Only a pure
      // resume consults the memory, falling back to the deployment for a page
      // that has only ever joined the Node hub.
      const preferred = input != null ? configOf(input) : ((await meshMemory.read()) ?? undefined);
      const config = preferred ?? (await readDeployment()) ?? undefined;

      if (config == null) {
        // `startMember` requires a config and there is none to give it, so
        // nothing is started and the key is left untouched.
        set({
          kind: "needs-invitation",
          reason: "no-mesh",
          message:
            "There is no mesh to join: this page remembers none, and this deployment's " +
            `${DEFAULT_HTTPEERS_CONFIG_URL} does not name one either. Paste a join link or a ` +
            "join blob -- either names its own mesh.",
        });
        return;
      }

      tried = config;
      const key = await identityStore.loadOrCreate();
      identity = peerIdOf(key);

      const joined = await startPeer({
        key: init.key,
        mounts: init.mounts,
        rules: init.rules,
        advertisements: init.advertisements,
        // The three things a page does differently, as one object — see
        // `browser-platform.ts` for why this replaced a second lifecycle.
        platform: init.platform,
        privateKey: key,
        invitationId: input == null ? undefined : invitationIdOf(input),
        config,
        onState: (peerState: MemberState) => {
          // Late lifecycle callbacks from a peer that has since been stopped
          // must not repaint the page: `stop()` fires `"stopped"`, and a
          // disconnect that then redrew itself as "starting" would be a lie.
          if (phase.kind === "starting") set({ kind: "starting", peerState });
        },
        onPresenceRefused: (refusal: PresenceRefusal) => {
          void onLostPresence(refusal);
        },
      });

      handle = joined;
      identity = joined.peerId;
      // Remembered only now, and only from the handle -- see
      // `./mesh-memory.ts`'s "WRITTEN ONLY AFTER A JOIN ACTUALLY SUCCEEDS".
      await meshMemory.write({
        relayAddrs: [joined.relayAddr],
        hubPeerId: joined.hubPeerId,
      });

      set({
        kind: "live",
        joinedBy: joined.joinedBy,
        note:
          joined.joinedBy === "resumed" && input != null
            ? "This page was already a member of this mesh, so it resumed instead of " +
              "redeeming -- the invitation you supplied was not used and is still unspent. " +
              "Reset this page's identity if you meant to join as a new peer."
            : null,
      });
    } catch (err) {
      handle = null;
      await onAttemptFailed(err, input, tried);
    } finally {
      busy = false;
    }
  };

  const onAttemptFailed = async (
    err: unknown,
    input: JoinInput | null,
    tried: HttpeersConfig | null,
  ): Promise<void> => {
    if (err instanceof MemberJoinError) {
      if (err.reason === "duplicate-identity") {
        set({ kind: "blocked", message: err.message });
        return;
      }
      if (err.reason === "invitation-refused") {
        set({ kind: "needs-invitation", reason: "invitation-refused", message: err.message });
        return;
      }
      if (err.reason === "not-a-member") {
        // Only a RESUME gets the drift diagnostic: if an invitation was
        // supplied, the mesh came from that invitation and comparing it
        // against `httpeers.json` would be comparing two things nobody
        // claimed were the same.
        const drift =
          input == null && tried != null
            ? describeMeshDrift(tried.hubPeerId, await readDeployment())
            : null;
        set({
          kind: "needs-invitation",
          reason: "unknown-identity",
          message: err.message + (drift ?? ""),
        });
        return;
      }
    }
    set({ kind: "failed", message: String(err) });
    console.error("session: could not join the mesh:", err);
  };

  /**
   * The hub refused a heartbeat of a page that WAS live. Nothing is torn
   * down here except this peer's own node: a membership that has gone away,
   * or an identity two nodes are fighting over, will not repair itself on
   * the next tick, and a page left heartbeating into a refusal would look
   * joined while being invisible to everyone else.
   */
  const onLostPresence = async (refusal: PresenceRefusal): Promise<void> => {
    if (phase.kind !== "live") return;
    const stopping = handle;
    handle = null;
    if (refusal.kind === "duplicate-identity") {
      set({
        kind: "blocked",
        message:
          `Another live peer is now using this identity (${identity ?? "unknown"}). This page ` +
          "has stopped rather than take turns overwriting its presence -- close the other " +
          "tab, or reset this page's identity.",
      });
    } else if (refusal.kind === "not-a-member") {
      set({
        kind: "needs-invitation",
        reason: "unknown-identity",
        message:
          "This hub no longer lists this peer as a member -- the membership was revoked, or " +
          "the hub's state was reset. This page has stopped; an invitation is the way back in.",
      });
    } else {
      set({
        kind: "failed",
        message: `The hub refused this page's heartbeat: ${refusal.message}`,
      });
    }
    await stopping?.stop().catch(() => {});
  };

  return {
    async start() {
      let input: JoinInput | null;
      try {
        input = readJoinInputFromSearch(init.search);
      } catch (err) {
        // A half-pasted link is a legible complaint, not a blank page -- and
        // the form stays open so the operator can paste the whole one.
        identity = await identityStore
          .read()
          .then((k) => (k == null ? null : peerIdOf(k)))
          .catch(() => null);
        set({ kind: "needs-invitation", reason: "no-mesh", message: String(err) });
        return;
      }

      const key = await identityStore.read();
      identity = key == null ? null : peerIdOf(key);

      if (key == null && input == null) {
        // A FIRST RUN, SAID AS SUCH. Nothing is generated yet: creating a
        // key here would make every later load report an identity this
        // browser has never used for anything, and the difference between
        // that and "the hub does not know my identity" is exactly what
        // requirement 3 is about.
        set({
          kind: "needs-invitation",
          reason: "no-identity",
          message:
            "This page has no saved identity yet -- it has never joined a mesh from this " +
            "browser. Paste an invitation id, a join blob, or a whole join link to join one; " +
            "an identity is created and saved at that point, and every later visit resumes " +
            "with it.",
        });
        return;
      }

      // An identity with no remembered mesh is NOT a refusal: `attempt`
      // leaves the config undefined, `startBrowserPeer` fetches
      // `httpeers.json`, and the deployment's own mesh is tried -- which is
      // the only candidate there is, and the right one for every page that
      // has only ever joined the Node hub.
      await attempt(input);
    },

    async join(text: string) {
      let input: JoinInput | null;
      try {
        input = readJoinInputFromText(text);
      } catch (err) {
        set({ kind: "needs-invitation", reason: "invitation-refused", message: String(err) });
        return;
      }
      if (input == null) return; // an empty field is not an error, it is nothing happening.
      await attempt(input);
    },

    async disconnect() {
      const stopping = handle;
      if (stopping == null) return;
      handle = null;
      await stopping.stop();
      set({
        kind: "disconnected",
        message:
          "Disconnected. This page still IS a member of the mesh -- membership is held by the " +
          "hub and nothing here surrendered it -- so reconnecting needs no new invitation. " +
          "Presence is a heartbeat, so this peer leaves everyone else's mesh view (and its " +
          "advertisements with it) within one presence interval.",
      });
    },

    async reconnect() {
      await attempt(null);
    },

    /**
     * Forget this origin's key. DESTRUCTIVE, and the cost is worth stating
     * where the caller can read it: the next run is a DIFFERENT peer, so
     * this page's current membership becomes an orphaned record on the hub
     * (visible to an admin, removable by one) and rejoining needs a fresh
     * invitation. It exists because a stuck key with no way out is worse
     * than no persistence at all -- the same reason the hub page has one
     * (`../pages/hub/main.ts`), for a much smaller blast radius.
     *
     * The remembered mesh is deliberately KEPT: the new identity will still
     * be joining the mesh this page was pointed at, and forgetting it would
     * only mean a bare invitation id could no longer be used against a hub
     * page.
     */
    async resetIdentity() {
      const stopping = handle;
      handle = null;
      // Stopped first, so nothing is still heartbeating as a peer whose key
      // is about to disappear.
      await stopping?.stop().catch(() => {});
      await identityStore.clear();
      identity = null;
      reload();
    },

    state,
  };
}

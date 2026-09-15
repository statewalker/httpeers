/**
 * Joining the mesh: the `/webrtc` pre-dial, invitation redemption, the
 * membership RESUME probe, and the two timers this runtime owns itself (the
 * third -- circuit-relay's own reservation refresh -- is libp2p-managed;
 * there is no code for it here, on purpose, see `startJoin`'s doc comment).
 *
 * THERE ARE TWO WAYS INTO A MESH, NOT ONE (Task 28). `redeemInvitation` is
 * the first join and can only ever happen once per invitation -- the id is
 * moved to `spentInvitationIds` on redemption and the spent check runs
 * first, unconditionally (`../hub/hub-state.ts`). A page that persists its
 * identity and reloads is therefore NOT making a first join: it is already
 * a member, and redeeming again would fail `already-redeemed` forever.
 * `resumeMembership` below is the other way in, and it needs no new hub
 * route because the hub already has one that answers exactly this question
 * -- see that function.
 */

import type { Libp2p, PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import type { ChangeEntry, RevocationCache, RuleSet } from "@statewalker/httpeers-access";
import type { MeshView, PeerIdStr } from "@statewalker/httpeers-core";
import type { Peer } from "@statewalker/httpeers-libp2p";
import { hubRoute, reachHub } from "@statewalker/httpeers-libp2p";
import { peerRequest } from "./peer-request.js";

/**
 * Dial `${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}` explicitly, BEFORE
 * opening any protocol against `peerId` (design note's Step 2; applies to
 * the hub exactly as it does to any other peer -- spec §7, the hub
 * declares no listen address of its own).
 *
 * WHY THIS IS NOT OPTIONAL. libp2p's auto-dial may already hold a
 * relay-only LIMITED connection to `peerId` -- reachable, but not upgraded
 * to WebRTC -- from nothing more than address exchange via `identify`.
 * libp2p SILENTLY refuses to open a custom protocol (`/httpeers/1.0.0`)
 * over a limited connection: the dial simply never completes, with no
 * error naming a limited connection as the cause. Explicitly dialling the
 * full `/webrtc/p2p/...` address forces the WebRTC upgrade before any
 * `peer.call` is attempted, so that failure mode never has a chance to
 * occur.
 */
export async function preDialPeer(
  node: Libp2p,
  relayAddr: string,
  peerId: PeerIdStr,
): Promise<void> {
  const target = multiaddr(`${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`);
  await node.dial(target);
}

export interface RouteEnsurerInit {
  node: Libp2p;
  /** `httpeers.json`'s `relayAddrs[0]` -- the fallback address composer, and the same string `preDialPeer` takes. */
  relayAddr: string;
  /** This peer's own id. A request addressed to it is served locally and must never be dialed. */
  selfPeerId: PeerIdStr;
  /** The current mesh view -- `JoinHandle.meshView`. Read per call, never snapshotted: a provider's addresses change when it re-reserves. */
  meshView: () => MeshView | null;
  /**
   * This mesh's hub. When given -- on a member page -- every other member is
   * reached THROUGH it (`../hub-link.ts`'s `hubRoute`), and what members
   * advertise is ignored: since members reserve on their hub rather than on
   * the public relay, their own addresses are double-circuit ones nothing
   * can dial. Omitted on the hub page, which cannot relay through itself
   * and reaches its members over the connections they already hold to it.
   */
  hubPeerId?: PeerIdStr;
}

/**
 * "Make sure this peer can be called" -- the function
 * `../browser/edge-dispatch.ts`'s `ensureRoute` hook wants, and the piece
 * that was missing for browser-to-browser calls entirely (Task 15; see that
 * module's job 4 for the symptom and the diagnosis).
 *
 * ADDRESSES COME FROM THE MESH VIEW, WHICH IS THE CONTRACT
 * `../browser/peer-runtime.ts`'s module comment already stated and nothing
 * had yet had to honour: the hub builds each member's `addrs` from that
 * member's own most recent heartbeat, so it is the freshest source there
 * is, and libp2p's peerStore -- what `remote()` falls back on when it dials
 * by bare peer id -- is exactly the stale/absent one that comment warns
 * about.
 *
 * ONLY THE `/webrtc` ENTRIES ARE DIALED. The same view also carries bare
 * `/p2p-circuit` addresses for every member; connecting over one of those
 * produces a LIMITED connection, on which libp2p silently refuses to open
 * `/httpeers/1.0.0` (`preDialPeer`'s own comment, and Task 14's test that
 * pins the refusal). Dialing them would therefore "succeed" and leave the
 * call to fail anyway.
 *
 * THE COMPOSED ADDRESS IS THE FALLBACK, NOT THE PRIMARY. `preDialPeer`'s
 * `<relay>/p2p-circuit/webrtc/p2p/<peer>` is right whenever every peer
 * reserves on the one relay `httpeers.json` names -- true of this
 * deployment, and how the hub itself is reached at startup, since the hub
 * is not a mesh MEMBER and so never appears in the view at all. It is the
 * fallback rather than the rule because a peer that reserved on a different
 * relay is reachable only at the address it reported.
 *
 * THE HUB ITSELF IS NEVER DIALED HERE. `hubRoute(hub, hub)` routes the hub
 * through itself, which cannot work; and a member on the relay fallback holds
 * only a limited circuit to the hub, so without this every edge call to the
 * hub would pay a doomed dial -- up to libp2p's dial timeout -- first. The
 * hub link is `startMember`'s and the keepalive's to keep.
 *
 * AN EXISTING UNLIMITED CONNECTION SHORT-CIRCUITS. This runs on every
 * outbound mesh call, including every `<img src>` in a gallery; re-dialing
 * a peer that is already connected would add a round trip per image.
 */
export function createRouteEnsurer(init: RouteEnsurerInit): (peerId: PeerIdStr) => Promise<void> {
  const { node, relayAddr, selfPeerId } = init;

  return async function ensureRoute(peerId: PeerIdStr): Promise<void> {
    if (peerId === selfPeerId || peerId === init.hubPeerId) return;

    let target: PeerId;
    try {
      target = peerIdFromString(peerId);
    } catch {
      // Not a peer id after all (the shape test in `edge-dispatch.ts` is a
      // regex, not a decoder). Nothing to dial; let the router decide what
      // this path means.
      return;
    }

    if (node.getConnections(target).some((conn) => conn.limits == null)) return;

    if (init.hubPeerId != null && init.hubPeerId !== selfPeerId) {
      await node.dial(multiaddr(hubRoute(init.hubPeerId, peerId)));
      return;
    }

    const advertised = (init.meshView()?.members.find((m) => m.peerId === peerId)?.addrs ?? [])
      .filter((addr) => addr.includes("/p2p-circuit") && addr.includes("/webrtc"))
      .map((addr) => multiaddr(addr));

    // Every candidate in ONE dial, not a loop: libp2p ranks and races the
    // addresses of a single peer itself, and a sequential loop would pay the
    // full dial timeout for each unreachable interface address the provider
    // reported (a browser peer behind a relay routinely reports several).
    if (advertised.length > 0) await node.dial(advertised);
    else await preDialPeer(node, relayAddr, peerId);
  };
}

interface InviteRedeemResponse {
  token: string;
  mesh: string;
  roles: string[];
}

/** Redeem `invitationId` against the hub -- `POST /.well-known/invite`, `../hub/endpoints.ts`'s bootstrap handler. No token exists yet: this call is proven by the transport handshake alone. */
export async function redeemInvitation(
  peer: Peer,
  hubPeerId: PeerIdStr,
  invitationId: string,
): Promise<InviteRedeemResponse> {
  const res = await peer.call(
    hubPeerId,
    peerRequest("/.well-known/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: invitationId }),
    }),
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `join: invitation redemption failed (${res.status} ${res.statusText}): ${body}`,
    );
  }
  return (await res.json()) as InviteRedeemResponse;
}

/** This peer's own advertisement, as carried on the heartbeat body -- `../hub/endpoints.ts`'s `PresenceBody.advertisements`. */
export interface AdvertisementInput {
  id: string;
  kind: string;
  title: string;
}

/**
 * Why a presence write was refused, named rather than left as a status
 * code. Three outcomes, and they call for three different things on screen.
 *
 * `not-a-member` -- HTTP 403, `../hub/endpoints.ts`'s presence handler
 * finding no `MemberRecord` for the transport-proven peer. It means one of:
 * this identity has never joined this mesh, its membership was revoked
 * (`/admin/members/{peerId}`), or the hub's own state was reset. All three
 * are "this hub does not know you"; an invitation is the way back in.
 * NOTE that a REVOKED member also lands here rather than on a token check:
 * `usesTransportIdentity()` makes a presence POST a bootstrap request, so
 * the token it carries is never examined and the revocation cache is never
 * consulted -- membership itself is what the handler looks up.
 *
 * `duplicate-identity` -- HTTP 409 `stale-sequence`, and it is the one
 * genuinely surprising diagnosis in this file, so here is why it is sound.
 * The hub tracks the highest `seq` it ever accepted per peer and refuses
 * anything at or below it (`lastSeqByPeer`, which the TTL sweep
 * deliberately does not clear). This runtime's own sequence numbers are
 * seeded from the wall clock (`nextInitialSeq`) and only ever increase, so
 * NOTHING THIS PAGE HAS EVER SENT can be at or below the number it is
 * sending now -- not an earlier beat, not an earlier page load, not a
 * delayed duplicate of either. A 409 therefore means some OTHER live node
 * posted a heartbeat under this peerId, which is to say two libp2p nodes
 * are running one identity: two tabs of the same origin is the ordinary
 * way to get there. That is a real failure (two nodes racing to be "the"
 * peer for one id -- `./identity.ts`'s own note) and not a cosmetic one, so
 * it is reported rather than retried into.
 *
 * `refused` -- anything else, carried verbatim for the page to render.
 */
export type PresenceRefusal =
  | { kind: "not-a-member"; status: number; message: string }
  | { kind: "duplicate-identity"; status: number; message: string }
  | { kind: "refused"; status: number; message: string };

/** Turn a refused presence response into one of the three cases above. Pure, so a test can pin the mapping without a hub. */
export function classifyPresenceRefusal(status: number, body: string): PresenceRefusal {
  if (status === 403) {
    return {
      kind: "not-a-member",
      status,
      message: "this hub does not list this peer as a member",
    };
  }
  if (status === 409) {
    return {
      kind: "duplicate-identity",
      status,
      message: "the hub has already accepted a newer heartbeat for this peer id",
    };
  }
  return { kind: "refused", status, message: body === "" ? `HTTP ${status}` : body };
}

/**
 * The sequence number a fresh run starts from: THE WALL CLOCK, not zero.
 *
 * THIS IS NOT A STYLE CHOICE, IT IS WHAT MAKES RESUMING POSSIBLE AT ALL.
 * The hub keeps `lastSeqByPeer` for the life of the process and refuses any
 * presence write at or below it (`../hub/endpoints.ts`). A page that
 * persists its identity and starts counting from 1 again after a reload
 * would be refused `stale-sequence` on every beat until it had climbed back
 * past wherever its previous run left off -- minutes of a live, joined page
 * silently failing to report presence, and a mesh view in which it never
 * appears. Seeding from `Date.now()` makes every run start above every
 * previous run's numbers by construction (a run advances its own counter by
 * 1 per beat while the clock advances by thousands), which is also exactly
 * the property `PresenceRefusal`'s duplicate-identity diagnosis rests on.
 *
 * The hub compares numbers and nothing else -- it never reads a seq as a
 * time -- so this borrows the clock's monotonicity without giving the value
 * any meaning it has to keep.
 */
export function nextInitialSeq(): number {
  return Date.now();
}

/** What `resumeMembership` found. */
export type ResumeOutcome =
  | { status: "resumed"; token: string; versions: HeartbeatVersions; ttl: number }
  | { status: "refused"; refusal: PresenceRefusal };

export interface ResumeMembershipInit {
  peer: Peer;
  hubPeerId: PeerIdStr;
  /** This peer's own current multiaddrs, exactly as a heartbeat reports them -- see `startJoin`. */
  addrs: string[];
  /** This peer's own advertisements. Omitted (not `[]`) when absent: the hub's handler branches on `advertisements !== undefined`, and `[]` WITHDRAWS. */
  advertisements?: AdvertisementInput[];
  /** This probe's sequence number -- `nextInitialSeq()`, and the number `startJoin` must then continue from. */
  seq: number;
}

/**
 * "Does this hub still consider me a member?" -- asked, and answered,
 * WITHOUT A TOKEN, and answered by an endpoint that already exists.
 *
 * THE ORDERING TRAP THIS WALKS AROUND. Proving membership normally needs a
 * token, and a token is what joining produces; a page resuming a membership
 * has neither, and every ordinary hub read (`/.well-known/mesh` included)
 * is gated on claims it cannot yet present. But `POST
 * /.well-known/presence` is one of exactly two BOOTSTRAP routes
 * (`usesTransportIdentity()` in `../hub/endpoints.ts`): `httpeers.core`'s
 * binding middleware sees it, skips the token check and the access tree
 * entirely, and hands the handler the peer id the libp2p handshake itself
 * proved. That handler then looks the peer up in the member store and
 * either mints a fresh token or answers 403. Which is precisely the
 * question, precisely the proof, and precisely the credential -- so this
 * needs no new route, and adding one would have been adding a second,
 * weaker answer to a question the hub already answers.
 *
 * IT IS ALSO THE FIRST HEARTBEAT, NOT A PROBE BESIDE ONE. The body is an
 * ordinary presence write, so a successful resume has already reported this
 * peer's addresses and advertisements and is already visible in the mesh
 * view -- there is no window where the page is "resumed" but absent. Its
 * `seq` is the one `startJoin` continues from (`JoinInit.initialSeq`).
 *
 * Transport failures are NOT caught here: a call that never reached the hub
 * is a different fact from a hub that answered, and only the caller knows
 * what to say about it (`./peer-runtime.ts` does).
 */
export async function resumeMembership(init: ResumeMembershipInit): Promise<ResumeOutcome> {
  const res = await init.peer.call(
    init.hubPeerId,
    peerRequest("/.well-known/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seq: init.seq,
        addrs: init.addrs,
        ...(init.advertisements !== undefined ? { advertisements: init.advertisements } : {}),
      }),
    }),
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { status: "refused", refusal: classifyPresenceRefusal(res.status, body) };
  }

  const parsed = (await res.json()) as PresenceHeartbeatResponse;
  return { status: "resumed", token: parsed.token, versions: parsed.versions, ttl: parsed.ttl };
}

/** The three version counters a heartbeat response reports; each gates only its own section. See `startJoin`. */
export interface HeartbeatVersions {
  mesh: number;
  policy: number;
  rules: number;
}

interface PresenceHeartbeatResponse {
  token: string;
  versions: HeartbeatVersions;
  ttl: number;
}

interface RevocationsResponse {
  version: number;
  entries: ChangeEntry[];
}

/** How often the presence heartbeat fires -- design note's Step 3, 5 s. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How often the connection-keepalive timer checks the link to the hub.
 * DELIBERATELY SEPARATE from `HEARTBEAT_INTERVAL_MS`: a heartbeat that
 * fails to send says "the request failed," which could be the connection,
 * the hub, or a revoked membership -- it does not by itself diagnose
 * "the underlying libp2p connection to the hub is gone." This timer
 * checks that fact directly (`node.getConnections(hubPeerId)`) and
 * re-runs the `/webrtc` pre-dial when it finds nothing open, independent
 * of whether a heartbeat happens to be in flight at the same moment.
 * Matches the interval the validated p2p-demo prototype uses for the same
 * purpose (`workspaces/webrun-wire/apps/p2p-demo/server-page/main.ts`,
 * "relay link lost; re-dialing").
 */
export const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * How long a pulled revocation snapshot may go unconfirmed before this
 * peer refuses every token rather than trust one it can no longer vouch
 * for (`RevocationCache`'s own `maxStalenessMs` -- "there is a case that
 * no default is correct and this should be required," `revocation.ts`).
 * Generous relative to `HEARTBEAT_INTERVAL_MS` deliberately: the cache's
 * freshness clock is reset on EVERY successful heartbeat (see
 * `startJoin` below), not only when `versions.policy` actually moves, so
 * this bound is really "how many consecutive heartbeats may fail before
 * this peer stops trusting its own revocation snapshot," not "how often
 * the policy must change." Twelve missed 5 s heartbeats' worth of
 * tolerance before a live peer starts refusing tokens on staleness alone.
 */
export const REVOCATION_MAX_STALENESS_MS = 60_000;

export interface JoinInit {
  peer: Peer;
  node: Libp2p;
  hubPeerId: PeerIdStr;
  relayAddr: string;
  /** The token that got this peer in -- `redeemInvitation`'s, or `resumeMembership`'s. `startJoin` owns rotating it from here on; the heartbeat response mints a fresh one every call. */
  initialToken: string;
  /**
   * The sequence number the FIRST heartbeat continues from -- the one
   * `resumeMembership` already spent, when there was a resume. Defaults to
   * `nextInitialSeq()`; see that function for why the default is the wall
   * clock and not zero, and why passing the probe's own number here (rather
   * than drawing a second one) is what keeps this run's sequence strictly
   * increasing across the join itself.
   */
  initialSeq?: number;
  revocationCache: RevocationCache;
  /** This peer's own advertisements, read fresh on every heartbeat. Defaults to none. */
  advertisements?: () => AdvertisementInput[];
  heartbeatIntervalMs?: number;
  keepaliveIntervalMs?: number;
  /**
   * How the keepalive restores a hub link it found gone. Defaults to
   * `reachHub`. A member on the relay fallback passes its own -- WebRTC first,
   * then a new kept circuit -- because `reachHub` alone would never bring the
   * circuit back.
   */
  relinkHub?: () => Promise<void>;
  /** Fired after each successful heartbeat, whether or not any version moved -- for a caller that wants to observe liveness, not just react to a version bump. */
  onHeartbeat?: (versions: HeartbeatVersions) => void;
  /**
   * Fired when the hub REFUSED a heartbeat -- a membership that went away
   * under a live page, or a second node running this identity. Both are
   * things an operator has to be told rather than left to infer from a page
   * that quietly stops appearing in the mesh; see `PresenceRefusal`.
   * Transport failures do NOT come through here: those are the keepalive
   * timer's business and the next tick retries them.
   */
  onPresenceRefused?: (refusal: PresenceRefusal) => void;
}

export interface JoinHandle {
  /** The mesh view as of the last time `versions.mesh` moved -- `null` until the first heartbeat lands. Never fetched more often than that: re-fetching every heartbeat regardless of whether anything changed is exactly the design the version vector replaces. */
  meshView(): MeshView | null;
  /** The mesh's published rule set as of the last time `versions.rules` moved -- `null` until the first heartbeat lands. READ-ONLY in the strict sense (ADR-0016): what it returns influences no decision here or anywhere else; this page's own policy is its own value. */
  rules(): RuleSet | null;
  /**
   * This peer's CURRENT membership token, read at call time.
   *
   * A GETTER, NOT A VALUE, AND THAT IS THE WHOLE POINT. The hub mints a
   * fresh token on every heartbeat response (see `heartbeatOnce` below,
   * `token = body.token`), so the token rotates roughly every
   * `HEARTBEAT_INTERVAL_MS`. Anything that read this once and cached the
   * string would be sending a stale token within seconds; a caller that
   * calls this per outbound request always has the live one. This exists
   * for `edge-dispatch.ts`, which attaches it to requests originating at
   * this peer's own ServiceWorker edge -- see that module for why the PAGE
   * is never handed a token of its own.
   */
  token(): string;
  stop(): void;
}

/**
 * Start the presence heartbeat and the connection-keepalive timer over an
 * already-joined peer (post `redeemInvitation`). Fires an immediate
 * heartbeat rather than waiting for the first interval tick, so a caller
 * observing `meshView()` sees a populated view as soon as the network
 * allows rather than up to `heartbeatIntervalMs` later.
 *
 * THREE TIMERS, KEPT APART (design note's Step 3 / note 07 §6). This
 * function owns two of them -- the heartbeat and the keepalive, below.
 * THE THIRD, the reservation on the relay, is NOT started here either:
 * libp2p renews a reservation it holds on its own schedule, and restoring
 * one lost with the relay link -- which libp2p attempts once and then never
 * again -- is `../reservation.ts`'s `superviseRelay`, started by the
 * runtime. The keepalive below is NOT that: it watches the HUB connection,
 * which can stay up over WebRTC after the relay link is gone. Folding
 * either into these two would conflate "is my reservation still valid"
 * with "does the hub still consider me a member" or "is my connection to
 * the hub still open" -- three questions this design keeps separate
 * because they fail independently and mean different things.
 */
export function startJoin(init: JoinInit): JoinHandle {
  const { peer, node, hubPeerId, relayAddr, revocationCache } = init;
  const heartbeatIntervalMs = init.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const keepaliveIntervalMs = init.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;

  let token = init.initialToken;
  let seq = init.initialSeq ?? nextInitialSeq();
  let heartbeatInFlight = false;

  let meshViewCache: MeshView | null = null;
  let meshVersion = 0;
  let rulesCache: RuleSet | null = null;
  let rulesVersion = 0;
  let revocationEntriesCache: ChangeEntry[] = [];

  async function heartbeatOnce(): Promise<void> {
    if (heartbeatInFlight) return; // never overlap two in-flight heartbeats -- see the module comment on why this is safe to just skip a tick rather than queue.
    heartbeatInFlight = true;
    // EVERYTHING BELOW IS INSIDE ONE try/catch, DELIBERATELY -- not only
    // the presence call. `heartbeatOnce` is invoked as `void
    // heartbeatOnce()` (fire-and-forget, on a `setInterval`), so ANY
    // rejection that escapes it -- a dropped connection mid-call, a
    // malformed JSON body from the hub, a follow-up GET failing after the
    // presence POST already succeeded -- becomes an unhandled promise
    // rejection, not the "next tick retries" behaviour the rest of this
    // function's comments describe. A single catch-all below is what
    // actually delivers that contract; catching only the first call and
    // leaving the rest unprotected (an earlier version of this function)
    // does not (found on review; reproduced by forcing an unconditional
    // refetch and watching a follow-up call's rejection escape uncaught).
    try {
      seq += 1;
      // THE PEER'S OWN CURRENT MULTIADDRS -- `node.getMultiaddrs()`, read
      // fresh on every heartbeat. This is what makes THIS peer's own
      // addresses the freshest possible source for OTHER peers reading
      // them back out of the mesh view -- see `JoinHandle.meshView`'s doc
      // comment and `peer-runtime.ts`'s module comment for the other half
      // of this contract (never read a PEER's addrs from libp2p's own
      // `peerStore`).
      const addrs = node.getMultiaddrs().map((addr) => addr.toString());
      const advertisements = init.advertisements?.() ?? [];

      const res = await peer.call(
        hubPeerId,
        peerRequest("/.well-known/presence", {
          method: "POST",
          token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seq, addrs, advertisements }),
        }),
      );
      if (!res.ok) {
        // A refusal is not a transport fault and must not be swallowed with
        // one: 403 means this peer is no longer a member (revoked, or the
        // hub's state was reset) and 409 means a SECOND node is beating
        // under this identity. Both are permanent until someone acts, so a
        // page that only stopped advancing its caches would sit there
        // looking joined. Every cache is still left exactly as it was --
        // that part was always right.
        init.onPresenceRefused?.(
          classifyPresenceRefusal(res.status, await res.text().catch(() => "")),
        );
        return;
      }

      const body = (await res.json()) as PresenceHeartbeatResponse;
      token = body.token; // rotates every heartbeat -- the hub mints a fresh token on each call.

      if (body.versions.mesh !== meshVersion) {
        const meshRes = await peer.call(
          hubPeerId,
          peerRequest("/.well-known/mesh", { method: "GET", token }),
        );
        if (meshRes.ok) {
          meshViewCache = (await meshRes.json()) as MeshView;
          meshVersion = body.versions.mesh;
        }
      }

      if (body.versions.rules !== rulesVersion) {
        const rulesRes = await peer.call(
          hubPeerId,
          peerRequest("/.well-known/rules", {
            method: "GET",
            token,
          }),
        );
        if (rulesRes.ok) {
          rulesCache = (await rulesRes.json()) as RuleSet;
          rulesVersion = body.versions.rules;
        }
      }

      if (body.versions.policy !== revocationCache.knownVersion()) {
        const revRes = await peer.call(
          hubPeerId,
          peerRequest("/.well-known/revocations", {
            method: "GET",
            token,
          }),
        );
        if (revRes.ok) {
          const revBody = (await revRes.json()) as RevocationsResponse;
          revocationEntriesCache = revBody.entries;
        }
      }
      // Refresh the cache's freshness stamp on EVERY successful heartbeat
      // -- see `REVOCATION_MAX_STALENESS_MS`'s doc comment for why this is
      // NOT gated on the policy version having actually moved.
      revocationCache.update(body.versions.policy, revocationEntriesCache);

      init.onHeartbeat?.(body.versions);
    } catch {
      // Dial/transport failure, a malformed response body, or any other
      // fault anywhere in the sequence above -- leave every cached value
      // exactly as it was; the next tick retries from scratch.
      // `KEEPALIVE_INTERVAL_MS`'s timer is what actually diagnoses and
      // repairs a dropped connection to the hub; this heartbeat has no
      // business doing that job too, only refusing to crash the page over
      // it.
    } finally {
      heartbeatInFlight = false;
    }
  }

  const heartbeatTimer = setInterval(() => void heartbeatOnce(), heartbeatIntervalMs);
  void heartbeatOnce();

  let hubPeerIdObj: PeerId | undefined;
  try {
    hubPeerIdObj = peerIdFromString(hubPeerId);
  } catch {
    hubPeerIdObj = undefined; // malformed hubPeerId -- the keepalive timer below simply never finds a match and keeps re-predialling, which is the correct degraded behaviour.
  }

  // `reachHub`, not a bare pre-dial: it also closes the limited signalling
  // circuit, which would otherwise break relaying THROUGH the hub (and so
  // restoring this page's reservation on it) -- see `../hub-link.ts`.
  const relinkHub = init.relinkHub ?? (() => reachHub(node, relayAddr, hubPeerId));
  // One re-link at a time: the relay fallback tries WebRTC first and can
  // outlast a tick, and two overlapping attempts would open two circuits.
  let relinking = false;

  // A KEPT LIMITED CIRCUIT COUNTS AS OPEN, so a member on the relay fallback is
  // left alone for as long as its circuit lives -- nothing here closes or
  // replaces it -- and re-links only once it has gone.
  const keepaliveTimer = setInterval(() => {
    const stillOpen =
      hubPeerIdObj != null && node.getConnections(hubPeerIdObj).some((c) => c.status === "open");
    if (stillOpen || relinking) return;
    relinking = true;
    void relinkHub()
      .catch(() => {
        // Best-effort -- the next tick retries, and a heartbeat that keeps
        // failing on its own schedule surfaces the same underlying
        // unreachability independently.
      })
      .finally(() => {
        relinking = false;
      });
  }, keepaliveIntervalMs);

  return {
    meshView: () => meshViewCache,
    rules: () => rulesCache,
    token: () => token, // read at call time, never snapshotted -- see `JoinHandle.token`.
    stop() {
      clearInterval(heartbeatTimer);
      clearInterval(keepaliveTimer);
    },
  };
}

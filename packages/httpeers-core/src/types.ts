/**
 * Shared contracts for the httpeers mesh.
 *
 * This file imports nothing. Anything in the mesh — hub, provider, client,
 * or a test — can depend on it without pulling in libp2p, crypto, or a
 * store's runtime.
 */

/** A libp2p `fetch` handler: the shape every peer serves and calls. */
export type FetchHandler = (req: Request) => Promise<Response>;

/** A peerId, in whatever string encoding the transport uses (base58 or base36). */
export type PeerIdStr = string;

/**
 * The sentinel for "no member was proven for this call."
 *
 * Never use `undefined` for this. `undefined` means a binding is missing —
 * a caller that forgot to set the field, which is a bug. `ANONYMOUS` means a
 * binding was made, deliberately, to "nobody proven" — a legitimate policy
 * input (an open, unauthenticated route serves anonymous callers on
 * purpose). Code that branches on identity must be able to tell "nobody
 * wired this up" apart from "this call really is anonymous." Absence is a
 * bug; anonymity is a value.
 *
 * Uses the global symbol registry (`Symbol.for`, not `Symbol()`): this
 * package is consumed by both Node peers and browser bundles, and separate
 * module instances of the same package must still produce a sentinel that
 * is `===` to each other, or an identity check fails silently.
 */
export const ANONYMOUS: unique symbol = Symbol.for("httpeers.anonymous");

/** The type of the `ANONYMOUS` sentinel. */
export type Anonymous = typeof ANONYMOUS;

/**
 * Who a request is bound to, once identity has been resolved: either a
 * peerId that was actually proven (by the transport handshake), or
 * `ANONYMOUS` — proven, deliberately, to be nobody. See `ANONYMOUS` above
 * for why this is never `undefined`.
 */
export type ProvenPeer = PeerIdStr | Anonymous;

/**
 * A signed membership claim, minted by a mesh's hub.
 *
 * Field-compatible with the `Claims` shape used by the revocation prototype
 * (`sub`, `mesh`, `roles`, `iat`, `exp` — see `apps/httpeers-protos/lib/
 * revocation.ts`), plus `iss`: the standard JWT issuer claim, carried for
 * interop with generic JWT tooling. In this reference deployment one hub
 * serves one mesh, so `iss` and `mesh` are minted with the same peerId; they
 * stay separate fields because a federated or key-rotating mesh may one day
 * need "who signed this" (`iss`) to differ from "which mesh this grants
 * membership in" (`mesh`).
 *
 * The token is self-certifying: `mesh` names the hub's own peerId, so a
 * verifier who recovers the signing key from that same peerId learns, from
 * one check, both "this signature is valid" and "the signer is who it
 * claims to be." `sub === provenPeer` (did the caller who presented this
 * token prove, via the transport handshake, that they are the subject) is
 * left to the binding middleware — it is not a token-verification concern.
 */
export interface MeshClaims {
  /** peerId of the member this token was minted for. */
  sub: string;
  /** peerId of the signing hub — the standard JWT issuer claim. */
  iss: string;
  /**
   * peerId of the hub whose membership this token grants. Checked against
   * the verifying policy's expected issuer — the self-certification check.
   */
  mesh: string;
  roles: string[];
  /**
   * Issued-at, in hub time. Without it, revocation is all-or-nothing: there
   * is no way to tell a token minted before a role change from one minted
   * after, so re-admitting a member is impossible.
   */
  iat: number;
  /** Expiry, in hub time. */
  exp: number;
  /**
   * The peers this token may be presented to (ADR-0020), in one of three
   * states — and they are three, not two, because the ADR insists an
   * unrestricted token be a DISTINCT, EXPLICIT state rather than the absence
   * of a field:
   *
   *   - `PeerIdStr[]`  — restricted: only these peers, never empty, sorted.
   *   - `"unrestricted"` — the token SAYS it is valid at every peer.
   *   - `"unstated"`   — the token says nothing at all about audience.
   *
   * `"unstated"` exists for tokens minted before this field did. `mintToken`
   * cannot produce one: it always writes one of the other two into the
   * authority block. A verifier treats `"unstated"` as unrestricted, which is
   * safe only because the audience facts and their check live in the SIGNED
   * authority block — an attacker holding a restricted token cannot strip
   * them down to silence without the hub's key. Silence is therefore always
   * an old issuer, never a downgrade. See `tokens.ts`'s "THE AUDIENCE".
   *
   * Enforcement is NOT here. The destination enforces, inside the token's own
   * Datalog, against a `self_peer` fact the destination asserts about itself
   * — this field only reports what the token turned out to say.
   */
  audience: PeerIdStr[] | "unrestricted" | "unstated";
}

/** A durable membership record kept by the hub. */
export interface MemberRecord {
  /** peerId of the member. */
  peerId: string;
  roles: string[];
  /** When this member was added (or last had its roles replaced), in hub time. */
  updatedAt: number;
}

/**
 * The hub's durable member registry: who belongs to the mesh and with what
 * roles. Membership persists until explicitly removed — there is no TTL
 * here. (Revoking a live token before its `exp` is a separate concern; see
 * `revocation.ts` in the prototype app, which a later task promotes.)
 */
export interface MemberStore {
  add(peerId: string, roles: string[]): MemberRecord;
  setRoles(peerId: string, roles: string[]): MemberRecord;
  remove(peerId: string): void;
  get(peerId: string): MemberRecord | undefined;
  list(): MemberRecord[];
}

/** One peer's last-known liveness, as stamped by the hub. */
export interface PresenceRecord {
  peerId: string;
  /** Monotonic per-peer sequence number supplied by the caller. */
  seq: number;
  /** Hub time after which this record is considered stale and may be swept. */
  expiresAt: number;
}

/** Why a presence write was refused. */
export type PresenceWriteRejection = "stale-sequence";

export type PresenceWriteResult =
  | { accepted: true; record: PresenceRecord }
  | { accepted: false; reason: PresenceWriteRejection };

/**
 * The hub's presence registry: a TTL'd, swept table of "who is live right
 * now."
 *
 * Writes are monotonic per peer: a write is accepted only if its `seq` is
 * strictly greater than the peer's last accepted `seq`. This is deliberate
 * — a delayed retry (a heartbeat that got stuck in the network and arrives
 * late) must not resurrect a peer that has since sent a newer heartbeat or
 * left. Sequence numbers are supplied by the caller and compared per peer
 * only; there is no cross-peer ordering guarantee, and wall-clock time is
 * never compared across peers.
 */
export interface PresenceStore {
  heartbeat(peerId: string, seq: number, ttlMs: number): PresenceWriteResult;
  isPresent(peerId: string): boolean;
  get(peerId: string): PresenceRecord | undefined;
  list(): PresenceRecord[];
  /** Remove every record whose `expiresAt` has passed. Returns the removed peerIds. */
  sweep(): string[];
}

/** One capability a peer has posted to the mesh's bulletin board. */
export interface Advertisement {
  peerId: string;
  /** The capability or route being advertised, e.g. a service name. */
  key: string;
  payload: unknown;
  postedAt: number;
}

/**
 * The hub's advertisement registry: a bulletin board of what peers offer.
 * Unlike presence, entries are durable — they persist until the posting
 * peer replaces or withdraws them, not on a timer.
 */
export interface AdvertisementStore {
  post(peerId: string, key: string, payload: unknown): Advertisement;
  withdraw(peerId: string, key: string): void;
  get(peerId: string, key: string): Advertisement | undefined;
  /** All advertisements, optionally filtered to one peer. */
  list(peerId?: string): Advertisement[];
}

/**
 * Dial another peer and get its response. Injected by the transport — the
 * core never imports a transport package, so it never constructs one of
 * these itself.
 */
export type Remote = (peerId: PeerIdStr, req: Request) => Promise<Response>;

/**
 * Resolve the transport-proven peer for a request — the identity the
 * handshake itself established, never anything the caller merely claims.
 *
 * Returns `ProvenPeer`, and by contract *never* `undefined`: a real
 * implementation built on `lookupPeer` (`peer-context.ts`) that finds no
 * binding is looking at a bug — something re-created the `Request` above
 * the binding middleware — not a legitimate "nobody" value. `ANONYMOUS` is
 * the legitimate value for "proven, deliberately, to be nobody." The
 * binding middleware (`peer-handlers.ts`) still guards against a caller
 * that violates this contract, by throwing `PeerBindingLostError` rather
 * than silently treating a stray `undefined` as `ANONYMOUS`.
 */
export type GetPeerId = (req: Request) => Promise<ProvenPeer>;

/**
 * Why a token was refused. A closed set rather than prose, so a caller can
 * branch on it and a test can assert it without matching on wording.
 *
 * LIVES HERE, NOT IN `tokens.ts`, EVEN THOUGH `tokens.ts` IS WHAT RAISES IT.
 * `peer-handlers.ts` has to map a refusal onto a status code, and that file
 * deliberately imports no crypto and no transport (see its module comment);
 * `tokens.ts` is one of the two files in this package allowed to import
 * libp2p. A shared vocabulary that both the raiser and the decider can name
 * therefore belongs in the file that imports nothing. `TokenVerificationError`
 * itself stays in `tokens.ts`.
 *
 * `signature` deliberately collapses two cases the JWS version reported
 * separately ("invalid signature" and "token was not minted for this mesh").
 * The JWS version could tell them apart only because it verified against the
 * mesh the TOKEN declared and compared afterwards; a Biscuit is verified
 * against the mesh key the VERIFIER expects, which is the correct order and
 * leaves nothing to distinguish "corrupted" from "signed by someone else."
 * `mesh-mismatch` survives as its own reason: it is the token's `mesh` fact
 * disagreeing with the key that just verified it.
 */
export type TokenRejectionReason =
  | "unparseable-issuer"
  | "issuer-not-ed25519"
  | "malformed-token"
  | "signature"
  | "mesh-mismatch"
  | "peer-binding"
  /** ADR-0020: this verifier is not among the peers the token names. */
  | "audience"
  | "expired"
  | "unsatisfied-constraint"
  | "evaluation-budget"
  | "malformed-claims";

/**
 * What `GetClaims` found on a request. THREE STATES, NOT TWO — and the third
 * is the whole point.
 *
 * Its predecessor was `MeshClaims | null`, and `null` meant both "no token
 * was presented" and "a token was presented and rejected". A caller could not
 * tell them apart, so `peer-handlers.ts` answered `401 "membership token
 * required"` to both — including to a client refused because THIS peer is not
 * an intended audience for its token (ADR-0020). That client refreshes,
 * presents a token refused for exactly the same reason, and loops forever
 * with nothing in the response telling it that refreshing cannot help.
 * Widening this type is what makes that distinction expressible at all; the
 * status split lives in `peer-handlers.ts`, which is where the decision is.
 *
 *   - `absent`   — no `authorization: Bearer` header at all.
 *   - `verified` — a token that passed every check, claims included.
 *   - `refused`  — a token was presented and did not verify. `reason` is the
 *     matchable discriminant; `detail` is the one-line prose a refusal
 *     surfaces to a human; `failedChecks` is the Datalog rule text of every
 *     check that failed (spec P8), empty for a cryptographic or structural
 *     refusal.
 */
export type ClaimsResult =
  | { status: "absent" }
  | { status: "verified"; claims: MeshClaims }
  | {
      status: "refused";
      reason: TokenRejectionReason;
      detail: string;
      failedChecks: readonly string[];
    };

/**
 * Verify a request's membership claims and say what was found — present and
 * good, absent, or presented and refused with a reason. See `ClaimsResult`
 * for why this is not `MeshClaims | null`.
 */
export type GetClaims = (req: Request) => Promise<ClaimsResult>;

/**
 * Does this request bootstrap identity from the transport handshake alone,
 * with no JWT expected yet?
 *
 * Renamed from an earlier `isTrustedPath`: that name read as "a path we
 * trust," which invites new entries for the wrong reason. What it actually
 * means is narrower — no token exists yet, so the transport identity is the
 * *sole* source of truth for this one request. True of exactly two requests
 * in the whole system, both on the hub: `POST /.well-known/invite` and the
 * `POST /.well-known/presence` check-in that mints the token.
 *
 * Deliberately request-level, not path-level: a presence *write* is
 * bootstrap, but a presence *read* on the same path is an ordinary,
 * token-bearing request, so this must be able to discriminate by method
 * (or any other request property) — not just by URL.
 */
export type UsesTransportIdentity = (req: Request) => Promise<boolean>;

/** The router's local mount table: longest-prefix match, or nothing. */
export interface Mounts {
  match: (path: string) => FetchHandler | null;
}

/** Build a JSON `Response` with the right content-type header. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

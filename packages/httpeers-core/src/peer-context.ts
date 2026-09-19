/**
 * A request's proven identity, carried in a HEADER — and the claims it earned,
 * cached beside it.
 *
 * WHY A HEADER AND NOT A `WeakMap`. The binding used to live in a
 * `WeakMap<Request, ProvenPeer>`: unforgeable, but it does not survive a
 * re-created `Request`, and re-creating one is what handlers do. Seven places
 * in these packages build a new `Request` from an old one and exactly one
 * remembered to carry the binding across. The rest are outbound-by-design, so
 * it was correct by author discipline — with no test guarding it, and no way
 * for third-party middleware (a Hono router, a caller's own wrapper) to know
 * the rule existed. A header survives all of them for free, because
 * `new Request(url, req)` copies headers, and it is inspectable, which lets
 * the security property be tested in plain HTTP.
 *
 * THE COST, AND THE RULE THAT PAYS IT. A header is whatever the caller typed.
 * It is trustworthy only where something STRIPS it before setting it, so this
 * module makes stripping the only way to write it: `registerPeer` and
 * `registerAnonymous` always delete first, and `stripPeerBinding` is the
 * ingress primitive for a request that proved nothing (a page's own fetch into
 * its edge). EVERY entry point into a peer must call exactly one of the three,
 * and a path that forgets is the forgery hole — which is why each adapter
 * tests its own ingress rather than trusting this note.
 *
 * The CLAIMS cache stays a `WeakMap`. It is a locally derived value, not an
 * input: losing it across a re-created request costs one re-verification and
 * nothing else, and it must never travel on the wire.
 */
import {
  ANONYMOUS,
  type ClaimsResult,
  type MeshClaims,
  type PeerIdStr,
  type ProvenPeer,
} from "./types.js";

const claims = new WeakMap<Request, ClaimsResult>();

/**
 * Where the proven peer travels. Namespaced like the ghost's own marker, and
 * exported so an adapter can strip it without re-deriving the spelling.
 */
export const PEER_ID_HEADER = "x-httpeers-peer";

/**
 * Where the membership token travels: the bare token, no auth scheme.
 *
 * NOT `Authorization`. That header belongs to the application a request is
 * addressed to -- a page calling LiteLLM through the mesh puts LiteLLM's key
 * there -- and while the mesh read its token from the same header the two
 * collided: the edge would not overwrite the page's value, so the provider
 * tried to verify an application key as a mesh token and refused it
 * `malformed-token`. Every writer (`peerRequest`, the ServiceWorker edge, the
 * ghost) and the one reader (`withAccess`) go through this spelling.
 */
export const MESH_TOKEN_HEADER = "x-httpeers-token";

/**
 * The mesh's own headers: what a request LEAVING the mesh must not carry. A
 * proxy re-issuing a request to a third party passes this as its strip list,
 * so the upstream learns neither a membership token nor which peer called.
 * `Authorization` is deliberately absent -- it is the application's, and is
 * forwarded.
 */
export const MESH_CREDENTIAL_HEADERS: readonly string[] = [MESH_TOKEN_HEADER, PEER_ID_HEADER];

/** Put `token` in `headers` as the membership token, replacing any other. */
export function setMeshToken(headers: Headers, token: string): void {
  headers.set(MESH_TOKEN_HEADER, token);
}

/**
 * The membership token a request carries, or `null` for none. An empty header
 * is none, and `Authorization` is never consulted -- see `MESH_TOKEN_HEADER`.
 */
export function readMeshToken(req: Request): string | null {
  const token = req.headers.get(MESH_TOKEN_HEADER)?.trim();
  return token == null || token === "" ? null : token;
}

/**
 * The wire spelling of `ANONYMOUS`.
 *
 * A symbol cannot be a header value, so the sentinel needs an encoding — and
 * one that no real peerId can collide with. Peer ids are base58 `12D3Koo…`,
 * `Qm…` or base36 `k51…`; a lowercase English word is none of those.
 * `ProvenPeer` is unchanged in memory, so every downstream `=== ANONYMOUS`
 * check keeps working: only the encoding is new.
 */
export const ANONYMOUS_HEADER_VALUE = "anonymous";

/**
 * Bind a request to a peerId the TRANSPORT proved.
 *
 * The `delete` is redundant and deliberate. `Headers.set` already replaces
 * every existing value for a name — verified, not assumed — so this does not
 * guard against a stale entry surviving. It is here so that the three writers
 * in this module read identically and so that "a write is always a strip
 * first" is visible at the call site rather than inferred from `set`'s spec.
 * Remove it and nothing breaks today; the next person to reach for `append`
 * is the one it is written for.
 */
export function registerPeer(req: Request, peerId: PeerIdStr): void {
  req.headers.delete(PEER_ID_HEADER);
  req.headers.set(PEER_ID_HEADER, peerId);
}

/** Bind a request to `ANONYMOUS`: proven, deliberately, to be nobody. Strips first, for the same reason. */
export function registerAnonymous(req: Request): void {
  req.headers.delete(PEER_ID_HEADER);
  req.headers.set(PEER_ID_HEADER, ANONYMOUS_HEADER_VALUE);
}

/**
 * Ingress for a request that crossed no wire: remove any claimed identity and
 * assert nothing.
 *
 * This is what a local edge calls. A page's own script can set any header it
 * likes on a `fetch()` into its ServiceWorker, so without this the page could
 * name itself any peer in the mesh and the local mounts would believe it.
 */
export function stripPeerBinding(req: Request): void {
  req.headers.delete(PEER_ID_HEADER);
}

/** `undefined` means no binding was made — a local origin, or a bug. Never "anonymous". */
export function lookupPeer(req: Request): ProvenPeer | undefined {
  const raw = req.headers.get(PEER_ID_HEADER);
  if (raw === null) return undefined;
  return raw === ANONYMOUS_HEADER_VALUE ? ANONYMOUS : raw;
}

/**
 * Carry the CLAIMS cache across a deliberate re-creation of the Request.
 *
 * The peer binding no longer needs this — it is a header, and headers are
 * copied by every form of re-creation. What is still worth carrying is the
 * verification result, so a re-created request does not pay to verify the same
 * token twice. Forgetting it is now a performance bug rather than an identity
 * one, which is the whole point of the change.
 */
export function copyPeerBinding(from: Request, to: Request): void {
  const result = claims.get(from);
  if (result !== undefined) claims.set(to, result);
}

/**
 * Cache what `getClaims` found for a request — the full `ClaimsResult`, not
 * just the claims, so a second read can still say WHY a presented token was
 * refused rather than reporting it as absent.
 */
export function cacheClaims(req: Request, value: ClaimsResult): void {
  claims.set(req, value);
}

/**
 * The USABLE claims for a request: `null` when nothing usable was found
 * (absent or refused — policy cannot act on either), `undefined` when claims
 * were never looked up at all.
 *
 * Policy's contract is deliberately unchanged by the widening: the authorizer
 * decides on facts, and a refused token contributes no facts, so the two
 * non-verified states are genuinely the same input to it. Anything that needs
 * to tell them apart reads `lookupClaimsResult` below — today that is the
 * peer assembly's inbound path, which caches a verification result and then
 * asks whether it was a refusal. (This note used to name `peer-handlers.ts`,
 * which does not read it and never did.)
 */
export function lookupClaims(req: Request): MeshClaims | null | undefined {
  const result = claims.get(req);
  if (result === undefined) return undefined;
  return result.status === "verified" ? result.claims : null;
}

/** The full result, including the reason a presented token was refused. */
export function lookupClaimsResult(req: Request): ClaimsResult | undefined {
  return claims.get(req);
}

/**
 * The forwarding policy every assembly with a local edge actually wants:
 * forward what originated HERE, never what arrived from the network.
 *
 * WHY THIS IS NAMED RATHER THAN INLINED. `createPeerRouter` denies forwarding
 * by default and asks the caller for a policy, which is right — relaying is a
 * capability and R-2 says deny by default. But every caller that mounts a
 * local edge needs the same policy, and the extraction proved what happens
 * when one of them re-derives it by omission: `startMember` passed no policy,
 * the router denied everything, and a member could not call another member
 * through its own edge at all. The types were perfectly happy; only a mesh
 * standing up for real found it.
 *
 * `undefined` from `lookupPeer` means NO BINDING WAS MADE — the request carries
 * no proven-peer header, so it originated at our own edge (which strips one
 * before dispatching). `ANONYMOUS` is NOT absence: it means the transport
 * proved there was no identity, which is still "arrived from the network".
 * Reading the sentinel as absence would turn this peer into an open relay for
 * anonymous callers, which is exactly the R-2 hole, so the check is against
 * `undefined` and nothing else.
 *
 * A request carrying a header nobody stripped therefore fails SAFE here: it
 * reads as "from the network" and is refused. That is the right direction, but
 * it is not a substitute for stripping at ingress — authorization reads the
 * same header.
 *
 * A peer that should relay for OTHERS needs a different, explicit policy —
 * that is a deliberate capability, not this.
 */
export async function forwardLocalOnly(req: Request, _target: PeerIdStr): Promise<boolean> {
  return lookupPeer(req) === undefined;
}

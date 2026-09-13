/**
 * Carries a request's proven identity alongside the `Request` object
 * itself, rather than as a second function parameter.
 *
 * Why a `WeakMap` and not a field on a richer request type: the router and
 * every handler downstream of it work in plain `Request -> Response`
 * (`FetchHandler`), the same shape a transport's `fetch` handler or a
 * browser `fetch` polyfill already expects. Threading identity as an extra
 * argument would mean every handler signature in the mesh carries a
 * parameter most of them never look at. A `WeakMap` keyed on the `Request`
 * instance keeps the contract at one argument while still letting anything
 * holding that exact `Request` ask "who is this from" — and it never leaks:
 * once the `Request` is garbage-collected, so is its entry.
 *
 * The one place this needs help is a *deliberate* re-creation of the
 * `Request` (the router strips a peer prefix by constructing a new
 * `Request` with the shortened URL) — a new object has no entry of its own,
 * so `copyPeerBinding` carries the binding across that boundary by hand.
 */
import {
  ANONYMOUS,
  type ClaimsResult,
  type MeshClaims,
  type PeerIdStr,
  type ProvenPeer,
} from "./types.js";

const peers = new WeakMap<Request, ProvenPeer>();
const claims = new WeakMap<Request, ClaimsResult>();

/** Bind a request to a peerId that was actually proven by the transport. */
export function registerPeer(req: Request, peerId: PeerIdStr): void {
  peers.set(req, peerId);
}

/** Bind a request to the `ANONYMOUS` sentinel: proven, deliberately, to be nobody. */
export function registerAnonymous(req: Request): void {
  peers.set(req, ANONYMOUS);
}

/** `undefined` means no binding was ever made — a bug, not a value. */
export function lookupPeer(req: Request): ProvenPeer | undefined {
  return peers.get(req);
}

/** Carry the binding(s) across a deliberate re-creation of the Request. */
export function copyPeerBinding(from: Request, to: Request): void {
  const peer = peers.get(from);
  if (peer !== undefined) peers.set(to, peer);
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

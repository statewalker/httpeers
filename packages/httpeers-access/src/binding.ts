/**
 * The binding middleware: asserts the token's subject is the peer the
 * transport handshake actually proved.
 *
 * A hub-minted token is a bearer token, valid at every provider that trusts
 * the hub — so without this check, a malicious provider could replay a
 * member's token against a different provider and act as that member
 * there. Binding `claims.sub` to what the transport itself proved
 * (`getPeerId`, fed by the handshake, never by anything the caller claims)
 * is what defeats that confused-deputy replay.
 *
 * Every seam is injected, so this file has no crypto, no transport and no
 * libp2p import — testable with one-line stubs. It also does no policy:
 * whether a *particular path* is permitted for a given role is
 * `rules.ts`'s job, not this one. This middleware only answers "is
 * the caller who they say they are, and is their token still good" — the
 * same class of question as the signature and expiry checks inside
 * `verifyToken`, which is why `isRevoked` lives here rather than with
 * policy.
 *
 * IT IS ALSO WHERE A REFUSED TOKEN GETS ITS STATUS. `getClaims` reports three
 * states (`ClaimsResult` in `types.ts`), and this file turns the third one —
 * "a token was presented and did not verify" — into a status code by asking
 * one question and no other: could authenticating again help? See
 * `REFUSAL_STATUS` below. The reason itself is not decided here; it is
 * `verifyToken`'s, carried through unaltered.
 */

import type {
  FetchHandler,
  GetClaims,
  GetPeerId,
  MeshClaims,
  ProvenPeer,
  TokenRejectionReason,
  UsesTransportIdentity,
} from "@statewalker/httpeers-core";
import { ANONYMOUS, json } from "@statewalker/httpeers-core";

/**
 * WHAT SHOULD THE CLIENT DO NEXT — the only question this table answers.
 *
 * Not a taxonomy of what went wrong (that is `TokenRejectionReason` itself,
 * and it travels in the body), but the one thing a status code is actually
 * good for: whether authenticating again and retrying could possibly work.
 *
 *   401 — "authenticate and retry might work." The credential is missing or
 *         stale; a fresh one from the hub is a sensible next move.
 *   403 — "a fresh token will not help." The token is refused for something a
 *         refresh reproduces exactly: it names another mesh, another peer,
 *         another audience, or it carries a check this verifier cannot
 *         satisfy. A client that retries here loops forever.
 *
 * The audience row is the one this table was written for. Before it, ADR-0020
 * refusals answered 401, so a client scoped to peer A and calling peer B
 * refreshed, was refused identically, and refreshed again — with nothing in
 * the exchange able to say that refreshing was not the remedy.
 *
 * `malformed-token` is 401 rather than 403 deliberately: what was presented is
 * not a token at all (truncated, re-encoded, a leftover from another system),
 * so the client is in the same position as one holding no credential, and
 * obtaining a real one is exactly the remedy. `malformed-claims` is the
 * opposite case and is 403 — those bytes ARE a token this mesh signed, and it
 * says something contradictory; only the hub can fix that, not the client.
 *
 * `peer-binding` IS 401, AND THE HONEST CLIENT IS WHY. It looks like the
 * confused-deputy row — a token presented over a connection proving somebody
 * else — so it looks like the one refusal that should tell a caller to stop.
 * But an ordinary page produces this state one button-press later: every page
 * in this stack has a *reset identity* control, and a page that resets while
 * still holding a token minted for its OLD key presents exactly a token whose
 * subject does not match the key it is now proving. That is not a thief, and a
 * refresh fixes it completely — which by this table's own question makes it
 * 401.
 *
 * The asymmetry decides it rather than the taxonomy. Telling an honest client
 * to give up when a refresh would have recovered it is a real failure; a thief
 * looping on 401 costs nothing, because no amount of retrying obtains a token
 * bound to a key it does not hold. A false "stop" is worse than a harmless
 * retry. The reason still travels in the body, so the distinction stays legible
 * to anyone reading the refusal.
 *
 * `unparseable-issuer` / `issuer-not-ed25519` describe THIS peer's own
 * configured `hubPeerId`, not the presented token: they fire before any token
 * is examined, and they fire for every request. 403 is right for the reason
 * the table exists — no refresh helps — but a client cannot act on them at
 * all; they are an operator's bug reaching a caller. See the task report.
 *
 * Exhaustive by type (`Record<TokenRejectionReason, ...>`), not by a `default`
 * branch: a reason added to the union without a decision here is a compile
 * error rather than a silent fall-through to whichever status looked safe.
 */
const REFUSAL_STATUS: Record<TokenRejectionReason, 401 | 403> = {
  expired: 401,
  "malformed-token": 401,
  "peer-binding": 401,
  signature: 403,
  "mesh-mismatch": 403,
  audience: 403,
  "unsatisfied-constraint": 403,
  "evaluation-budget": 403,
  "malformed-claims": 403,
  "unparseable-issuer": 403,
  "issuer-not-ed25519": 403,
};

/**
 * Thrown, not returned as a 401/403, because a missing binding is a bug —
 * something re-created the `Request` above this middleware without calling
 * `copyPeerBinding` — not a legitimate "nobody proven" outcome. Treating it
 * as a denial would make a re-created `Request` look exactly like an
 * anonymous caller, hiding the bug behind a plausible-looking response.
 */
export class PeerBindingLostError extends Error {
  constructor(url: string) {
    super(
      `no peer context registered for ${url} -- a gateway did not register, or the request was re-created above the binding middleware`,
    );
    this.name = "PeerBindingLostError";
  }
}

export interface PeerHandlersInit {
  getPeerId: GetPeerId;
  usesTransportIdentity: UsesTransportIdentity;
  getClaims: GetClaims;
  /**
   * Is this token still good? A reason string refuses the request (and is
   * surfaced in the response, so a refusal explains itself); `null` means
   * fine. Optional — when not supplied, nothing is ever revoked.
   *
   * This asks whether the *token* is still valid, the same class of
   * question as signature and expiry, not whether this path is permitted
   * for it — which is why it is a seam on the binding rather than on
   * policy.
   */
  isRevoked?: (claims: MeshClaims) => Promise<string | null>;
  handleEndpoints: FetchHandler;
}

/**
 * Binding only: the transport-proven peer must equal the token subject,
 * except on a bootstrap request where no token exists yet. Does NOT do
 * policy — see the module comment.
 */
export function newPeerHandlers(init: PeerHandlersInit): FetchHandler {
  const { getPeerId, usesTransportIdentity, getClaims, handleEndpoints } = init;
  const isRevoked = init.isRevoked ?? (async () => null);

  return async function handle(req: Request): Promise<Response> {
    // Widened to `| undefined` on purpose: `GetPeerId` promises `ProvenPeer`
    // and never `undefined`, but that promise is a contract on the caller,
    // not something the type system can enforce for us. A real
    // implementation that breaks it is a bug, and this is the check that
    // catches it rather than silently treating the violation as ANONYMOUS.
    const peer: ProvenPeer | undefined = await getPeerId(req);
    if (peer === undefined) throw new PeerBindingLostError(req.url);

    if (await usesTransportIdentity(req)) {
      if (peer === ANONYMOUS) return json({ error: "proven peer identity required" }, 401);
      return handleEndpoints(req);
    }

    const found = await getClaims(req);
    if (found.status === "absent") return json({ error: "membership token required" }, 401);
    if (found.status === "refused") {
      // The reason goes in the BODY, never a header: `detail` is prose meant
      // for a person (the app page renders it verbatim), and a header is
      // latin1. `reason` rides alongside it as the stable discriminant, so a
      // client can branch on the refusal without matching on wording — the
      // same split `errors.ts` makes between `kind` and a message.
      //
      // `failedChecks` is deliberately NOT sent. It is the token's own Datalog
      // rule text, which the caller already holds, and it says nothing a
      // client can act on that `reason` does not.
      return json({ error: found.detail, reason: found.reason }, REFUSAL_STATUS[found.reason]);
    }
    const claims = found.claims;
    if (peer === ANONYMOUS) return json({ error: "possession unproven" }, 401);
    // 403, WHERE THE `peer-binding` REASON ABOVE IS 401, AND THE DIVERGENCE IS
    // DELIBERATE. The two look like the same condition and are not. Above, the
    // token's own `check if bound($k), connection_peer($k)` failed — which an
    // honest client reaches by resetting its identity while holding an old
    // token, and which a refresh fixes. Here, an injected `getClaims` handed
    // back claims it declared VERIFIED whose subject does not match the proven
    // peer: a supplier that is not enforcing the binding at all. That is a
    // deployment bug, not a stale credential, and no token this client can
    // fetch changes it — so "stop" is the honest answer.
    if (claims.sub !== peer)
      return json({ error: "token subject does not match connected peer" }, 403);

    const revoked = await isRevoked(claims);
    if (revoked != null) return json({ error: revoked }, 403);

    return handleEndpoints(req);
  };
}

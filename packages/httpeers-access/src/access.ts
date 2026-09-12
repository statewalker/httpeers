/**
 * One middleware: who is calling, and may they.
 *
 * WHY ONE AND NOT TWO. The prototype ships binding and policy separately and
 * requires the caller to nest them in a particular order, with the reason
 * recorded in a comment in a third file:
 *
 *   "BINDING OUTSIDE, POLICY INSIDE. `withPolicy`'s `lookupClaims` read only
 *    works because the binding middleware calls `getClaims` first — which
 *    caches via `cacheClaims` — before policy ever runs. Reverse the nesting
 *    and policy reads an empty cache: every request would look tokenless to
 *    the authorizer, no matter what it actually carried."
 *
 * A correctness requirement that lives in prose, is enforced nowhere, and is
 * violated by writing two function calls in the natural reading order. Merging
 * them does not document the hazard better — it removes the choice that
 * creates it. `withAccess` takes no ordering parameter because there is
 * nothing to order.
 *
 * The composition INSIDE is exactly the proven one. This is deliberately not a
 * rewrite: the binding and policy bodies are the code the prototype runs, and
 * the only thing that changed is who decides how they fit together.
 */

import type {
  ClaimsResult,
  FetchHandler,
  MeshClaims,
  PeerIdStr,
  ProvenPeer,
} from "@statewalker/httpeers-core";
import {
  ANONYMOUS,
  cacheClaims,
  lookupClaims,
  lookupClaimsResult,
  lookupPeer,
} from "@statewalker/httpeers-core";
import { newPeerHandlers } from "./binding.js";
import { type IssuerKeys, selfCertifyingKeys } from "./keys.js";
import type { RevocationChecker } from "./revocation.js";
import { deriveCapabilities, type RuleSet, withPolicy } from "./rules.js";
import { TokenVerificationError, verifyToken } from "./tokens.js";
import type { MeshId } from "./types.js";

export interface WithAccessInit {
  /** The mesh whose tokens are accepted — the hub's peerId. */
  issuer: MeshId;
  /** The policy. Injected, never global: there is no default rule set. */
  rules: RuleSet;
  /** Where the issuer's verifying keys come from. Defaults to the peerId itself. */
  keys?: IssuerKeys;
  /** This peer's own id, asserted as `self_peer`. Omitted, no policy can name it. */
  selfPeer?: PeerIdStr;
  /** What the TRANSPORT proved about the caller. The one identity seam. */
  provenPeer: (request: Request) => ProvenPeer | Promise<ProvenPeer>;
  /**
   * Requests that carry no token yet — a join, typically.
   *
   * They still require a PROVEN peer: a bootstrap request with no transport
   * identity is refused 401, because otherwise anyone could bootstrap.
   */
  bootstrap?: (request: Request) => boolean | Promise<boolean>;
  /**
   * A live deny list. `RevocationCache` (a pulled snapshot) and
   * `RevocationRegistry` (the hub's source of truth) both satisfy it — one
   * decision with two consumers, not two mechanisms.
   */
  revocation?: RevocationChecker;
  /** Injected clock, for expiry and `time_ms`. Defaults to `Date.now`. */
  now?: () => number;
}

/** What a handler downstream of `withAccess` can ask about its caller. */
export interface AccessContext {
  /** What the transport proved. Never what the token said. */
  peer: ProvenPeer;
  /** The verified claims, or `null` when the request carried none. */
  claims: MeshClaims | null;
  /** The capabilities the claims' roles derive through the rule set. */
  capabilities(): Set<string>;
}

/**
 * Read the access decision for a request, inside a handler `withAccess` wraps.
 *
 * Returns `undefined` if the request never passed through the middleware —
 * which is a programming error rather than a denial, and is left
 * distinguishable from "anonymous" on purpose.
 */
export function access(request: Request): AccessContext | undefined {
  const peer = lookupPeer(request);
  if (peer === undefined) return undefined;
  const claims = (lookupClaims(request) ?? null) as MeshClaims | null;
  const rules = RULES_BY_REQUEST.get(request);
  return {
    peer,
    claims,
    capabilities: () =>
      claims == null || rules == null ? new Set<string>() : deriveCapabilities(rules, claims.roles),
  };
}

/**
 * The rule set in force for a request, so `access()` can derive capabilities
 * without the caller passing the rules back in. Keyed by `Request` identity
 * the same way the peer binding is, and for the same reason.
 */
const RULES_BY_REQUEST = new WeakMap<Request, RuleSet>();

export function withAccess(init: WithAccessInit): (next: FetchHandler) => FetchHandler {
  const keys = init.keys ?? selfCertifyingKeys();
  const now = init.now ?? Date.now;
  const bootstrap = init.bootstrap ?? (() => false);

  return (next: FetchHandler): FetchHandler => {
    // THE ORDER, fixed here once. Policy is the inner handler so that the
    // binding step's `getClaims` has already cached the verified claims by the
    // time the authorizer reads them.
    const guarded = newPeerHandlers({
      getPeerId: async (req) => init.provenPeer(req),
      usesTransportIdentity: async (req) => bootstrap(req),
      // The prototype's own `getClaims`, kept shape for shape — including the
      // cache read, the ADR-0020 `selfPeer` check, and the fallback that maps
      // anything which is NOT a `TokenVerificationError` to `malformed-token`
      // rather than inventing a state the taxonomy does not have.
      getClaims: async (req) => {
        const cached = lookupClaimsResult(req);
        if (cached !== undefined) return cached;

        const header = req.headers.get("authorization");
        const token = header?.startsWith("Bearer ") === true ? header.slice(7) : null;

        let result: ClaimsResult;
        if (token == null) {
          result = { status: "absent" };
        } else {
          try {
            const claims = await verifyToken(token, {
              issuer: init.issuer,
              keys,
              connectionPeer: lookupPeer(req) ?? ANONYMOUS,
              selfPeer: init.selfPeer,
              now,
            });
            result = { status: "verified", claims };
          } catch (error) {
            result =
              error instanceof TokenVerificationError
                ? {
                    status: "refused",
                    reason: error.reason,
                    detail: error.detail,
                    failedChecks: error.failedChecks,
                  }
                : {
                    status: "refused",
                    reason: "malformed-token",
                    detail: "malformed token",
                    failedChecks: [],
                  };
          }
        }
        cacheClaims(req, result);
        return result;
      },
      isRevoked: init.revocation
        ? async (claims) => (await init.revocation?.check(claims)) ?? null
        : undefined,
      handleEndpoints: withPolicy({
        rules: init.rules,
        usesTransportIdentity: async (req) => bootstrap(req),
        selfPeer: init.selfPeer,
        now,
      })(next),
    });

    return async (request: Request): Promise<Response> => {
      RULES_BY_REQUEST.set(request, init.rules);
      return guarded(request);
    };
  };
}

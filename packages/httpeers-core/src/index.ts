/**
 * The public surface, listed one name at a time.
 *
 * NOT `export *`, and that is the point. The barrel in the package this was
 * extracted from ends with `export * from "./transport-duplex.js"` and
 * `export * from "./peer.js"` — which is how importing a package that
 * documents itself as isomorphic pulls libp2p, TCP, Noise and yamux into every
 * consumer's bundle. Nobody decided that; a wildcard did.
 *
 * An explicit list makes a widening of the public API a visible line in a
 * diff, which is the only place it can be argued about.
 */

export { createMonotonicClock } from "./clock.js";
// Failure, as a taxonomy a caller can switch on.
export {
  PeerCallError,
  type PeerErrorKind,
  PeerProtocolUnsupportedError,
  PeerRelayLimitExceededError,
  PeerRequestTimeoutError,
  PeerStreamResetError,
  PeerUnreachableError,
  UnknownPeerCallError,
} from "./errors.js";
// The transport-proven caller, carried beside a Request rather than inside it.
export {
  cacheClaims,
  copyPeerBinding,
  lookupClaims,
  lookupClaimsResult,
  lookupPeer,
  registerAnonymous,
  registerPeer,
} from "./peer-context.js";
export {
  newPeerHandlers,
  PeerBindingLostError,
  type PeerHandlersInit,
} from "./peer-handlers.js";
export {
  type ChangeEntry,
  RevocationCache,
  type RevocationCacheInit,
  type RevocationChecker,
  RevocationRegistry,
  type RevocationRegistryInit,
  type StalenessMode,
} from "./revocation.js";

export { createMounts, createPeerRouter, type PeerRouterInit } from "./router.js";
/**
 * The rule-set vocabulary — the value and its pure readers.
 *
 * `ruleSet()` itself is NOT here: building a rule set canonicalises every rule
 * through the Biscuit parser, so it lives in `@statewalker/httpeers-access`
 * with the authorizer. See `rule-set.ts` for why the line falls there.
 */
export {
  assertBuilt,
  assertValid,
  capabilityNames,
  literalsOf,
  RULE_SET_BRAND,
  type RuleSet,
  type RuleSetDefs,
  RuleSetError,
  roleNames,
  validateRoles,
} from "./rule-set.js";

export { createAdvertisementStore, createMemberStore, createPresenceStore } from "./store.js";
// The contract everything else is written against.
export type {
  Advertisement,
  AdvertisementStore,
  Anonymous,
  ClaimsResult,
  FetchHandler,
  GetClaims,
  GetPeerId,
  MemberRecord,
  MemberStore,
  MeshClaims,
  Mounts,
  PeerIdStr,
  PresenceRecord,
  PresenceStore,
  PresenceWriteRejection,
  PresenceWriteResult,
  ProvenPeer,
  Remote,
  TokenRejectionReason,
  UsesTransportIdentity,
} from "./types.js";
export { ANONYMOUS, json } from "./types.js";

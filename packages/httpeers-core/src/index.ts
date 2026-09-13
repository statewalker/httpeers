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

export { createMounts, createPeerRouter, type PeerRouterInit } from "./router.js";

// The contract everything else is written against. The store INTERFACES live
// here though the registries themselves belong to `httpeers-hub`: the type is
// produced by one package and consumed by another that must not depend on it.
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

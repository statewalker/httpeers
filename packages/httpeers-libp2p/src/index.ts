/**
 * The transport — the one package in the extraction that knows what libp2p is.
 *
 * An explicit list, never `export *`: the barrel this code came from ended
 * with `export * from "./transport-duplex.js"`, which is how a package that
 * documented itself as isomorphic pulled libp2p, TCP, Noise and yamux into
 * every consumer's bundle.
 */

/**
 * The SECOND ALTITUDE: duplex streams over the mesh.
 *
 * A fetch-only contract cannot express a WebSocket — both sides talking with
 * neither input closed. These run one `Duplex` per libp2p stream, addressed by
 * `(peerId, path)`, with identity captured per stream by closure exactly as
 * the fetch path does it.
 */
export {
  createDuplexMounts,
  DUPLEX_PROTOCOL,
  type DuplexContext,
  type DuplexHandler,
  type DuplexMounts,
  NO_MOUNT,
  type OpenDuplexInit,
  openDuplex,
  type PeerDuplex,
  type ServeDuplexInit,
  serveDuplex,
} from "./duplex.js";
export {
  hubRoute,
  leaveRelay,
  reachHub,
  reachHubRelayed,
  reserveOnHub,
  type SuperviseHubReservationInit,
  superviseHubReservation,
} from "./hub-link.js";
export { hubRelayService, type IsMember, membershipGater } from "./hub-relay.js";
export {
  type BytesStore,
  decodeKey,
  encodeKey,
  type GenerateKeyInit,
  generateKey,
  type IdentityStore,
  type IdentityStoreInit,
  identityStore,
  peerIdOf,
  type SignerLike,
  signerOf,
} from "./identity.js";
export type { CallOnLimitedConnection } from "./link.js";
export { lastPeerIdOf } from "./multiaddr-parts.js";
export {
  type CircuitAddrs,
  circuitAddrs,
  dialRelay,
  RESERVATION_POLL_ATTEMPTS,
  RESERVATION_POLL_INTERVAL_MS,
  type RelaySupervisor,
  retryDelayMs,
  type SuperviseRelayInit,
  superviseRelay,
  type WaitForCircuitReservationInit,
  waitForCircuitReservation,
} from "./reservation.js";
export { type Peer, type ServePeerInit, servePeer } from "./serve-peer.js";
export {
  type CreateNodeInit,
  type CreateRemoteInit,
  createNode,
  createRemote,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_STREAMS,
  PROTOCOL,
  type ServeTransportInit,
  serveTransport,
  type TransportFactory,
} from "./transport.js";

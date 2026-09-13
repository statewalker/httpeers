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
  openDuplex,
  type OpenDuplexInit,
  type PeerDuplex,
  serveDuplex,
  type ServeDuplexInit,
} from "./duplex.js";
export { hubRelayService, type IsMember, membershipGater } from "./hub-relay.js";
export {
  hubRoute,
  leaveRelay,
  reachHub,
  reserveOnHub,
  type SuperviseHubReservationInit,
  superviseHubReservation,
} from "./hub-link.js";
export { lastPeerIdOf } from "./multiaddr-parts.js";
export {
  type CircuitAddrs,
  circuitAddrs,
  dialRelay,
  type RelaySupervisor,
  RESERVATION_POLL_ATTEMPTS,
  RESERVATION_POLL_INTERVAL_MS,
  retryDelayMs,
  type SuperviseRelayInit,
  superviseRelay,
  type WaitForCircuitReservationInit,
  waitForCircuitReservation,
} from "./reservation.js";
export { type Peer, servePeer, type ServePeerInit } from "./serve-peer.js";
export {
  createNode,
  type CreateNodeInit,
  createRemote,
  type CreateRemoteInit,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_STREAMS,
  PROTOCOL,
  serveTransport,
  type ServeTransportInit,
  type TransportFactory,
} from "./transport.js";
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

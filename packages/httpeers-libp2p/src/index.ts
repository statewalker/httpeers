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
/**
 * Finding dead connections without killing busy ones (#56): the connection
 * monitor `createNode` installs in place of libp2p's. A node built by hand
 * passes `connectionMonitor: { enabled: false }` and this service.
 */
export {
  type AbortOnPingFailure,
  type ByteSource,
  CONNECTION_LIVENESS_SERVICE,
  type ConnectionLiveness,
  type ConnectionLivenessComponents,
  type ConnectionLivenessOptions,
  connectionLiveness,
  DEFAULT_LIVENESS_PING_INTERVAL_MS,
  DEFAULT_SILENT_FAILURES_WHEN_BUSY,
  LIVENESS_PING_PROTOCOL,
  NODE_BUSY_BYTES,
  STATS_SAMPLE_TIMEOUT_MS,
  statsBytesReceived,
} from "./connection-liveness.js";
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
  decodeHopAnswer,
  HOP_RESERVE_TIMEOUT_MS,
  HOP_STATUS_NAMES,
  HOP_STATUS_OK,
  type HopAnswer,
  RelayNotConnectedError,
  type RelayReservationGrant,
  RelayReservationRefusedError,
  requestRelayReservation,
} from "./hop-reserve.js";
export {
  HubReservationError,
  type HubReservationRefusal,
  hubRoute,
  leaveRelay,
  reachHub,
  reachHubRelayed,
  reserveOnHub,
  type SuperviseHubReservationInit,
  superviseHubReservation,
} from "./hub-link.js";
export {
  HUB_MAX_RESERVATIONS,
  type HubRelayComponents,
  type HubRelayServiceInit,
  hubRelayService,
  type IsMember,
  membershipGater,
  releaseReservation,
} from "./hub-relay.js";
export {
  HTTPEERS_ICE_SERVERS,
  HTTPEERS_STUN_URL,
  type IceServer,
  PUBLIC_STUN_FALLBACK_URL,
  parseIceServers,
  webRTCInitOf,
} from "./ice-servers.js";
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
/**
 * EXPERIMENTAL (#56): one windowed mux per peer instead of one libp2p stream
 * per exchange, behind `muxPerPeer` on `servePeer` / `createRemote` /
 * `serveTransport`. Off by default; see the README.
 */
export {
  DEFAULT_MUX_FRAME_SIZE,
  DEFAULT_MUX_KEEPALIVE_MS,
  DEFAULT_MUX_WINDOW,
  MUX_MAX_STREAMS_PER_CONNECTION,
  MUX_MESSAGE_HEADROOM,
  MUX_PROTOCOL,
  type MuxPerPeer,
  type MuxPerPeerOptions,
  MuxPortClosedError,
  muxProtocolOf,
} from "./mux-link.js";
export {
  type CircuitAddrs,
  circuitAddrs,
  DEFAULT_RENEWAL_INTERVAL_MS,
  dialRelay,
  MAX_RENEWAL_INTERVAL_MS,
  MIN_RENEWAL_INTERVAL_MS,
  RESERVATION_LOSS_GRACE_MS,
  RESERVATION_POLL_ATTEMPTS,
  RESERVATION_POLL_INTERVAL_MS,
  type RelayLog,
  type RelayReservationEvent,
  type RelayReservationState,
  type RelayReservationStatus,
  type RelaySupervisor,
  renewalDelayMs,
  renewalIntervalMs,
  reservationHealthy,
  retryDelayMs,
  type SuperviseRelayInit,
  superviseRelay,
  type WaitForCircuitReservationInit,
  waitForCircuitReservation,
} from "./reservation.js";
export { type Peer, type ServePeerInit, servePeer } from "./serve-peer.js";
export { globalTimers, type TimerHandle, type Timers } from "./timers.js";
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

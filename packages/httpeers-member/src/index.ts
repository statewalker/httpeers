/**
 * Everything a participant does: hold an identity, redeem or resume, connect,
 * keep the link, advertise, discover, call, and serve.
 *
 * `startMember` is the seam rung 01 proved: one lifecycle, with the three
 * things that genuinely differ between a Node process and a page injected as a
 * `MemberPlatform`. `MemberHandle.fetch` IS the edge on both platforms;
 * `baseUrl` is the browser-only part.
 */

export { type ConnectionKind, classifyConnection, describeConnection } from "./connection-kind.js";
export { describeError } from "./describe-error.js";

export {
  createEdgeDispatch,
  type EdgeDispatchInit,
  PEER_ERROR_STATUS,
  type PeerErrorBody,
  stripEdgePrefix,
  targetPeerId,
} from "./edge-dispatch.js";
/**
 * The mesh as ordinary HTTP.
 *
 * `createGateway` turns a member into a `FetchHandler` dispatching
 * `/{peerId}/{path}` — so a client with no peer object, no token and no
 * knowledge of libp2p can `fetch()` a mesh resource. `GatewaySource` is
 * structurally a subset of `MemberHandle`, so a member IS one.
 */
export { createGateway, GATEWAY_MARKER, type GatewayInit, type GatewaySource } from "./gateway.js";
export {
  clearIdentity,
  decodeIdentity,
  encodeIdentity,
  IDENTITY_STORAGE_KEY,
  type IdentityStoreInit,
  loadOrCreateIdentity,
  peerIdOf,
  readIdentity,
} from "./identity.js";
export {
  decodeJoinBlob,
  encodeJoinBlob,
  invitationFromQrText,
  JOIN_BLOB_PARAM,
  type JoinBlob,
  type JoinInput,
  joinUrl,
  readJoinInputFromSearch,
  readJoinInputFromText,
} from "./join-blob.js";
export type { AsyncBytesBackend, AsyncKeyValueBackend } from "./kv.js";
export { parseMeshConfig } from "./mesh-config.js";
export {
  type CreateMeshMemoryInit,
  createMeshMemory,
  MESH_STORAGE_KEY,
  type MeshMemory,
} from "./mesh-memory.js";
export { type PeerRequestInit, peerRequest } from "./peer-request.js";
/**
 * The session machine — ISOMORPHIC, and exported from the root on purpose.
 *
 * It used to be the browser peer's private business. Everything platform-bound
 * in it is now injected (the platform, the two stores, the reload), so a Node
 * member that wants resume-or-redeem and the same four operator controls gets
 * them here rather than reimplementing them. `./browser`'s `createSession` is
 * the same thing with a page's defaults filled in.
 */
export {
  createIdentityStore,
  createPeerSession,
  DEFAULT_HTTPEERS_CONFIG_URL,
  describeMeshDrift,
  type IdentityStore,
  type NeedsInvitationReason,
  type PeerSession,
  type PeerSessionInit,
  type SessionControls,
  type SessionPhase,
  type SessionStartState,
  type SessionState,
  type StartPeer,
} from "./session.js";
export {
  type JoinMethod,
  type MemberEdge,
  type MemberHandle,
  MemberJoinError,
  type MemberPlatform,
  type MemberState,
  type StartMemberInit,
  startMember,
} from "./start-member.js";

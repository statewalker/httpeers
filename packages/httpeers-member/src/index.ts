/**
 * Everything a participant does: hold an identity, redeem or resume, connect,
 * keep the link, advertise, discover, call, and serve.
 *
 * `startMember` is the seam rung 01 proved: one lifecycle, with the three
 * things that genuinely differ between a Node process and a page injected as a
 * `MemberPlatform`. `MemberHandle.fetch` IS the edge on both platforms;
 * `baseUrl` is the browser-only part.
 */

export { classifyConnection, type ConnectionKind, describeConnection } from "./connection-kind.js";
export { describeError } from "./describe-error.js";

export {
  createEdgeDispatch,
  type EdgeDispatchInit,
  PEER_ERROR_STATUS,
  type PeerErrorBody,
  stripEdgePrefix,
  targetPeerId,
} from "./edge-dispatch.js";
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
  JOIN_BLOB_PARAM,
  type JoinBlob,
  type JoinInput,
  joinUrl,
  readJoinInputFromSearch,
  readJoinInputFromText,
} from "./join-blob.js";
export type { AsyncBytesBackend, AsyncKeyValueBackend } from "./kv.js";
export { createMeshMemory, type CreateMeshMemoryInit, MESH_STORAGE_KEY, type MeshMemory } from "./mesh-memory.js";
export { peerRequest, type PeerRequestInit } from "./peer-request.js";
export {
  type JoinMethod,
  type MemberEdge,
  type MemberHandle,
  MemberJoinError,
  type MemberPlatform,
  type MemberState,
  startMember,
  type StartMemberInit,
} from "./start-member.js";

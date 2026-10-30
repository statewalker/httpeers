/**
 * The Bridge (Node and Bun only): a locked-down loopback relay from the
 * PeerShare page to the Sharer's local Services, with per-Guest cookie jars.
 */

export { type BridgeHandler, type BridgeInit, createBridge } from "./bridge.js";
export { type Listening, listenLoopback } from "./serve.js";
export {
  acceptedProtocol,
  connectApp,
  type InboundSocket,
  relaySocket,
  SOCKET_PATH,
  type SocketGate,
  type SocketPlan,
  TOKEN_PROTOCOL_PREFIX,
} from "./sockets.js";

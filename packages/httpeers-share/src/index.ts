/**
 * Sharing an HTTP service with the members of an httpeers mesh: how the
 * Sharer reaches it (upstream kinds), what may be shared (policy), whether it
 * works for Guests (probe), how Guests see it (service table), how they are
 * invited (invite link), and what a failed join means (join outcome).
 *
 * Isomorphic and UI-free: no DOM, no `node:` module.
 */

export { decodeInvite, encodeInvite, type InviteLink } from "./invite-link.js";
export { type JoinOutcome, joinOutcome } from "./join-outcome.js";
export { isSharerOffline, revokeGuest } from "./lifecycle.js";
export {
  checkServiceTarget,
  type ServiceKind,
  type TargetCheck,
  type TargetRefusal,
} from "./policy.js";
export {
  type Health,
  type ProbeCause,
  type ProbeReport,
  type ProbeWarning,
  probe,
  SLOW_MS,
} from "./probe.js";
export {
  type CatalogEntry,
  SERVICE_MARKER,
  type ServiceEntry,
  serviceTable,
} from "./service-table.js";
export { decodeFrames, encodeFrame, SOCKET_HEADER, type SocketFrame } from "./socket-frames.js";
export { openTunnel, sharerSocket, TunnelSocket } from "./socket-tunnel.js";
export { stampGuest } from "./stamp-guest.js";
export { checkTarget, isPrivateAddress, type TargetVerdict } from "./targets.js";
export {
  BRIDGE_COOKIES_KEPT_HEADER,
  BRIDGE_GUEST_HEADER,
  BRIDGE_MARKER,
  BRIDGE_REDIRECT_LOCATION_HEADER,
  BRIDGE_REDIRECT_STATUS_HEADER,
  BRIDGE_SET_COOKIE_HEADER,
  BRIDGE_TARGET_HEADER,
  BRIDGE_TOKEN_HEADER,
  createUpstream,
  PROBE_GUEST,
  type UpstreamConfig,
  unreachable,
} from "./upstreams.js";

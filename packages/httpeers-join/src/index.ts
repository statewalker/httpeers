/**
 * The join-the-mesh widget: paste or scan an invitation, see the link to the
 * hub, disconnect, reconnect or leave -- and, for a mesh admin, invite
 * others as members or admins.
 *
 * Plain DOM and no framework. A page mounts it, feeds it every `SessionState`
 * its `PeerSession` reports, and destroys it when done:
 *
 *     const widget = mountJoinWidget(el, { session, state: session.state() });
 *     // in the session's onChange:
 *     widget.update(state);
 *
 * See the README for the design and for how React pages wrap it.
 */

export {
  ADMIN_INVITATION_WARNING,
  adminHint,
  type CreatedInvitation,
  createHubAdminClient,
  DEFAULT_INVITE_EXPIRY,
  DEFAULT_INVITE_ROLE,
  describeExpiry,
  expiryMs,
  type HubAdminClient,
  HubAdminError,
  type HubTarget,
  hubAdminBase,
  INVITE_EXPIRIES,
  INVITE_ROLES,
  type InviteExpiryId,
  type InviteRole,
  invitationRequestBody,
  isFinalRefusal,
  type MeshViewHint,
  offeredRoles,
  type PendingInvitation,
} from "./invite.js";
export { createInvitePanel, type InvitePanel, type InvitePanelOptions } from "./invite-panel.js";
export {
  defaultQrScanner,
  type QrCameraScan,
  type QrFileScan,
  type QrScanner,
} from "./qr.js";
export { injectJoinWidgetStyles, JOIN_WIDGET_CSS, JOIN_WIDGET_STYLE_ID } from "./styles.js";
export {
  describePhase,
  type JoinWidget,
  type JoinWidgetOptions,
  type JoinWidgetSession,
  type JoinWidgetState,
  LEAVE_CONFIRMATION,
  mountJoinWidget,
  shortPeerId,
} from "./widget.js";

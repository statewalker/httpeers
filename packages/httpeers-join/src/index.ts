/**
 * The join-the-mesh widget: paste or scan an invitation, see the link to the
 * hub, disconnect, reconnect or leave.
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

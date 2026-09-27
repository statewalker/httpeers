/**
 * Settings-dialog "Sharing" tab: the joined session's link status and menu -- Disconnect,
 * Reconnect, Leave and, for a mesh admin, Invite (member or admin invitations with link, QR code,
 * Share and Copy). This is `mesh.tsx`'s former `linkStatus` header element (the compact
 * `JoinWidgetView`), moved here unchanged (Task 11) rather than redesigned.
 *
 * Lives under `mesh/`, not `ui/`: it imports httpeers (through `../join-widget.js`), which is why
 * the boundary test keeps it out of the standalone page's closure.
 */

import { JoinWidgetView } from "../join-widget.js";
import type { MeshSessionHandle } from "./mesh-session.js";

export function SharingPanel({ meshSession }: { meshSession: MeshSessionHandle }) {
  const { session, state } = meshSession.current;
  if (session == null) {
    return <p className="text-sm text-muted-foreground">Not connected to a mesh.</p>;
  }
  return <JoinWidgetView session={session} state={state} compact />;
}

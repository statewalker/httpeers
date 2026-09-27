/**
 * The mesh page's settings-dialog contributions: Sharing and Keys (Task 11). `mesh.tsx` is the
 * only caller -- everything reachable from here imports httpeers, directly or through
 * `../join-widget.js`/`../member-key.js`, which is why it lives under `mesh/`, kept out of the
 * standalone page's closure (`tests/boundary.test.ts`'s reachability walk from
 * `pages/standalone.tsx`).
 *
 * `Slots#register` takes three arguments -- `register(decl, id, value)` -- and there is no
 * `unregister`; a `register` call's own return value is the disposer. Verified against
 * `@statewalker/shared-slots`'s source, not assumed from the plan.
 */

import type { Slots } from "@statewalker/shared-slots";
import { settingsPanelsSlot } from "../../slots/panels.js";
import { KeysPanel } from "./KeysPanel.js";
import type { MeshSessionHandle } from "./mesh-session.js";
import { SharingPanel } from "./SharingPanel.js";

/** Registered-panel ids -- the same constant pattern `ChatApp.tsx` uses for Connection/Models. */
export const SHARING_PANEL_ID = "mesh-sharing";
export const KEYS_PANEL_ID = "mesh-keys";

/**
 * `order` only has to stay above whatever `ChatApp.tsx`'s Connection/Models use (1 and 2); 100
 * and 101 leave generous headroom rather than assuming those exact values.
 */
const SHARING_PANEL_ORDER = 100;
const KEYS_PANEL_ORDER = 101;

/**
 * Contributes the Sharing and Keys tabs to `slots`, ordered after the chat's own panels.
 * `mesh.tsx` calls this once on mount and disposes on unmount; the returned function removes
 * both registrations.
 */
export function registerMeshPanels(slots: Slots, meshSession: MeshSessionHandle): () => void {
  const disposeSharing = slots.register(settingsPanelsSlot, SHARING_PANEL_ID, {
    id: SHARING_PANEL_ID,
    title: "Sharing",
    order: SHARING_PANEL_ORDER,
    Component: () => <SharingPanel meshSession={meshSession} />,
  });
  const disposeKeys = slots.register(settingsPanelsSlot, KEYS_PANEL_ID, {
    id: KEYS_PANEL_ID,
    title: "Keys",
    order: KEYS_PANEL_ORDER,
    Component: () => <KeysPanel meshSession={meshSession} />,
  });
  return () => {
    disposeSharing();
    disposeKeys();
  };
}

export { createMeshSessionHandle, type MeshSessionHandle } from "./mesh-session.js";

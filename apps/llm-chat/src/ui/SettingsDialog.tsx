/**
 * One settings dialog, filled by slots: one tab per panel registered into `settingsPanelsSlot`.
 *
 * This component knows nothing about connections, models, or the mesh -- it imports no panel and
 * nothing from `src/mesh/`. That is what lets `index.html` show two tabs (Connection, Models,
 * registered by `ChatApp`) and `mesh.html` show more once it contributes its own (Task 11), with
 * no branch anywhere deciding which.
 */

import { useState } from "react";
import { useSlot } from "../slots/context.js";
import { orderPanels, settingsPanelsSlot } from "../slots/panels.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./primitives/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives/tabs.js";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /**
   * Which panel to open on, by id -- e.g. so `ChatApp` can send a user who already has a
   * connection but no model straight to the Models tab, instead of back to the Connection form
   * they just filled in. An id, never a concept like "models": the dialog still imports no panel
   * and knows nothing about what any of them are for.
   *
   * Falls back to the first panel (by `orderPanels`) when absent, or when the named panel isn't
   * registered. Resolved fresh on every render rather than captured once, because a panel can
   * register after this dialog has already mounted.
   */
  initialPanelId?: string;
}

export function SettingsDialog({ open, onOpenChange, initialPanelId }: SettingsDialogProps) {
  const panels = orderPanels(useSlot(settingsPanelsSlot));
  const first = panels[0];
  const resolvedInitialId =
    initialPanelId != null && panels.some((panel) => panel.id === initialPanelId)
      ? initialPanelId
      : first?.id;
  // `undefined` until the user picks a tab themselves; once they have, their choice sticks even
  // as `resolvedInitialId` keeps recomputing (e.g. a late-registering panel resolving in).
  const [pickedId, setPickedId] = useState<string | undefined>(undefined);
  const activeId = pickedId ?? resolvedInitialId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        {first != null && (
          <Tabs value={activeId} onValueChange={setPickedId} className="flex flex-col gap-3">
            <TabsList>
              {panels.map((panel) => (
                <TabsTrigger key={panel.id} value={panel.id}>
                  {panel.title}
                </TabsTrigger>
              ))}
            </TabsList>
            {panels.map((panel) => (
              <TabsContent key={panel.id} value={panel.id}>
                <panel.Component />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One settings dialog, filled by slots: one tab per panel registered into `settingsPanelsSlot`.
 *
 * This component knows nothing about connections, models, or the mesh -- it imports no panel and
 * nothing from `src/mesh/`. That is what lets `index.html` show two tabs (Connection, Models,
 * registered by `ChatApp`) and `mesh.html` show more once it contributes its own (Task 11), with
 * no branch anywhere deciding which.
 */

import { useSlot } from "../slots/context.js";
import { orderPanels, settingsPanelsSlot } from "../slots/panels.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./primitives/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives/tabs.js";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const panels = orderPanels(useSlot(settingsPanelsSlot));
  const first = panels[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        {first != null && (
          <Tabs defaultValue={first.id} className="flex flex-col gap-3">
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

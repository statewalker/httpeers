import { defineKeyedSlot, type KeyedSlotDeclaration } from "@statewalker/shared-slots";
import type { ComponentType } from "react";

/**
 * A contribution to the settings dialog: one tab. `id` is also the
 * registration id passed to `slots.register(settingsPanelsSlot, id, panel)` —
 * Task 5 renders one tab per panel and imports none of them.
 */
export interface SettingsPanel {
  id: string;
  title: string;
  order: number;
  Component: ComponentType;
}

export const settingsPanelsSlot: KeyedSlotDeclaration<SettingsPanel> =
  defineKeyedSlot<SettingsPanel>("llm-chat:settings-panels");

/**
 * Order panels for display: by `order`, then by `title`. `Array#sort` is
 * spec-guaranteed stable (ES2019+), so panels tied on both keys keep their
 * relative input order.
 */
export function orderPanels(panels: SettingsPanel[]): SettingsPanel[] {
  return [...panels].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

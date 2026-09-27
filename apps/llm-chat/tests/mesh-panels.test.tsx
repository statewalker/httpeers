/**
 * `registerMeshPanels`: the mesh page's contribution to the settings dialog, Sharing and Keys,
 * ordered after the chat's own Connection and Models (Task 11).
 *
 * The real `Slots#register`/`getSnapshot` signatures (verified in `@statewalker/shared-slots`'s
 * source, not the plan's snippets): `register(decl, id, value)` takes three arguments, and
 * `getSnapshot(keyedDecl)` returns a `ReadonlyMap<string, T>`, not an array -- `orderPanels` takes
 * `T[]`, so a Map is spread through `.values()` first.
 */
import { Slots } from "@statewalker/shared-slots";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { registerMeshPanels } from "../src/mesh/panels/index.js";
import { SlotsProvider } from "../src/slots/context.js";
import { orderPanels, settingsPanelsSlot } from "../src/slots/panels.js";
import { SettingsDialog } from "../src/ui/SettingsDialog.js";

describe("registerMeshPanels", () => {
  it("contributes exactly Sharing and Keys", () => {
    const slots = new Slots();
    registerMeshPanels(slots, {} as never);
    expect(
      orderPanels([...slots.getSnapshot(settingsPanelsSlot).values()]).map((p) => p.title),
    ).toEqual(["Sharing", "Keys"]);
  });

  it("removes them again when disposed", () => {
    const slots = new Slots();
    registerMeshPanels(slots, {} as never)();
    expect(slots.getSnapshot(settingsPanelsSlot).size).toBe(0);
  });

  it("orders them AFTER the chat's own panels", () => {
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "connection", {
      id: "connection",
      title: "Connection",
      order: 10,
      Component: () => null,
    });
    slots.register(settingsPanelsSlot, "models", {
      id: "models",
      title: "Models",
      order: 20,
      Component: () => null,
    });
    registerMeshPanels(slots, {} as never);
    expect(
      orderPanels([...slots.getSnapshot(settingsPanelsSlot).values()]).map((p) => p.title),
    ).toEqual(["Connection", "Models", "Sharing", "Keys"]);
  });

  it("gives the dialog four tabs once both sources have registered", () => {
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "connection", {
      id: "connection",
      title: "Connection",
      order: 10,
      Component: () => null,
    });
    slots.register(settingsPanelsSlot, "models", {
      id: "models",
      title: "Models",
      order: 20,
      Component: () => null,
    });
    registerMeshPanels(slots, {} as never);
    render(
      <SlotsProvider slots={slots}>
        <SettingsDialog open onOpenChange={() => {}} />
      </SlotsProvider>,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });
});

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Slots } from "@statewalker/shared-slots";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { SlotsProvider } from "../src/slots/context.js";
import { settingsPanelsSlot } from "../src/slots/panels.js";
import { SettingsDialog } from "../src/ui/SettingsDialog.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

const panel = (id: string, order: number, title = id) => ({
  id,
  title,
  order,
  Component: () => <div data-testid={`body-${id}`}>{id} body</div>,
});

const open = (slots: Slots) =>
  render(
    <SlotsProvider slots={slots}>
      <SettingsDialog open onOpenChange={() => {}} />
    </SlotsProvider>,
  );

describe("SettingsDialog", () => {
  it("renders one tab per registered panel, in order", () => {
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "b", panel("b", 2, "Second"));
    slots.register(settingsPanelsSlot, "a", panel("a", 1, "First"));
    open(slots);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["First", "Second"]);
  });

  it("renders NO tabs when nothing is registered", () => {
    open(new Slots());
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("shows the first panel's body by default", () => {
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "a", panel("a", 1, "First"));
    slots.register(settingsPanelsSlot, "b", panel("b", 2, "Second"));
    open(slots);
    expect(screen.getByTestId("body-a")).toBeTruthy();
  });

  it("switches body when another tab is selected", async () => {
    const user = userEvent.setup();
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "a", panel("a", 1, "First"));
    slots.register(settingsPanelsSlot, "b", panel("b", 2, "Second"));
    open(slots);
    await user.click(screen.getByRole("tab", { name: "Second" }));
    expect(screen.getByTestId("body-b")).toBeTruthy();
  });

  it("gains a tab when a panel registers while it is open", () => {
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "a", panel("a", 1, "First"));
    open(slots);
    act(() => {
      slots.register(settingsPanelsSlot, "m", panel("m", 5, "Mesh"));
    });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["First", "Mesh"]);
  });

  it("has an accessible name", () => {
    open(new Slots());
    expect(screen.getByRole("dialog", { name: /settings/i })).toBeTruthy();
  });

  it("renders nothing at all when closed", () => {
    render(
      <SlotsProvider slots={new Slots()}>
        <SettingsDialog open={false} onOpenChange={() => {}} />
      </SlotsProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("imports nothing from src/mesh -- panels arrive through the slot, never by import", async () => {
    const source = await readFile(join(TESTS_DIR, "../src/ui/SettingsDialog.tsx"), "utf8");
    expect(source).not.toMatch(/from\s+"[^"]*\/mesh\//);
  });
});

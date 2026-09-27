import { Slots } from "@statewalker/shared-slots";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { SlotsProvider, useSlot } from "../src/slots/context.js";
import { orderPanels, settingsPanelsSlot } from "../src/slots/panels.js";

const panel = (id: string, order: number, title = id) => ({
  id,
  title,
  order,
  Component: () => <div>{id}</div>,
});

function Names() {
  return (
    <ul>
      {useSlot(settingsPanelsSlot).map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  );
}

describe("useSlot", () => {
  it("renders nothing for an empty bus", () => {
    render(
      <SlotsProvider slots={new Slots()}>
        <Names />
      </SlotsProvider>,
    );
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("renders one entry per contribution", () => {
    const slots = new Slots();
    slots.register(settingsPanelsSlot, "a", panel("a", 1));
    slots.register(settingsPanelsSlot, "b", panel("b", 2));
    render(
      <SlotsProvider slots={slots}>
        <Names />
      </SlotsProvider>,
    );
    expect(screen.getAllByRole("listitem").map((n) => n.textContent)).toEqual(["a", "b"]);
  });

  it("PICKS UP a contribution registered after mount, without a remount", () => {
    const slots = new Slots();
    render(
      <SlotsProvider slots={slots}>
        <Names />
      </SlotsProvider>,
    );
    act(() => {
      slots.register(settingsPanelsSlot, "late", panel("late", 1));
    });
    expect(screen.getAllByRole("listitem").map((n) => n.textContent)).toEqual(["late"]);
  });

  it("drops a contribution when its disposer runs", () => {
    const slots = new Slots();
    let dispose = () => {};
    render(
      <SlotsProvider slots={slots}>
        <Names />
      </SlotsProvider>,
    );
    act(() => {
      dispose = slots.register(settingsPanelsSlot, "temp", panel("temp", 1));
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    act(() => {
      dispose();
    });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("throws a named error when used outside a provider", () => {
    expect(() => render(<Names />)).toThrow(/SlotsProvider/);
  });
});

describe("orderPanels", () => {
  it("orders by order, then by title", () => {
    const panels = [panel("z", 2), panel("b", 1, "B"), panel("a", 1, "A")];
    expect(orderPanels(panels).map((p) => p.title)).toEqual(["A", "B", "z"]);
  });

  it("is stable for equal order and title", () => {
    const same = [panel("x", 1, "T"), panel("y", 1, "T")];
    expect(orderPanels(same).map((p) => p.id)).toEqual(["x", "y"]);
  });
});

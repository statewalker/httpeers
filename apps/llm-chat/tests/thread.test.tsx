import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Thread } from "../src/ui/Thread.js";

const state = (over: Record<string, unknown>) =>
  ({
    session: { id: "s", title: "t", messages: [{ role: "user", content: "hi" }] },
    phase: "idle",
    isRunning: false,
    runStartedAt: null,
    error: null,
    ...over,
  }) as never;

const noop = () => {};

describe("Thread", () => {
  it("shows neither indicator nor Stop when idle", () => {
    render(<Thread state={state({})} now={0} onCancel={noop} onSend={noop} />);
    expect(screen.queryByTestId("waiting-indicator")).toBeNull();
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("shows the waiting indicator and Stop while waiting", () => {
    render(
      <Thread
        state={state({ phase: "waiting", isRunning: true, runStartedAt: 1000 })}
        now={1000}
        onCancel={noop}
        onSend={noop}
      />,
    );
    expect(screen.getByTestId("waiting-indicator")).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
  });

  it("counts elapsed whole seconds while waiting", () => {
    render(
      <Thread
        state={state({ phase: "waiting", isRunning: true, runStartedAt: 1000 })}
        now={35400}
        onCancel={noop}
        onSend={noop}
      />,
    );
    expect(screen.getByTestId("waiting-indicator").textContent).toMatch(/34\s*s/);
  });

  it("announces the wait to assistive technology", () => {
    render(
      <Thread
        state={state({ phase: "waiting", isRunning: true, runStartedAt: 0 })}
        now={0}
        onCancel={noop}
        onSend={noop}
      />,
    );
    expect(screen.getByTestId("waiting-indicator").getAttribute("aria-live")).toBe("polite");
  });

  it("drops the waiting indicator once streaming starts, and keeps Stop", () => {
    render(
      <Thread
        state={state({ phase: "streaming", isRunning: true, runStartedAt: 1000 })}
        now={5000}
        onCancel={noop}
        onSend={noop}
      />,
    );
    expect(screen.queryByTestId("waiting-indicator")).toBeNull();
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
  });

  it("calls onCancel when Stop is pressed", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    let cancelled = 0;
    render(
      <Thread
        state={state({ phase: "waiting", isRunning: true, runStartedAt: 0 })}
        now={0}
        onCancel={() => {
          cancelled += 1;
        }}
        onSend={noop}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /stop/i }));
    expect(cancelled).toBe(1);
  });

  it("renders the error when one is present", () => {
    render(
      <Thread
        state={state({ error: { message: "upstream exploded" } })}
        now={0}
        onCancel={noop}
        onSend={noop}
      />,
    );
    expect(screen.getByText(/upstream exploded/)).toBeTruthy();
  });
});

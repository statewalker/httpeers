/**
 * `ChatApp`'s startup gating, now that the settings dialog is a single slots-filled dialog
 * (Task 5) instead of two separate ones. `startupStep`'s pure logic is covered in
 * `config.test.ts`; this file covers the UI behaviour it drives -- in particular that the
 * dialog stays open and cannot be dismissed until there is a usable endpoint, exactly as the old
 * two-dialog `SettingsDialog`/`ModelDialog` pair did.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { memoryConfigStore } from "../src/core/config.js";
import { memorySessionStore } from "../src/core/sessions.js";
import { ChatApp } from "../src/ui/ChatApp.js";
import { testClock } from "./helpers.js";

function renderApp(initial: Parameters<typeof memoryConfigStore>[0] = null) {
  return render(
    <ChatApp
      configStore={memoryConfigStore(initial)}
      sessionStore={memorySessionStore(testClock())}
    />,
  );
}

describe("ChatApp startup gating", () => {
  it("shows the settings dialog, non-dismissibly, on the Connection tab, when there is no config", async () => {
    renderApp(null);
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    expect(screen.getByRole("tab", { name: "Connection" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Models" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Connection" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.setup().keyboard("{Escape}");
    // Still there: Escape is a dismiss attempt, and there is nothing to go back to yet.
    expect(screen.getByRole("dialog", { name: /settings/i })).toBe(dialog);
  });

  it("keeps the dialog open, non-dismissibly, on the Models tab, once a connection is set but no model is chosen", async () => {
    renderApp({ baseUrl: "http://llm.test/v1", models: [] });
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    // A user who just finished the Connection form is sent to Models, not back to what they
    // already filled in.
    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");

    await userEvent.setup().keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: /settings/i })).toBe(dialog);
  });

  it("does not show the dialog on load, and lets it be dismissed, once fully configured", async () => {
    renderApp({ baseUrl: "http://llm.test/v1", models: ["m1"], defaultModel: "m1" });
    const settingsButton = await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByRole("dialog")).toBeNull();

    const user = userEvent.setup();
    await user.click(settingsButton);
    expect(screen.getByRole("dialog", { name: /settings/i })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

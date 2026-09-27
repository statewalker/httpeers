import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppShell } from "../src/ui/AppShell.js";

const shell = () =>
  render(
    <AppShell
      sidebar={<nav aria-label="Conversations">side</nav>}
      header={<h1>Chat</h1>}
      composer={<form aria-label="Message">composer</form>}
    >
      <div>messages</div>
    </AppShell>,
  );

describe("AppShell", () => {
  it("renders all four regions", () => {
    shell();
    expect(screen.getByRole("navigation", { name: "Conversations" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chat" })).toBeTruthy();
    expect(screen.getByText("messages")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Message" })).toBeTruthy();
  });

  it("offers a menu button that opens the sidebar in a dialog", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole("button", { name: /conversations|menu/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes that dialog on Escape", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole("button", { name: /conversations|menu/i }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the sidebar content only once in the accessibility tree", () => {
    shell();
    expect(screen.getAllByRole("navigation", { name: "Conversations" })).toHaveLength(1);
  });

  it("keeps the sidebar content to exactly one accessible copy even while the menu dialog is open", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole("button", { name: /conversations|menu/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Conversations" })).toHaveLength(1);
  });
});

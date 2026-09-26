/**
 * `MemberKeyButton`'s shadcn Dialog migration (Task 14's deferred finding #1): only `typecheck`
 * and `build` covered it before this file. Not a full mint-and-share flow -- `tests/discover.test
 * .ts` already covers `mintKey`/`keyShareText` -- just the two things a Dialog migration can
 * silently break: the dialog opens with an accessible name, and it closes.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemberKeyButton } from "../src/mesh/member-key.js";

const noopFetch: typeof fetch = () => {
  throw new Error("not called by these tests");
};

describe("MemberKeyButton", () => {
  it("opens a dialog with an accessible name when the trigger is clicked", async () => {
    render(
      <MemberKeyButton
        fetchImpl={noopFetch}
        serviceBase="https://hub.test/llm/"
        pageUrl="https://hub.test/mesh.html"
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: /key for a member/i }));

    expect(screen.getByRole("dialog", { name: /key for a member/i })).toBeTruthy();
    expect(screen.getByLabelText(/who is it for/i)).toBeTruthy();
  });

  it("closes on Escape, back to the trigger with no dialog", async () => {
    render(
      <MemberKeyButton
        fetchImpl={noopFetch}
        serviceBase="https://hub.test/llm/"
        pageUrl="https://hub.test/mesh.html"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /key for a member/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /key for a member/i })).toBeTruthy();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConfirmConfigDialog } from "../src/ui/ConfirmConfigDialog.js";

const props = { origin: "https://evil.example", baseUrl: "https://evil.example/v1" };

describe("ConfirmConfigDialog", () => {
  it("names the origin AND the endpoint it wants to use", () => {
    render(<ConfirmConfigDialog {...props} onAccept={() => {}} onReject={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toContain("https://evil.example");
    expect(screen.getByRole("dialog").textContent).toContain("https://evil.example/v1");
  });

  it("makes Cancel the default focused action", () => {
    render(<ConfirmConfigDialog {...props} onAccept={() => {}} onReject={() => {}} />);
    expect(document.activeElement?.textContent).toMatch(/cancel/i);
  });

  it("rejects on Escape", async () => {
    let rejected = 0;
    render(
      <ConfirmConfigDialog
        {...props}
        onAccept={() => {}}
        onReject={() => {
          rejected += 1;
        }}
      />,
    );
    await userEvent.setup().keyboard("{Escape}");
    expect(rejected).toBe(1);
  });

  it("accepts only on the explicit action", async () => {
    let accepted = 0;
    render(
      <ConfirmConfigDialog
        {...props}
        onAccept={() => {
          accepted += 1;
        }}
        onReject={() => {}}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /use this/i }));
    expect(accepted).toBe(1);
  });
});

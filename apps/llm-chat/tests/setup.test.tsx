import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("the component test substrate", () => {
  it("renders a React element and finds it by role", () => {
    render(<button type="button">Press</button>);
    expect(screen.getByRole("button", { name: "Press" })).toBeTruthy();
  });
});

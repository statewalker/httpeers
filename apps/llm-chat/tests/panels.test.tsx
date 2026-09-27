/**
 * Unit coverage for the two settings-dialog panels extracted in Task 5/6 -- `ModelsPanel` and
 * `ConnectionPanel` had no unit test file of their own (final-review finding #3). Spec §9's "marks
 * the resolved default" is implemented at `ModelsPanel.tsx:69` (`checked={choice === model}`) but
 * was only ever exercised incidentally by `standalone.spec.mjs`, which counts radios and never
 * asserts which one is checked. `ConnectionPanel` is covered minimally alongside it.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionPanel } from "../src/ui/panels/ConnectionPanel.js";
import { ModelsPanel } from "../src/ui/panels/ModelsPanel.js";

/** A `fetchImpl` answering `GET /models` with `ids`, recording nothing -- the panels don't need it. */
function modelsFetch(ids: string[]): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("ModelsPanel", () => {
  it("marks the resolved default as checked, and no other model, once the list loads (spec §9)", async () => {
    render(
      <ModelsPanel
        endpoint={{ baseUrl: "http://llm.test/v1" }}
        current="beta"
        onPick={() => {}}
        fetchImpl={modelsFetch(["alpha", "beta"])}
      />,
    );

    const beta = await screen.findByRole("radio", { name: "beta" });
    const alpha = screen.getByRole("radio", { name: "alpha" });
    expect(beta).toHaveProperty("checked", true);
    expect(alpha).toHaveProperty("checked", false);
  });

  it("falls back to the list's first model when the current default isn't in it", async () => {
    render(
      <ModelsPanel
        endpoint={{ baseUrl: "http://llm.test/v1" }}
        current="does-not-exist"
        onPick={() => {}}
        fetchImpl={modelsFetch(["alpha", "beta"])}
      />,
    );

    const alpha = await screen.findByRole("radio", { name: "alpha" });
    expect(alpha).toHaveProperty("checked", true);
  });

  it("calls onPick with the full model list and the chosen model on submit", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <ModelsPanel
        endpoint={{ baseUrl: "http://llm.test/v1" }}
        current="alpha"
        onPick={onPick}
        fetchImpl={modelsFetch(["alpha", "beta"])}
      />,
    );

    await screen.findByRole("radio", { name: "alpha" });
    await user.click(screen.getByRole("radio", { name: "beta" }));
    await user.click(screen.getByRole("button", { name: "Use model" }));

    expect(onPick).toHaveBeenCalledWith(["alpha", "beta"], "beta");
  });
});

describe("ConnectionPanel", () => {
  it("saves the entered base URL and key", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConnectionPanel initial={null} onSave={onSave} />);

    await user.type(screen.getByLabelText("Base URL"), "http://llm.test/v1");
    await user.type(screen.getByLabelText("API key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ baseUrl: "http://llm.test/v1", apiKey: "sk-test" });
  });

  it("reports success through the injected fetchImpl when Test is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionPanel
        initial={null}
        onSave={() => {}}
        fetchImpl={modelsFetch(["alpha", "beta"])}
      />,
    );

    await user.type(screen.getByLabelText("Base URL"), "http://llm.test/v1");
    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText(/Connected: 2 model\(s\) available\./)).toBeTruthy();
  });
});

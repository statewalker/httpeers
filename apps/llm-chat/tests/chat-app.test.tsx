/**
 * `ChatApp`'s startup gating, now that the settings dialog is a single slots-filled dialog
 * (Task 5) instead of two separate ones. `startupStep`'s pure logic is covered in
 * `config.test.ts`; this file covers the UI behaviour it drives -- in particular that the
 * dialog stays open and cannot be dismissed until there is a usable endpoint, exactly as the old
 * two-dialog `SettingsDialog`/`ModelDialog` pair did.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A `Response` whose body is `body`, JSON-encoded. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ChatApp ?config= wiring", () => {
  afterEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("applies and saves a trusted ?config= document without asking, and strips the param", async () => {
    window.history.pushState(null, "", "/?config=./ext.json");
    const configStore = memoryConfigStore(null);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ schemaVersion: 1, baseUrl: "http://llm.test/v1" }),
    ) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    await screen.findByRole("tab", { name: "Models" });
    expect(screen.queryByRole("dialog", { name: /unfamiliar/i })).toBeNull();
    expect((await configStore.get())?.baseUrl).toBe("http://llm.test/v1");
    expect(new URL(location.href).searchParams.has("config")).toBe(false);
  });

  it("shows ConfirmConfigDialog for an untrusted origin, naming both the origin and the wanted endpoint", async () => {
    window.history.pushState(null, "", "/?config=https://evil.example/ext.json");
    const configStore = memoryConfigStore(null);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ schemaVersion: 1, baseUrl: "https://evil.example/v1" }),
    ) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: /unfamiliar/i });
    expect(dialog.textContent).toContain("https://evil.example");
    expect(dialog.textContent).toContain("https://evil.example/v1");
    // Untouched until the user decides.
    expect(await configStore.get()).toBeNull();
  });

  it("applies an untrusted config once the user accepts", async () => {
    window.history.pushState(null, "", "/?config=https://evil.example/ext.json");
    const configStore = memoryConfigStore(null);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ schemaVersion: 1, baseUrl: "https://evil.example/v1" }),
    ) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    await screen.findByRole("dialog", { name: /unfamiliar/i });
    await userEvent.setup().click(screen.getByRole("button", { name: /use this/i }));

    expect(screen.queryByRole("dialog", { name: /unfamiliar/i })).toBeNull();
    expect((await configStore.get())?.baseUrl).toBe("https://evil.example/v1");
  });

  it("does nothing and says so when the user rejects an untrusted config", async () => {
    window.history.pushState(null, "", "/?config=https://evil.example/ext.json");
    const configStore = memoryConfigStore(null);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ schemaVersion: 1, baseUrl: "https://evil.example/v1" }),
    ) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    await screen.findByRole("dialog", { name: /unfamiliar/i });
    await userEvent.setup().click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("dialog", { name: /unfamiliar/i })).toBeNull();
    expect(await configStore.get()).toBeNull();
    expect(await screen.findByText(/not accepted/i)).toBeTruthy();
  });

  it("shows a visible, non-fatal notice naming the URL when the fetch fails, and leaves any saved config alone", async () => {
    window.history.pushState(null, "", "/?config=./ext.json");
    const configStore = memoryConfigStore({
      baseUrl: "http://saved.test/v1",
      models: ["m1"],
      defaultModel: "m1",
    });
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    const notice = await screen.findByText(/Could not use the config/i);
    expect(notice.textContent).toContain("./ext.json");
    expect(notice.textContent).toMatch(/404/);
    // Falls back to the saved config: the chat is usable, not stuck on settings.
    expect(await screen.findByRole("button", { name: "Settings" })).toBeTruthy();
    expect((await configStore.get())?.baseUrl).toBe("http://saved.test/v1");
  });

  it("feeds ExternalConfig.defaultModel as the candidate default after GET /models (carry-forward 1)", async () => {
    window.history.pushState(null, "", "/?config=./ext.json");
    const configStore = memoryConfigStore(null);
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes("/models")) {
        return jsonResponse({ data: [{ id: "gpt-a" }, { id: "gpt-b" }] });
      }
      return jsonResponse({
        schemaVersion: 1,
        baseUrl: "http://llm.test/v1",
        defaultModel: "gpt-b",
      });
    }) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    // Fully configured: no forced settings dialog, unlike a document with no defaultModel.
    await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const saved = await configStore.get();
    expect(saved?.models).toEqual(["gpt-a", "gpt-b"]);
    expect(saved?.defaultModel).toBe("gpt-b");
  });

  it("falls back to fetched[0] when the document's defaultModel is not actually served", async () => {
    window.history.pushState(null, "", "/?config=./ext.json");
    const configStore = memoryConfigStore(null);
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes("/models")) {
        return jsonResponse({ data: [{ id: "gpt-a" }] });
      }
      return jsonResponse({
        schemaVersion: 1,
        baseUrl: "http://llm.test/v1",
        defaultModel: "does-not-exist",
      });
    }) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        fetchImpl={fetchImpl}
      />,
    );

    await screen.findByRole("button", { name: "Settings" });
    const saved = await configStore.get();
    expect(saved?.defaultModel).toBe("gpt-a");
  });
});

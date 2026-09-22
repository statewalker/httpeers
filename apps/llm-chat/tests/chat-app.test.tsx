/**
 * `ChatApp`'s startup gating, now that the settings dialog is a single slots-filled dialog
 * (Task 5) instead of two separate ones. `startupStep`'s pure logic is covered in
 * `config.test.ts`; this file covers the UI behaviour it drives -- in particular that the
 * dialog stays open and cannot be dismissed until there is a usable endpoint, exactly as the old
 * two-dialog `SettingsDialog`/`ModelDialog` pair did.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it('shows the raw config URL, never the WHATWG opaque origin "null", when the origin is opaque (deferred finding #3)', async () => {
    // data:/javascript:/file: all parse to url.origin === "null" (judgeConfigUrl's own test file
    // pins that); ChatApp is where "null" gets substituted for something a user can actually read.
    const configUrl = "data:application/json,{}";
    window.history.pushState(null, "", `/?config=${encodeURIComponent(configUrl)}`);
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

    // Rendered through a Radix portal (into document.body), not under ChatApp's own container.
    const dialog = await screen.findByRole("dialog", { name: /unfamiliar/i });
    const origin = dialog.querySelectorAll("strong")[0]?.textContent;
    expect(origin).toBe(configUrl);
    expect(dialog.textContent).not.toContain("null wants this chat");
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

  it("on the mesh page, does not let a ?config= document override the endpoint discovered from the hub", async () => {
    // The mesh shape: configStore is already pre-populated (discover() in mesh.tsx saves the
    // discovered endpoint before ChatApp ever mounts) and edgeBase is set. A ?config= document
    // under that same edge, naming a DIFFERENT baseUrl, must not win -- otherwise a crafted link
    // could redirect the chat away from the hub the user just joined, which is exactly what
    // discover.ts's "trust only the hub" rule exists to prevent.
    const edgeBase = "http://localhost:3000/peers/hub/";
    window.history.pushState(
      null,
      "",
      `/mesh.html?config=${encodeURIComponent(`${edgeBase}llm/config.json`)}`,
    );
    const configStore = memoryConfigStore({
      baseUrl: "http://discovered.test/v1",
      apiKeyHeader: "x-litellm-api-key",
      apiKey: "k",
      models: ["m1"],
      defaultModel: "m1",
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ schemaVersion: 1, baseUrl: "http://attacker.test/v1" }),
    ) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        edgeBase={edgeBase}
        fetchImpl={fetchImpl}
      />,
    );

    // Fully configured already -- no dialog, no settings gate, and no override.
    await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const saved = await configStore.get();
    expect(saved?.baseUrl).toBe("http://discovered.test/v1");
  });

  it("on the mesh page, never offers ConfirmConfigDialog for an untrusted ?config= -- it would promise an effect it cannot have (final-review finding #5)", async () => {
    // A foreign origin's document, on the mesh page: `judgeConfigUrl` distrusts it (it isn't
    // under the discovered edge), so the standalone page would show ConfirmConfigDialog. On the
    // mesh page that dialog's "Use this configuration" button cannot do what it says -- the hub's
    // discovered endpoint always wins (see `applyExternalConfig`'s comment and the previous test)
    // -- so it must never be shown here at all; the document is ignored with a plain, honest
    // notice instead. The discovered endpoint must still win, exactly as above.
    const edgeBase = "http://localhost:3000/peers/hub/";
    window.history.pushState(
      null,
      "",
      `/mesh.html?config=${encodeURIComponent("https://evil.example/ext.json")}`,
    );
    const configStore = memoryConfigStore({
      baseUrl: "http://discovered.test/v1",
      apiKeyHeader: "x-litellm-api-key",
      apiKey: "k",
      models: ["m1"],
      defaultModel: "m1",
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ schemaVersion: 1, baseUrl: "https://evil.example/v1" }),
    ) as unknown as typeof fetch;

    render(
      <ChatApp
        configStore={configStore}
        sessionStore={memorySessionStore(testClock())}
        edgeBase={edgeBase}
        fetchImpl={fetchImpl}
      />,
    );

    const notice = await screen.findByText(/Ignored the config at https:\/\/evil\.example/i);
    expect(notice.textContent).toMatch(/discovered from its hub/i);
    // Never offered, not even momentarily -- the promise the dialog would make is the bug.
    expect(screen.queryByRole("dialog", { name: /unfamiliar/i })).toBeNull();
    const saved = await configStore.get();
    expect(saved?.baseUrl).toBe("http://discovered.test/v1");
  });
});

describe("ChatApp elapsed-time ticking", () => {
  // `useNow`'s `setInterval` (ChatApp.tsx) can be deleted with vitest fully green -- only the
  // `standalone.spec.mjs` e2e spec catches it, via a real 1s+ wait (final-review finding #4). This
  // pins the tick in vitest, with fake timers driving `setInterval` instead of a real wait: a
  // request that never resolves keeps the run in the "waiting" phase indefinitely, so the only
  // thing that can move the rendered elapsed seconds is `useNow`'s own interval.
  it("ticks the waiting indicator's elapsed seconds forward as fake time advances", async () => {
    vi.useFakeTimers();
    try {
      const configStore = memoryConfigStore({
        baseUrl: "http://llm.test/v1",
        models: ["m1"],
        defaultModel: "m1",
      });
      // Never resolves: the run stays in "waiting" for as long as the test needs it to.
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

      render(
        <ChatApp
          configStore={configStore}
          sessionStore={memorySessionStore(testClock())}
          fetchImpl={fetchImpl}
        />,
      );

      // Flush the config-store load (a microtask chain, not a timer) without touching fake time.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      const indicator = screen.getByTestId("waiting-indicator");
      expect(indicator.textContent).toMatch(/\b0s\b/);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(indicator.textContent).toMatch(/\b3s\b/);
    } finally {
      vi.useRealTimers();
    }
  });
});

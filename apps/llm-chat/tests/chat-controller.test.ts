import { describe, expect, it } from "vitest";
import {
  ChatBusyError,
  type ChatClient,
  type ChatController,
  createChatController,
} from "../src/core/chat-controller.js";
import { ChatHttpError } from "../src/core/openai-client.js";
import { type ChatMessage, memorySessionStore, type SessionStore } from "../src/core/sessions.js";
import { testClock } from "./helpers.js";

/**
 * A client that replays a script and records every request.
 *   deltas: yielded in order, one microtask apart
 *   fail:   thrown after the deltas
 *   hang:   after the deltas, wait until the signal aborts, then throw AbortError
 */
function scriptedClient(script: { deltas: string[]; fail?: Error; hang?: boolean }) {
  const requests: Array<{ model: string; messages: readonly ChatMessage[] }> = [];
  const client: ChatClient = {
    async *stream({ model, messages, signal }) {
      requests.push({ model, messages: structuredClone([...messages]) });
      for (const delta of script.deltas) {
        await Promise.resolve();
        yield delta;
      }
      if (script.fail) throw script.fail;
      if (script.hang) {
        // Like a real fetch: an already-aborted signal must not be waited on.
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        }
        throw new DOMException("aborted", "AbortError");
      }
    },
  };
  return { client, requests };
}

function setup(
  script: Parameters<typeof scriptedClient>[0],
  model: string | null = "m1",
): {
  controller: ChatController;
  sessions: SessionStore;
  requests: ReturnType<typeof scriptedClient>["requests"];
  saved: string[];
} {
  const sessions = memorySessionStore(testClock());
  const { client, requests } = scriptedClient(script);
  const saved: string[] = [];
  const controller = createChatController({
    sessions,
    client,
    resolveModel: () => model ?? undefined,
    onSaved: (s) => saved.push(s.id),
  });
  return { controller, sessions, requests, saved };
}

describe("chat controller", () => {
  it("send creates a titled session, streams the reply, and saves both messages", async () => {
    const { controller, sessions, requests, saved } = setup({ deltas: ["Hel", "lo"] });
    await controller.send("  hi there ");
    const { session, isRunning, error } = controller.getState();
    expect(isRunning).toBe(false);
    expect(error).toBeNull();
    expect(session?.messages).toEqual([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(await sessions.get(session?.id ?? "")).toMatchObject({ title: "hi there", model: "m1" });
    expect(requests).toEqual([{ model: "m1", messages: [{ role: "user", content: "hi there" }] }]);
    expect(saved.length).toBeGreaterThan(0);
  });

  it("shows the partial reply while it streams", async () => {
    const { controller } = setup({ deltas: ["Hel", "lo"] });
    const seen: string[] = [];
    controller.subscribe(() => {
      const last = controller.getState().session?.messages.at(-1);
      if (last?.role === "assistant") seen.push(last.content);
    });
    await controller.send("hi");
    expect(seen).toContain("Hel");
    expect(seen.at(-1)).toBe("Hello");
  });

  it("sends the whole history on a follow-up", async () => {
    const { controller, requests } = setup({ deltas: ["ok"] });
    await controller.send("one");
    await controller.send("two");
    expect(requests[1]?.messages.map((m) => m.content)).toEqual(["one", "ok", "two"]);
  });

  it("cancel keeps the partial reply and reports no error", async () => {
    const { controller, sessions } = setup({ deltas: ["par"], hang: true });
    controller.subscribe(() => {
      if (controller.getState().session?.messages.at(-1)?.content === "par") controller.cancel();
    });
    await controller.send("hi");
    const { session, error, isRunning } = controller.getState();
    expect(isRunning).toBe(false);
    expect(error).toBeNull();
    expect((await sessions.get(session?.id ?? ""))?.messages.at(-1)).toEqual({
      role: "assistant",
      content: "par",
    });
  });

  it("cancel before any text saves no assistant message", async () => {
    const { controller } = setup({ deltas: [], hang: true });
    const sending = controller.send("hi");
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.cancel();
    await sending;
    expect(controller.getState().session?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("an error mid-stream keeps the partial reply and shows the error", async () => {
    const { controller, sessions } = setup({
      deltas: ["half"],
      fail: new ChatHttpError(500, "boom", undefined),
    });
    await controller.send("hi");
    const { session, error } = controller.getState();
    expect(error?.message).toContain("500");
    expect((await sessions.get(session?.id ?? ""))?.messages.at(-1)?.content).toBe("half");
  });

  it("refuses a second send while a reply streams", async () => {
    const { controller } = setup({ deltas: [], hang: true });
    const first = controller.send("one");
    await expect(controller.send("two")).rejects.toBeInstanceOf(ChatBusyError);
    controller.cancel();
    await first;
  });

  it("regenerate replaces the last reply", async () => {
    const { controller, requests } = setup({ deltas: ["r"] });
    await controller.send("q");
    await controller.regenerate();
    expect(controller.getState().session?.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "r" },
    ]);
    expect(requests[1]?.messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("regenerateFrom replies again to an earlier message and drops what followed", async () => {
    const { controller, requests } = setup({ deltas: ["r"] });
    await controller.send("one");
    await controller.send("two");
    await controller.regenerateFrom(0);
    expect(controller.getState().session?.messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "r" },
    ]);
    expect(requests.at(-1)?.messages).toEqual([{ role: "user", content: "one" }]);
  });

  it("regenerateFrom on a non-user index changes nothing and makes no request", async () => {
    const { controller, requests } = setup({ deltas: ["r"] });
    await controller.send("one");
    const before = controller.getState().session?.messages;
    await controller.regenerateFrom(1);
    expect(controller.getState().session?.messages).toEqual(before);
    expect(requests).toHaveLength(1);
  });

  it("edit replaces a user message, drops what followed, and replies again", async () => {
    const { controller, requests } = setup({ deltas: ["r"] });
    await controller.send("one");
    await controller.send("two");
    await controller.edit(0, "changed");
    expect(controller.getState().session?.messages).toEqual([
      { role: "user", content: "changed" },
      { role: "assistant", content: "r" },
    ]);
    expect(requests.at(-1)?.messages).toEqual([{ role: "user", content: "changed" }]);
  });

  it("without a model it saves the message, shows an error, and calls nothing", async () => {
    const { controller, requests } = setup({ deltas: ["r"] }, null);
    await controller.send("hi");
    expect(controller.getState().error?.message).toBe("No model is selected.");
    expect(controller.getState().session?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(requests).toEqual([]);
  });

  it("open loads a stored session and open(null) clears the view", async () => {
    const { controller, sessions } = setup({ deltas: [] });
    const stored = await sessions.create({
      title: "old",
      messages: [{ role: "user", content: "x" }],
    });
    await controller.open(stored.id);
    expect(controller.getState().session).toEqual(stored);
    await controller.open(null);
    expect(controller.getState().session).toBeNull();
  });

  it("setModel stores the model on the open session", async () => {
    const { controller, sessions } = setup({ deltas: ["r"] });
    await controller.send("hi");
    await controller.setModel("m2");
    const id = controller.getState().session?.id ?? "";
    expect((await sessions.get(id))?.model).toBe("m2");
  });
});

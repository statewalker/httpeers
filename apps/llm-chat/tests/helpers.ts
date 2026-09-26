/** Fakes shared by the core tests. */

import {
  type ChatClient,
  type ChatController,
  createChatController,
} from "../src/core/chat-controller.js";
import { memorySessionStore } from "../src/core/sessions.js";

const encoder = new TextEncoder();

/** One SSE event carrying a content delta. */
export function deltaEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

/** A 200 `text/event-stream` response whose body arrives as exactly these chunks. */
export function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Cut `text` into pieces of `size` characters, so lines and events straddle chunks. */
export function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** A body that sends `first`, then stays open until `signal` aborts, like a real fetch. */
export function hangingSseResponse(
  first: string,
  signal: AbortSignal | null | undefined,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      signal?.addEventListener("abort", () =>
        controller.error(new DOMException("The operation was aborted.", "AbortError")),
      );
    },
  });
  return new Response(body, { status: 200 });
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** A deterministic clock and id source for stores. */
export function testClock(): { now: () => number; newId: () => string } {
  let time = 1_000;
  let id = 0;
  return { now: () => ++time, newId: () => `s${++id}` };
}

/** A minimal, ready-to-use controller. Its client is never called by tests that use this. */
export function makeController(): ChatController {
  const client: ChatClient = {
    async *stream() {
      // No caller of `makeController` drives a request; this generator is never pulled.
    },
  };
  return createChatController({
    sessions: memorySessionStore(testClock()),
    client,
    resolveModel: () => "m1",
  });
}

type StreamEvent =
  | { type: "delta"; value: string }
  | { type: "end" }
  | { type: "error"; error: unknown };

/** A single-consumer async queue: `push` never blocks, `next` waits for the next push. */
function asyncQueue<T>(): { push: (item: T) => void; next: () => Promise<T> } {
  const pending: T[] = [];
  const waiters: Array<(item: T) => void> = [];
  return {
    push(item) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else pending.push(item);
    },
    next() {
      const item = pending.shift();
      if (item !== undefined) return Promise.resolve(item);
      return new Promise<T>((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * A controller whose stream is driven by hand: `emit`/`finish`/`fail` feed the async generator
 * the controller is iterating, and `sent` resolves once that generator is first pulled (i.e. the
 * request has gone out), so a test can observe the gap between "sent" and "first delta".
 */
export function makeControllerWithControllableStream(): {
  controller: ChatController;
  emit: (delta: string) => void;
  finish: () => void;
  fail: (error: unknown) => void;
  sent: Promise<void>;
} {
  const queue = asyncQueue<StreamEvent>();
  let resolveSent!: () => void;
  const sent = new Promise<void>((resolve) => {
    resolveSent = resolve;
  });

  const client: ChatClient = {
    async *stream({ signal }) {
      resolveSent();
      // Like a real fetch: cancel() aborts the signal, which must unblock a pending pull.
      const onAbort = (): void => {
        queue.push({ type: "error", error: new DOMException("aborted", "AbortError") });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          const event = await queue.next();
          if (event.type === "delta") yield event.value;
          else if (event.type === "end") return;
          else throw event.error;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };

  const controller = createChatController({
    sessions: memorySessionStore(testClock()),
    client,
    resolveModel: () => "m1",
  });

  return {
    controller,
    emit: (delta) => queue.push({ type: "delta", value: delta }),
    finish: () => queue.push({ type: "end" }),
    fail: (error) => queue.push({ type: "error", error }),
    sent,
  };
}

/** Flush pending microtasks and timers, so state changes triggered by a just-fired event have landed. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

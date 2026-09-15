/** Fakes shared by the core tests. */

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

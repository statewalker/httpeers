/**
 * An exchange's byte stream with the pieces its producer writes back to back
 * joined into one chunk, for the mux path (`mux-link.ts`, #56).
 *
 * WHY. The HTTP/1.1 codec (webrun-http-streams) yields a message in small
 * pieces: the head, then per body chunk its size line, the chunk and a CRLF,
 * then the last-chunk marker. A 256 B POST is five pieces and its echo five
 * more. On the per-exchange path each piece is one yamux frame (12 bytes of
 * header) in its own Noise message (18 more). On the mux each piece is one
 * windowed message of `duplexOverPort`, about 85 bytes of msgpack envelope
 * (`{type: "message", id, payload: {type: "webrun-rpc:chunk", channelName,
 * chunk: {done, value}}}`) plus the stream's length prefix. So the mux carried
 * about 1.3 KB on the wire per 256 B exchange each way where the per-exchange
 * path carried about 0.85 KB (`scripts/bench-mux-net.mjs`, measured on the
 * Noise layer). That costs nothing on a link with room to spare, but where
 * TCP's congestion window is the limit (1% and 3% loss: a few segments per
 * round trip) the exchange rate is bytes per round trip over bytes per
 * exchange, and the mux did about half the per-exchange path's rate at K=100.
 *
 * WHAT IT DOES. After each piece it keeps reading while the next one is
 * already on its way: a piece that arrives before the next task joins the
 * chunk, up to `maxBytes`. The first piece that does not arrive by then is
 * read ahead and starts the next chunk. Nothing waits for data that is not
 * already being produced: a chunk leaves at most one task after its last
 * piece. The bytes and their order are unchanged, only the chunk boundaries
 * move, which `duplexOverPort` and the HTTP codec on the other side do not
 * see (a byte stream), so it interoperates with every peer.
 *
 * READING AHEAD. One `next()` of the source may be outstanding while the
 * consumer holds the previous chunk (the piece that did not arrive in time).
 * A `return()` or `throw()` is passed to the source at once and, with no
 * read ahead pending, settles as the source's does. With one pending, the
 * consumer is freed at once (`return()` resolves done, `throw()` rejects
 * with its error), but an async generator source runs the `return()` or
 * `throw()`, and so its cleanup, only once that pending read settles: a
 * quiet producer (an SSE stream between events) is cleaned up at its next
 * event, not at once. A served exchange's output from webrun-http-streams
 * 0.5 is not an async generator: it takes the `return()` or `throw()` at once
 * and cancels an idle response body then.
 */

const TIMED_OUT = Symbol("timed out");

/** `it`, its back-to-back pieces joined into chunks of at most `maxBytes`; see the module comment. */
export function gatheringChunks(
  it: AsyncIterator<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  /** A read ahead: the source's next result, not yet handed out. */
  let ahead: Promise<IteratorResult<Uint8Array>> | undefined;
  let over = false;
  const out = {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (over) return { done: true, value: undefined };
      const read = ahead ?? it.next();
      ahead = undefined;
      let first: IteratorResult<Uint8Array>;
      try {
        first = await read;
      } catch (error) {
        over = true;
        throw error;
      }
      if (first.done) {
        over = true;
        return first;
      }
      const parts = [first.value];
      let size = first.value.byteLength;
      while (size < maxBytes) {
        const next = it.next();
        // Settled or not, `next` is handled here, so a rejection waiting for
        // the following call is never reported as unhandled.
        const raced: IteratorResult<Uint8Array> | typeof TIMED_OUT = await Promise.race([
          next.then(undefined, (): typeof TIMED_OUT => TIMED_OUT),
          nextTask(),
        ]);
        if (
          typeof raced === "symbol" ||
          raced.done === true ||
          size + raced.value.byteLength > maxBytes
        ) {
          // Late, the end, an error, or too big to join: the next call's.
          ahead = next;
          break;
        }
        parts.push(raced.value);
        size += raced.value.byteLength;
      }
      return { done: false, value: parts.length === 1 ? first.value : concat(parts, size) };
    },
    async return(value?: unknown): Promise<IteratorResult<Uint8Array>> {
      over = true;
      const pending = ahead;
      ahead = undefined;
      const returned = it.return?.(value as never) ?? Promise.resolve({ done: true, value });
      if (pending == null) return returned as Promise<IteratorResult<Uint8Array>>;
      // An async generator runs `return()` only once the read ahead settles,
      // which a quiet producer may never do: do not hold the consumer for it.
      void Promise.resolve(returned).catch(() => {});
      void pending.catch(() => {});
      return { done: true, value: value as never };
    },
    async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
      over = true;
      const pending = ahead;
      ahead = undefined;
      if (it.throw == null) throw error;
      const thrown = it.throw(error);
      if (pending == null) return thrown;
      // As `return()`: the source takes it once its read ahead settles; the
      // consumer gets what an unhandled throw gives, at once.
      void Promise.resolve(thrown).catch(() => {});
      void pending.catch(() => {});
      throw error;
    },
    [Symbol.asyncIterator]() {
      return out;
    },
  };
  return out as unknown as AsyncGenerator<Uint8Array>;
}

/** The parts as one buffer of `size` bytes. */
function concat(parts: Uint8Array[], size: number): Uint8Array {
  const joined = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return joined;
}

/**
 * Resolves on a later task, never a microtask: the codec's pieces pass
 * through several async generators, each step a few microtasks, so a
 * microtask bound would split them. `setImmediate` where it exists; elsewhere
 * a `MessageChannel`, because nested `setTimeout`s are clamped to 4 ms in
 * browsers.
 */
const nextTask: () => Promise<typeof TIMED_OUT> =
  typeof globalThis.setImmediate === "function"
    ? () => new Promise((resolve) => globalThis.setImmediate(() => resolve(TIMED_OUT)))
    : (() => {
        let channel: MessageChannel | undefined;
        const queue: (() => void)[] = [];
        return () =>
          new Promise<typeof TIMED_OUT>((resolve) => {
            if (channel == null) {
              channel = new MessageChannel();
              channel.port1.onmessage = () => queue.shift()?.();
            }
            queue.push(() => resolve(TIMED_OUT));
            channel.port2.postMessage(0);
          });
      })();

/**
 * 10 — revocation that reaches a stream already in flight.
 *
 * THE HOLE THIS CLOSES. The fetch path re-verifies on every request, so a
 * revoked member is refused within one heartbeat. A duplex has no second
 * request: it is authorised once, at open, and rung 09 recorded that a
 * removed member's long-lived stream therefore survives `hub.remove()`
 * indefinitely. An A2UI session lasts minutes; a tunnel lasts hours.
 *
 * NO LIBP2P, DELIBERATELY. The directive is that access validates with no
 * libp2p involvement, so this guard knows nothing about transports: it wraps
 * a stream handler and watches a registry. If it needed a connection object
 * it would be the wrong seam, and it would be untestable without a network.
 *
 * TWO TRIGGERS, BECAUSE ONE IS NOT ENOUGH:
 *
 *   - per chunk, which costs nothing and catches every active stream;
 *   - a timer, because the dangerous stream is the QUIET one. A tunnel that
 *     has gone idle produces no chunks to hang a check on, and it is exactly
 *     the stream an operator thinks they have cut off.
 */

export interface Claims {
  readonly sub: string;
  readonly issuedAt?: number;
}

/** The live deny-list. The hub writes it; every access check reads it. */
export interface Revocations {
  /** `null` while the subject is still good, otherwise the reason. */
  check(peerId: string, issuedAt?: number): string | null;
  /** Hub side. Bumps `version` so a poller can compare cheaply. */
  revoke(peerId: string, at?: number): void;
  readonly version: number;
}

export function createRevocations(now: () => number = Date.now): Revocations {
  const revoked = new Map<string, number>();
  let version = 0;
  return {
    check(peerId, issuedAt) {
      const at = revoked.get(peerId);
      if (at == null) return null;
      // A token minted AFTER the revocation is a re-admission, which is what
      // `iat` is carried for; anything older is cut off.
      if (issuedAt != null && issuedAt > at) return null;
      return "membership revoked";
    },
    revoke(peerId, at) {
      revoked.set(peerId, at ?? now());
      version += 1;
    },
    get version() {
      return version;
    },
  };
}

/** Thrown INTO the stream, so both ends see a reason rather than a silent close. */
export class StreamRevoked extends Error {
  constructor(
    readonly peerId: string,
    reason: string,
  ) {
    super(`stream revoked: ${reason} (${peerId})`);
    this.name = "StreamRevoked";
  }
}

export type StreamHandler = (input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;

export interface GuardInit {
  /** The peer this stream was authorised for, proven at open. */
  peerId: string;
  revocations: Revocations;
  /** The backstop for a stream that is quiet in both directions. */
  pollMs?: number;
  claims?: Claims;
}

/**
 * Wrap a stream handler so a revocation ends it.
 *
 * The guard races the handler's output against a watcher. Whichever settles
 * first wins: a chunk is yielded, or `StreamRevoked` is thrown. Throwing
 * (rather than returning) is what runs the handler's `finally` and what gives
 * the caller a reason instead of an unexplained end-of-stream.
 */
export function guardStream(handler: StreamHandler, init: GuardInit): StreamHandler {
  const pollMs = init.pollMs ?? 1_000;

  return async function* guarded(input): AsyncGenerator<Uint8Array> {
    const refused = (): string | null => init.revocations.check(init.peerId, init.claims?.issuedAt);

    // Refuse before a single byte moves: a stream opened by someone already
    // revoked must never start.
    const already = refused();
    if (already != null) throw new StreamRevoked(init.peerId, already);

    let timer: ReturnType<typeof setInterval> | undefined;

    // The watcher is one promise for the life of the stream, rejected the
    // moment the registry turns against this peer. A fresh timer per chunk
    // would miss the idle case entirely.
    let fail!: (error: Error) => void;
    const revoked = new Promise<never>((_, reject) => {
      fail = reject;
    });
    // Nothing awaits this promise unless the race below does; an unobserved
    // rejection would be an unhandled rejection warning, so it is parked.
    revoked.catch(() => {});

    timer = setInterval(() => {
      const reason = refused();
      if (reason != null) fail(new StreamRevoked(init.peerId, reason));
    }, pollMs);
    timer.unref?.();

    /**
     * BOTH DIRECTIONS ARE GUARDED, and the first version of this file guarded
     * only one — which is why claims 2 and 4 failed.
     *
     * A long-lived handler spends its life awaiting INPUT (`for await (chunk
     * of input)`). Interrupting only the output leaves that await pending
     * forever: the handler's `finally` never runs, and `iterator.return()`
     * queues behind a `next()` that will never settle, so the guard itself
     * hangs. Racing the input pull is what lets the handler unwind normally,
     * which then settles the output.
     */
    const guardedInput = (async function* (): AsyncGenerator<Uint8Array> {
      const source = input[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await Promise.race([source.next(), revoked]);
          if (next.done === true) return;

          /**
           * THE CHECK THAT MATTERS, AND THE FIRST VERSION HAD IT IN THE WRONG
           * PLACE. Checking only on the way out stops the REPLY but not the
           * WORK: by then the handler has already consumed the chunk and done
           * whatever it does — written a file, sent a message, charged a card.
           * A test caught this: `served:after` appeared in the handler's own
           * log after the member was revoked. Enforcement has to happen before
           * the chunk reaches the handler at all.
           */
          const reason = refused();
          if (reason != null) throw new StreamRevoked(init.peerId, reason);

          yield next.value;
        }
      } finally {
        await settle(source.return?.(undefined));
      }
    })();

    const iterator = handler(guardedInput)[Symbol.asyncIterator]();

    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), revoked]);
        if (next.done === true) return;

        // Per-chunk check, which costs a map lookup and catches an active
        // stream before its next byte is delivered rather than up to
        // `pollMs` later.
        const reason = refused();
        if (reason != null) throw new StreamRevoked(init.peerId, reason);

        yield next.value;
      }
    } finally {
      if (timer != null) clearInterval(timer);
      // The handler's own cleanup must run whichever way this ended —
      // revoked, cancelled, or finished. Bounded, because `return()` on a
      // generator parked mid-await is queued behind that await: rung 09
      // measured exactly that hang on the transport's own duplex.
      await settle(iterator.return?.(undefined));
    }
  };
}

/** Await a teardown that may never settle, without becoming the thing that hangs. */
async function settle(work: Promise<unknown> | undefined, budgetMs = 1_000): Promise<void> {
  if (work == null) return;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, budgetMs);
      timer.unref?.();
    }),
  ]);
}

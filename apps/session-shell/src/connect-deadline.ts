/**
 * A bound on the relay's CONNECT: a session whose relay page is alive but does
 * not answer must fail its fetches, not hang them (#20).
 *
 * WHY THIS EXISTS. The library's relay worker answers a request in two steps:
 * a CONNECT to the client that registered the key (`callChannel`), then the
 * request itself over the port that CONNECT hands back. Neither step is
 * bounded inside `serve()`. The ghost app bounds its HANDLER, but a CONNECT
 * that never reaches a handler -- a wedged relay page, a ghost whose keyed
 * CONNECT listener is gone -- leaves the fetch pending for as long as the page
 * that made it lives, with nothing on screen. The hand-rolled worker this
 * shell had before bounded its CONNECT at 15 s and answered 504; this puts
 * that bound back.
 *
 * HOW, WITHOUT A LIBRARY CHANGE. `startRelayServiceWorker` reaches the
 * registered client only as `scope.clients.get(id)` and only posts it
 * `{ type, params }` with the reply port first in the transfer list
 * (`callChannel`'s documented wire). So the scope handed to the library is
 * this module's view of `self`, whose clients put their own port in front of
 * every CONNECT's reply port:
 *
 *   - an answer in time is passed on unchanged, ports included;
 *   - no answer in time is answered FOR the client, with an error, on the
 *     library's own reply port. `serve()` then settles the way it settles any
 *     failed CONNECT -- its own catch, its own envelope, `decorateResponse` --
 *     and nothing is left waiting on a port that will never speak.
 *
 * Only the CONNECT is bounded, never the request that follows it: once the
 * client has answered, a slow handler is the ghost app's to bound.
 *
 * THE 504, AND WHY IT IS A TOKEN. `serve()` turns every failure that is not
 * its own `HttpError` into the same 500 envelope, and `decorateResponse` is
 * synchronous, so it can neither read the envelope's message nor learn which
 * request a timed-out CONNECT belonged to. What it can know is that a CONNECT
 * timed out a moment ago: each timeout leaves one short-lived token, and the
 * first 500 envelope after it takes the token and becomes the 504. The
 * library delivers that envelope within a task of the timeout, so a token
 * that is not claimed within `TOKEN_TTL_MS` belonged to a CONNECT that had no
 * envelope (a page's own CONNECT, a socket) and simply lapses. The residual is
 * stated in `takeTimeout`.
 *
 * WHAT IT CANNOT CLEAN UP. The data port the CONNECT carried has already been
 * transferred to the client; it is not this worker's to close. If the client
 * answers late, the answer is dropped here (the port that would carry it is
 * closed) and the library's end of the data channel, unreferenced once
 * `serve()` has settled, goes with the garbage. A ghost that wakes up and
 * starts serving on its end of it finds nobody there.
 */

/** The bound, as the hand-rolled worker had it. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** How long a timeout's token waits for the envelope it explains. */
export const TOKEN_TTL_MS = 2_000;

/** The error a timed-out CONNECT answers with -- what a caller of a page's own CONNECT reads. */
export function connectTimeoutMessage(ms: number): string {
  return `the session's app did not accept the connection within ${ms} ms`;
}

/** What the library posts a client: `callChannel`'s wire. */
interface ChannelCall {
  type?: unknown;
  params?: unknown;
}

/** The part of a ServiceWorker `Client` this module touches. */
interface ClientLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** The part of a ServiceWorker scope this module touches. */
interface ScopeLike {
  clients: { get(id: string): Promise<unknown> };
}

export interface ConnectDeadline<S> {
  /** `scope`, with every client it hands out bounding its CONNECTs. Give this to the library. */
  scope: S;
  /**
   * Does a timed-out CONNECT explain the envelope at hand? Takes the oldest
   * live token if there is one.
   *
   * THE RESIDUAL. A token is not tied to a request, so a different request's
   * own 500 envelope, landing in the same instant, could take it: that
   * request reads 504 and the timed-out one reads 500. Both are failures
   * during a wedge, and a request that hung for good is what this replaces.
   */
  takeTimeout(): boolean;
}

/** A MessagePort, duck-typed: the unit tests run where `MessagePort` is Node's. */
function isPort(value: unknown): value is MessagePort {
  return (
    value != null &&
    typeof (value as MessagePort).postMessage === "function" &&
    typeof (value as MessagePort).close === "function"
  );
}

/** A view of `target` whose methods still run on `target` -- platform objects refuse any other `this`. */
function view<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.hasOwn(overrides, prop)) return overrides[prop];
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

export function boundConnects<S extends ScopeLike>(
  scope: S,
  options: { timeoutMs?: number; tokenTtlMs?: number; now?: () => number } = {},
): ConnectDeadline<S> {
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const tokens: number[] = [];

  function postBounded(client: ClientLike, message: ChannelCall, transfer: Transferable[]): void {
    const [reply, ...rest] = transfer;
    if (!isPort(reply)) {
      client.postMessage(message, transfer);
      return;
    }
    const watch = new MessageChannel();
    const timer = setTimeout(() => {
      // The client's answer, should it come now, has nowhere to go.
      watch.port1.close();
      tokens.push(now());
      reply.postMessage({ error: { message: connectTimeoutMessage(timeoutMs) } });
      reply.close();
    }, timeoutMs);
    watch.port1.onmessage = (event) => {
      clearTimeout(timer);
      watch.port1.close();
      reply.postMessage(event.data, [...event.ports]);
      reply.close();
    };
    client.postMessage(message, [watch.port2, ...rest]);
  }

  function boundClient(client: ClientLike & object): ClientLike {
    return view(client, {
      postMessage(message: unknown, transfer?: Transferable[]) {
        if ((message as ChannelCall | null)?.type === "CONNECT" && transfer?.length) {
          postBounded(client, message as ChannelCall, transfer);
        } else {
          client.postMessage(message, transfer);
        }
      },
    });
  }

  const clients = view(scope.clients, {
    async get(id: string) {
      const client = await scope.clients.get(id);
      return client == null ? client : boundClient(client as ClientLike & object);
    },
  });

  return {
    scope: view(scope, { clients }),
    takeTimeout() {
      const at = now();
      while (tokens.length > 0 && at - (tokens[0] as number) > tokenTtlMs) tokens.shift();
      if (tokens.length === 0) return false;
      tokens.shift();
      return true;
    },
  };
}

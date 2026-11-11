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
 * HOW, WITHOUT A LIBRARY CHANGE. The library is handed this module's view of
 * `self`, which differs from `self` in two places:
 *
 *   1. `clients.get` hands out clients that put their own port in front of
 *      the reply port of every HTTP CONNECT. An answer in time is passed on
 *      unchanged, ports included. No answer in time is answered FOR the
 *      client, with an error carrying `connectTimeoutMessage(ms)`, on the
 *      library's own reply port -- so `serve()` settles the way it settles any
 *      failed CONNECT, through its own catch, and nothing is left waiting on a
 *      port that will never speak.
 *   2. `addEventListener("fetch")` hands the library's listener a view of each
 *      event whose `respondWith` sees the answer before the browser does.
 *      `serve()` makes every foreign failure the same 500 envelope, with the
 *      error's message in its body; an envelope whose message is exactly the
 *      timeout's is the timed-out request's own, and `finish` turns it into
 *      the 504. Deterministic: the body says which request it is, so no other
 *      request's failure can be taken for it.
 *
 * Only the CONNECT is bounded, never the request that follows it: once the
 * client has answered, a slow handler is the ghost app's to bound.
 *
 * ONLY HTTP CONNECTS. A socket's CONNECT (`type: "ws"`) is answered once the
 * app has accepted the upgrade, which is the app's to take its time over, so
 * it is left as the library has it. A page's own HTTP CONNECT, forwarded by
 * the worker, is bounded too and its caller gets the error; it never passes
 * through `respondWith`, so it cannot be mistaken for a fetch's.
 *
 * WHAT IT CANNOT CLEAN UP. The data port the CONNECT carried has already been
 * transferred to the client; it is not this worker's to close. If the client
 * answers late, the answer is dropped here (the port that would carry it is
 * closed) and the library's end of the data channel, unreferenced once
 * `serve()` has settled, goes with the garbage. A ghost that wakes up and
 * starts serving on its end of it finds nobody there.
 *
 * COUPLED TO THE LIBRARY'S INTERNALS -- re-run the browser test
 * (`scripts/browser-test.mjs`) on ANY `@statewalker/webrun-http-browser` bump.
 * This relies on: the relay reaching clients only through `scope.clients.get`;
 * `callChannel`'s wire, `postMessage({ type: "CONNECT", params }, [replyPort,
 * ...])`, with `params.type === "http"` for a fetch and a reply of
 * `{ result }` or `{ error: { message } }`; `serve()` registering its fetch
 * listener on the scope it was given and answering with `event.respondWith`;
 * and its catch putting the error's `message` in a JSON body with status 500.
 * All of that holds in 0.7.1 and in 0.12.5.
 *
 * THE CHANGE THAT WOULD RETIRE THIS MODULE belongs in webrun-wire's
 * `startRelayServiceWorker`: a `connectTimeout` option that bounds
 * `serve()`'s CONNECT (and the forwarded one) and fails it as an `HttpError`
 * 504, closing the data channel's port and the reply port and dropping a late
 * reply. The shell would then pass the option, keep `connectTimeoutResponse`
 * for the page, and delete this file.
 */

import { isRelayEnvelope } from "./errors.js";

/** The bound, as the hand-rolled worker had it. */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * The error a timed-out CONNECT answers with. It is also how a 500 envelope
 * is recognised as a timeout, so it names the shell and the condition in
 * words no app's error would carry by accident.
 */
export function connectTimeoutMessage(ms: number): string {
  return `httpeers session shell: CONNECT not answered by the session's app within ${ms} ms`;
}

/** What the library posts a client: `callChannel`'s wire. */
interface ChannelCall {
  type?: unknown;
  params?: { type?: unknown } | null;
}

type TransferArg = Transferable[] | { transfer?: Transferable[] } | undefined;

/** The part of a ServiceWorker `Client` this module touches. */
interface ClientLike {
  postMessage(message: unknown, transfer?: TransferArg): void;
}

/** The part of a ServiceWorker scope this module touches. */
interface ScopeLike {
  clients: { get(id: string): Promise<unknown> };
  addEventListener(type: string, listener: never, options?: never): void;
  removeEventListener(type: string, listener: never, options?: never): void;
}

/** The part of a FetchEvent this module touches. */
interface FetchEventLike {
  request: Request;
  respondWith(response: Response | PromiseLike<Response>): void;
}

export interface ConnectDeadlineOptions {
  /** Default `CONNECT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** How long a 500 envelope's body may take to read. Default `ENVELOPE_READ_MS`. */
  envelopeReadMs?: number;
  /**
   * The answer to a request whose relay answer is a 500 envelope: `timedOut`
   * says whether its CONNECT was the one that timed out. Every other answer
   * reaches the browser as the library made it.
   */
  finish(response: Response, request: Request, timedOut: boolean): Response;
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

/**
 * The transfer list, in either form `postMessage` takes. Both library
 * versions pass the array; the options form is accepted so a library that
 * switches to it is still bounded rather than silently not.
 */
function transferOf(arg: TransferArg): Transferable[] | undefined {
  return Array.isArray(arg) ? arg : arg?.transfer;
}

/**
 * The most of a 500 envelope's body that is read, and for how long. The
 * relay's own envelope is a few hundred bytes built in memory, so it reads at
 * once; an app's JSON 500 can be anything, of any length, ending whenever it
 * likes, and must not be held back until it ends -- or forever, if it never
 * does. Past either limit the body is not the timeout's, and the original
 * goes on to the browser untouched.
 */
const ENVELOPE_READ_LIMIT = 8 * 1024;
export const ENVELOPE_READ_MS = 250;

/** The body as text, or `undefined` past `ENVELOPE_READ_LIMIT`. */
async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ENVELOPE_READ_LIMIT) return undefined;
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The envelope's message, read from a clone -- the original body is the
 * browser's -- and only if the body ends within `ENVELOPE_READ_LIMIT` bytes
 * and `readMs`. Either way the clone is cancelled once this is decided, so
 * the tee stops keeping a copy for it.
 */
async function envelopeMessage(response: Response, readMs: number): Promise<unknown> {
  const reader = response.clone().body?.getReader();
  if (reader == null) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      // A read the timer beat is cancelled below; its outcome is nobody's.
      readCapped(reader).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), readMs);
      }),
    ]);
    if (text == null) return undefined;
    return (JSON.parse(text) as { message?: unknown } | null)?.message;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function boundConnects<S extends ScopeLike>(scope: S, options: ConnectDeadlineOptions): S {
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const message = connectTimeoutMessage(timeoutMs);
  const readMs = options.envelopeReadMs ?? ENVELOPE_READ_MS;

  function postBounded(client: ClientLike, call: ChannelCall, transfer: Transferable[]): void {
    const [reply, ...rest] = transfer;
    if (!isPort(reply)) {
      client.postMessage(call, transfer);
      return;
    }
    const watch = new MessageChannel();
    try {
      client.postMessage(call, [watch.port2, ...rest]);
    } catch (error) {
      // Nothing was sent, so nothing will answer: leave the library's reply
      // port to the library, which sees this throw from its own call.
      watch.port1.close();
      watch.port2.close();
      throw error;
    }
    const timer = setTimeout(() => {
      // The client's answer, should it come now, has nowhere to go.
      watch.port1.close();
      reply.postMessage({ error: { message } });
      reply.close();
    }, timeoutMs);
    watch.port1.onmessage = (event) => {
      clearTimeout(timer);
      watch.port1.close();
      reply.postMessage(event.data, [...event.ports]);
      reply.close();
    };
  }

  function boundClient(client: ClientLike & object): ClientLike {
    return view(client, {
      postMessage(data: unknown, arg?: TransferArg) {
        const call = data as ChannelCall | null;
        const transfer = transferOf(arg);
        if (call?.type === "CONNECT" && call.params?.type === "http" && transfer?.length) {
          postBounded(client, call, transfer);
        } else {
          client.postMessage(data, arg);
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

  async function settle(response: Response, request: Request): Promise<Response> {
    // A NETWORK RESPONSE IS NOBODY'S TO FINISH. Before the library has read
    // its routes back it answers a request that turns out to be nobody's with
    // `fetch(request)`; that answer has a network type, while everything the
    // relay itself builds -- its envelope and the app's answers -- is "default".
    if (response.type !== "default") return response;
    if (response.status !== 500 || !isRelayEnvelope(response)) return response;
    const timedOut = (await envelopeMessage(response, readMs)) === message;
    return options.finish(response, request, timedOut);
  }

  /** The library's fetch listeners, by what it registered -- so its removal finds ours. */
  const fetchListeners = new WeakMap<object, (event: FetchEventLike) => void>();

  function fetchListenerFor(listener: (event: FetchEventLike) => void) {
    let wrapped = fetchListeners.get(listener);
    if (wrapped == null) {
      wrapped = (event) => {
        const respondWith = (answer: Response | PromiseLike<Response>) =>
          event.respondWith(Promise.resolve(answer).then((r) => settle(r, event.request)));
        listener(view(event as FetchEventLike & object, { respondWith }));
      };
      fetchListeners.set(listener, wrapped);
    }
    return wrapped;
  }

  const target = scope as unknown as {
    addEventListener(type: string, listener: unknown, options?: unknown): void;
    removeEventListener(type: string, listener: unknown, options?: unknown): void;
  };

  return view(scope, {
    clients,
    addEventListener(type: string, listener: unknown, opts?: unknown) {
      if (type === "fetch" && typeof listener === "function") {
        target.addEventListener(type, fetchListenerFor(listener as never), opts);
      } else {
        target.addEventListener(type, listener, opts);
      }
    },
    removeEventListener(type: string, listener: unknown, opts?: unknown) {
      const wrapped =
        type === "fetch" && typeof listener === "function"
          ? fetchListeners.get(listener)
          : undefined;
      target.removeEventListener(type, wrapped ?? listener, opts);
    },
  });
}

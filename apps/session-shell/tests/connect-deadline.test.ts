import { afterEach, describe, expect, it } from "vitest";
import { boundConnects, connectTimeoutMessage } from "../src/connect-deadline.js";
import { connectTimeoutResponse, sessionErrorPage } from "../src/errors.js";

type Transfer = Transferable[] | { transfer?: Transferable[] } | undefined;

interface Posted {
  message: { type: string; params?: unknown };
  transfer: Transferable[];
}

/** A registered client that records what it is posted and answers only when told. */
function fakeClient(options: { throws?: boolean } = {}) {
  const posted: Posted[] = [];
  return {
    id: "client-1",
    url: "https://abc.p.httpeers.net/relay.html",
    posted,
    postMessage(message: { type: string; params?: unknown }, arg?: Transfer) {
      if (options.throws) throw new Error("client is gone");
      posted.push({ message, transfer: (Array.isArray(arg) ? arg : arg?.transfer) ?? [] });
    },
  };
}

interface FakeFetchEvent {
  request: Request;
  respondWith(answer: Response | PromiseLike<Response>): void;
}

/** A scope with just enough of a ServiceWorker's: clients, and fetch listeners to dispatch to. */
function fakeScope(client: ReturnType<typeof fakeClient>) {
  const listeners = new Set<(event: FakeFetchEvent) => void>();
  return {
    location: { origin: "https://abc.p.httpeers.net" },
    clients: {
      async get(id: string) {
        return id === client.id ? client : undefined;
      },
    },
    addEventListener(_type: string, listener: (event: FakeFetchEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: (event: FakeFetchEvent) => void) {
      listeners.delete(listener);
    },
    listeners,
    /** What the browser would be given for `request`, or `undefined` if nobody answered. */
    dispatch(request: Request): Promise<Response> | undefined {
      let answer: Promise<Response> | undefined;
      const event: FakeFetchEvent = {
        request,
        respondWith: (r) => {
          answer = Promise.resolve(r);
        },
      };
      for (const listener of listeners) listener(event);
      return answer;
    },
  };
}

type Finished = { response: Response; timedOut: boolean };

function setup(timeoutMs: number, client = fakeClient()) {
  const raw = fakeScope(client);
  const finished: Finished[] = [];
  const scope = boundConnects(raw, {
    timeoutMs,
    finish: (response, request, timedOut) => {
      finished.push({ response, timedOut });
      return timedOut
        ? connectTimeoutResponse(request, connectTimeoutMessage(timeoutMs))
        : (sessionErrorPage(response, request) ?? response);
    },
  });
  return { raw, scope, client, finished };
}

/**
 * The library's side of a CONNECT, as `callChannel` does it: a reply channel
 * whose far end goes first in the transfer list, and a promise for the answer.
 */
function call(
  client: { postMessage(m: unknown, t?: Transfer): void },
  params: unknown,
  form: "array" | "options" = "array",
) {
  const reply = new MessageChannel();
  const data = new MessageChannel();
  opened.push(reply.port1, data.port1);
  const answer = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
    reply.port1.onmessage = (event) => resolve(event.data);
  });
  const transfer = [reply.port2, data.port2];
  client.postMessage({ type: "CONNECT", params }, form === "array" ? transfer : { transfer });
  return { answer, reply, data };
}

/** The reply port the client was handed for its `index`th call. */
function replyPortOf(client: ReturnType<typeof fakeClient>, index = 0): MessagePort {
  const port = client.posted[index]?.transfer[0];
  if (port == null) throw new Error(`call ${index} carried no reply port`);
  return port as MessagePort;
}

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);
}

const HTTP = { type: "http", key: "app", wire: "x" };

/** `serve()`'s catch, byte for byte: the error's message in a JSON 500. */
function libraryEnvelope(message: string): Response {
  return new Response(
    JSON.stringify({ status: 500, statusText: "Bad Request", message, path: "/" }),
    { status: 500, statusText: "Bad Request", headers: { "Content-Type": "application/json" } },
  );
}

async function boundClientOf(scope: ReturnType<typeof setup>["scope"]) {
  const bound = await scope.clients.get("client-1");
  if (bound == null) throw new Error("no client");
  return bound;
}

describe("boundConnects: the CONNECT", () => {
  it("passes an answer in time on unchanged", async () => {
    const { scope, client } = setup(200);
    const { answer, data } = call(await boundClientOf(scope), HTTP);
    // The data port is the library's, passed through as is.
    expect(client.posted[0]?.transfer[1]).toBe(data.port2);
    replyPortOf(client).postMessage({ result: { wire: 2 } });
    expect(await settleWithin(answer, 1_000)).toEqual({ result: { wire: 2 } });
  });

  it("answers an unanswered HTTP CONNECT with the timeout's error at the bound", async () => {
    const { scope, client } = setup(100);
    const started = Date.now();
    const { answer } = call(await boundClientOf(scope), HTTP);
    expect(await settleWithin(answer, 2_000)).toEqual({
      error: { message: connectTimeoutMessage(100) },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    // A late answer goes nowhere -- and in particular does not throw.
    replyPortOf(client).postMessage({ result: true });
  });

  it("bounds a CONNECT whose transfer list comes in the options form", async () => {
    const { scope } = setup(50);
    const { answer } = call(await boundClientOf(scope), HTTP, "options");
    expect(await settleWithin(answer, 1_000)).toEqual({
      error: { message: connectTimeoutMessage(50) },
    });
  });

  it("leaves a socket's CONNECT, and every other message, as the library sent it", async () => {
    const { scope, client } = setup(30);
    const bound = await boundClientOf(scope);
    const ws = call(bound, { type: "ws", key: "app", url: "ws://x/" });
    // The client got the library's own reply port: nothing stands in front of it.
    expect(client.posted[0]?.transfer[0]).toBe(ws.reply.port2);
    expect(await settleWithin(ws.answer, 200)).toBe("pending");

    const reply = new MessageChannel();
    opened.push(reply.port1, reply.port2);
    bound.postMessage({ type: "REGISTER", params: {} }, [reply.port2]);
    expect(client.posted[1]?.transfer[0]).toBe(reply.port2);
    expect((bound as unknown as { url: string }).url).toBe(client.url);
    expect(await scope.clients.get("nobody")).toBeUndefined();
  });

  it("starts no timer for a CONNECT the client refused to take", async () => {
    const { scope } = setup(30, fakeClient({ throws: true }));
    const bound = await boundClientOf(scope);
    let pending: ReturnType<typeof call> | undefined;
    expect(() => {
      pending = call(bound, HTTP);
    }).toThrow("client is gone");
    // `call` threw before returning; its reply port is the last one opened.
    const reply = opened.at(-2) as MessagePort;
    const late = new Promise((resolve) => {
      reply.onmessage = (event) => resolve(event.data);
    });
    expect(pending).toBeUndefined();
    expect(await settleWithin(late, 200)).toBe("pending");
  });
});

describe("boundConnects: the answer", () => {
  const navigation = () =>
    new Request("https://abc.p.httpeers.net/", { headers: { accept: "text/html" } });
  const api = () =>
    new Request("https://abc.p.httpeers.net/api", { headers: { accept: "application/json" } });

  /** A library fetch listener that answers with `response`. */
  function serveWith(scope: ReturnType<typeof setup>["scope"], response: () => Response) {
    const listener = (event: FakeFetchEvent) => event.respondWith(Promise.resolve(response()));
    scope.addEventListener("fetch", listener as never);
    return listener;
  }

  it("turns the timed-out request's own envelope into a 504 page for a viewer", async () => {
    const { raw, scope, finished } = setup(100);
    serveWith(scope, () => libraryEnvelope(connectTimeoutMessage(100)));
    const response = await raw.dispatch(navigation());
    expect(finished.map((f) => f.timedOut)).toEqual([true]);
    expect(response?.status).toBe(504);
    expect(await response?.text()).toContain("The app did not answer");
  });

  it("and into a 504 envelope for a fetch() caller", async () => {
    const { raw, scope } = setup(100);
    serveWith(scope, () => libraryEnvelope(connectTimeoutMessage(100)));
    const response = await raw.dispatch(api());
    expect(response?.status).toBe(504);
    expect(await response?.json()).toMatchObject({ message: connectTimeoutMessage(100) });
  });

  it("leaves an app's own JSON 500 untouched", async () => {
    const { raw, scope, finished } = setup(100);
    const body = JSON.stringify({ message: "the database is down" });
    serveWith(
      scope,
      () => new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
    );
    const response = await raw.dispatch(api());
    expect(finished.map((f) => f.timedOut)).toEqual([false]);
    expect(response?.status).toBe(500);
    expect(response?.headers.get("x-httpeers-session")).toBeNull();
    expect(await response?.text()).toBe(body);
  });

  it("does not take another bound's message, or a long body, for a timeout", async () => {
    const { raw, scope, finished } = setup(100);
    let next = libraryEnvelope(connectTimeoutMessage(200));
    serveWith(scope, () => next);
    expect((await raw.dispatch(api()))?.status).toBe(500);
    next = libraryEnvelope(`${connectTimeoutMessage(100)}${" ".repeat(16 * 1024)}`);
    expect((await raw.dispatch(api()))?.status).toBe(500);
    expect(finished.map((f) => f.timedOut)).toEqual([false, false]);
  });

  it("passes an app's JSON 500 whose body never ends through promptly, body intact", async () => {
    const { raw, scope, finished } = setup(100);
    const encoder = new TextEncoder();
    serveWith(
      scope,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Starts like the relay's envelope, and never ends.
              controller.enqueue(encoder.encode('{"message":"still thinking'));
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const started = Date.now();
    const response = await settleWithin(raw.dispatch(api()) as Promise<Response>, 2_000);
    if (response === "pending") throw new Error("the answer was held back");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(response.status).toBe(500);
    expect(finished.map((f) => f.timedOut)).toEqual([false]);
    const reader = response.body?.getReader();
    const first = await settleWithin(reader?.read() ?? Promise.resolve(undefined), 1_000);
    if (first === "pending" || first == null || first.done) throw new Error("body not readable");
    expect(new TextDecoder().decode(first.value)).toBe('{"message":"still thinking');
    await reader?.cancel();
  });

  it("leaves a network response alone, whatever it looks like", async () => {
    const { raw, scope, finished } = setup(100);
    serveWith(scope, () => {
      const response = libraryEnvelope(connectTimeoutMessage(100));
      Object.defineProperty(response, "type", { value: "basic" });
      return response;
    });
    expect((await raw.dispatch(navigation()))?.status).toBe(500);
    expect(finished).toEqual([]);
  });

  it("passes every other answer through without finishing it", async () => {
    const { raw, scope, finished } = setup(100);
    serveWith(scope, () => new Response("hello", { status: 200 }));
    expect(await (await raw.dispatch(api()))?.text()).toBe("hello");
    expect(finished).toEqual([]);
  });

  it("removes the listener the library registered", async () => {
    const { raw, scope } = setup(100);
    const listener = serveWith(scope, () => new Response("hello"));
    expect(raw.listeners.size).toBe(1);
    scope.removeEventListener("fetch", listener as never);
    expect(raw.listeners.size).toBe(0);
    expect(raw.dispatch(api())).toBeUndefined();
  });
});

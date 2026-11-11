import { afterEach, describe, expect, it } from "vitest";
import { boundConnects, connectTimeoutMessage } from "../src/connect-deadline.js";
import { connectTimeoutResponse } from "../src/errors.js";

/**
 * The library's side of a CONNECT, as `callChannel` does it: a reply channel
 * whose far end goes first in the transfer list, and a promise for the answer.
 */
function call(client: { postMessage(m: unknown, t?: Transferable[]): void }, params: unknown) {
  const reply = new MessageChannel();
  const data = new MessageChannel();
  const answer = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
    reply.port1.onmessage = (event) => {
      reply.port1.close();
      resolve(event.data);
    };
  });
  client.postMessage({ type: "CONNECT", params }, [reply.port2, data.port2]);
  return { answer, data };
}

interface Posted {
  message: { type: string; params?: unknown };
  transfer: Transferable[];
}

/** A registered client that records what it is posted and answers only when told. */
function fakeClient() {
  const posted: Posted[] = [];
  return {
    id: "client-1",
    url: "https://abc.p.httpeers.net/relay.html",
    posted,
    postMessage(message: { type: string; params?: unknown }, transfer: Transferable[] = []) {
      posted.push({ message, transfer });
    },
  };
}

function fakeScope(client: ReturnType<typeof fakeClient>) {
  return {
    location: { origin: "https://abc.p.httpeers.net" },
    clients: {
      async get(id: string) {
        return id === client.id ? client : undefined;
      },
    },
  };
}

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

/** The reply port the client was handed for its `index`th call. */
function replyPortOf(client: ReturnType<typeof fakeClient>, index = 0): MessagePort {
  const port = client.posted[index]?.transfer[0];
  if (port == null) throw new Error(`call ${index} carried no reply port`);
  return port as MessagePort;
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);
}

describe("boundConnects", () => {
  it("passes an answer in time on unchanged, and leaves no token", async () => {
    const client = fakeClient();
    const connects = boundConnects(fakeScope(client), { timeoutMs: 200 });
    const bound = await connects.scope.clients.get("client-1");
    if (bound == null) throw new Error("no client");

    const { answer, data } = call(bound, { type: "http", key: "app" });
    opened.push(data.port1);
    const [posted] = client.posted;
    expect(posted?.message.type).toBe("CONNECT");
    // The data port is the library's, passed through as is.
    expect(posted?.transfer[1]).toBe(data.port2);
    replyPortOf(client).postMessage({ result: { wire: 2 } });

    expect(await settleWithin(answer, 1_000)).toEqual({ result: { wire: 2 } });
    // Past the bound: an answered CONNECT must not time out after the fact.
    await new Promise((r) => setTimeout(r, 300));
    expect(connects.takeTimeout()).toBe(false);
  });

  it("answers an unanswered CONNECT with an error at the bound, and leaves one token", async () => {
    const client = fakeClient();
    const connects = boundConnects(fakeScope(client), { timeoutMs: 100 });
    const bound = await connects.scope.clients.get("client-1");
    if (bound == null) throw new Error("no client");

    const started = Date.now();
    const { answer, data } = call(bound, { type: "http", key: "app" });
    opened.push(data.port1);

    const settled = await settleWithin(answer, 2_000);
    expect(settled).toEqual({ error: { message: connectTimeoutMessage(100) } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(connects.takeTimeout()).toBe(true);
    // One timeout, one token.
    expect(connects.takeTimeout()).toBe(false);

    // A late answer goes nowhere -- and in particular does not throw.
    replyPortOf(client).postMessage({ result: true });
  });

  it("lets a token lapse that nothing claimed", async () => {
    let clock = 0;
    const client = fakeClient();
    const connects = boundConnects(fakeScope(client), {
      timeoutMs: 20,
      tokenTtlMs: 1_000,
      now: () => clock,
    });
    const bound = await connects.scope.clients.get("client-1");
    if (bound == null) throw new Error("no client");
    const { answer, data } = call(bound, { type: "http", key: "app" });
    opened.push(data.port1);
    await answer;
    clock += 1_001;
    expect(connects.takeTimeout()).toBe(false);
  });

  it("leaves every other message, and every other client property, alone", async () => {
    const client = fakeClient();
    const connects = boundConnects(fakeScope(client), { timeoutMs: 50 });
    const bound = await connects.scope.clients.get("client-1");
    if (bound == null) throw new Error("no client");
    expect((bound as unknown as { url: string }).url).toBe(client.url);

    const reply = new MessageChannel();
    opened.push(reply.port1, reply.port2);
    bound.postMessage({ type: "REGISTER", params: {} }, [reply.port2]);
    expect(client.posted[0]?.transfer[0]).toBe(reply.port2);
    expect(await connects.scope.clients.get("nobody")).toBeUndefined();
    // Nothing else on the scope is replaced.
    expect(connects.scope.location.origin).toBe("https://abc.p.httpeers.net");
  });
});

describe("connectTimeoutResponse", () => {
  it("is a 504 page for a viewer", async () => {
    const request = new Request("https://abc.p.httpeers.net/", {
      headers: { accept: "text/html" },
    });
    const response = connectTimeoutResponse(request, 15_000);
    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-httpeers-session")).toBe("shell");
    expect(await response.text()).toContain("The app did not answer");
  });

  it("is a 504 envelope for a fetch() caller", async () => {
    const request = new Request("https://abc.p.httpeers.net/api", {
      headers: { accept: "application/json" },
    });
    const response = connectTimeoutResponse(request, 15_000);
    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      status: 504,
      message: connectTimeoutMessage(15_000),
    });
  });
});

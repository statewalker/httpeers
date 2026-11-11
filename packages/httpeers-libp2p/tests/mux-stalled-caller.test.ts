/**
 * The mux path's serving side against a caller that withholds what only it
 * can send (#56): the answer to the window handshake (its first `credit`),
 * every later `credit`, the confirmation of the stream's last chunk, and its
 * close. It still reads the whole response. Without its handshake answer the
 * serving side never pipelines and an `end` is never agreed, so only the
 * caller's close could free the port: the serving side must close it itself,
 * `drainTimeoutMs` after the stream's end, or the port stays counted against
 * `maxInboundStreams` for as long as the mux lives.
 *
 * The caller is a real one; only the messages its outbound mux stream posts
 * are filtered, by wrapping `messageTargetOverStream`. Also here: honest
 * callers that read a finished response well after `drainTimeoutMs` still get
 * all of it, so the release above never cuts off a late reader.
 *
 * Loopback TCP, real Noise and yamux.
 */

import { tcp } from "@libp2p/tcp";
import type { FetchHandler, PeerIdStr } from "@statewalker/httpeers-core";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the caller's outbound mux stream drops, while `on`. */
const withhold = { on: false, credit: true, lastConfirmation: true, close: true };

vi.mock("@statewalker/webrun-streams-libp2p", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@statewalker/webrun-streams-libp2p");
  const { msgpackCodec } = await import("@statewalker/webrun-msgpack");
  type Envelope = {
    type?: string;
    payload?: {
      type?: string;
      channelName?: string;
      callId?: string;
      params?: { done?: boolean };
    };
  };
  const decode = (data: unknown): Envelope | undefined => {
    try {
      return msgpackCodec.decode?.(data as never) as Envelope;
    } catch {
      return undefined;
    }
  };
  return {
    ...real,
    messageTargetOverStream(...args: Parameters<typeof real.messageTargetOverStream>) {
      const made = real.messageTargetOverStream(...args);
      // Only the caller's side: the stream it opened.
      if (args[0].direction !== "outbound") return made;
      const target = made.target as unknown as {
        addEventListener(type: string, listener: (event: MessageEvent) => void): void;
        postMessage(message: unknown): void;
      };
      // The calls carrying the serving side's last chunk, whose confirmations are withheld.
      const lastChunkCalls = new Set<string>();
      const addEventListener = target.addEventListener.bind(target);
      target.addEventListener = (type, listener) =>
        addEventListener(type, (event) => {
          const payload = decode(event.data)?.payload;
          if (
            payload?.type === "request" &&
            payload.channelName === "out" &&
            payload.params?.done === true &&
            payload.callId != null
          )
            lastChunkCalls.add(payload.callId);
          listener(event);
        });
      const post = target.postMessage.bind(target);
      target.postMessage = (message) => {
        if (withhold.on) {
          const envelope = decode(message);
          if (withhold.credit && envelope?.type === "credit") return;
          if (withhold.close && envelope?.type === "close") return;
          if (
            withhold.lastConfirmation &&
            envelope?.type === "message" &&
            envelope.payload?.callId != null &&
            lastChunkCalls.has(envelope.payload.callId)
          )
            return;
        }
        post(message);
      };
      return made;
    },
  };
});

const { generateKey } = await import("../src/identity.js");
const { createNode, createRemote, serveTransport } = await import("../src/transport.js");

const DRAIN_TIMEOUT_MS = 300;
const started: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  Object.assign(withhold, { on: false, credit: true, lastConfirmation: true, close: true });
  while (started.length > 0)
    await started
      .pop()?.()
      .catch(() => {});
});

async function node(listen: string[] = []) {
  const created = await createNode({
    privateKey: await generateKey(),
    listen,
    transports: [tcp() as never],
  });
  started.push(async () => await created.stop());
  return created;
}

async function pair(dispatch: FetchHandler, maxInboundStreams?: number) {
  const serverNode = await node(["/ip4/127.0.0.1/tcp/0"]);
  const clientNode = await node();
  const stop = await serveTransport({
    node: serverNode,
    dispatch,
    muxPerPeer: true,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    ...(maxInboundStreams == null ? {} : { maxInboundStreams }),
  });
  started.push(stop);
  await clientNode.dial(serverNode.getMultiaddrs()[0]);
  return {
    remote: createRemote({ node: clientNode, muxPerPeer: true }),
    target: serverNode.peerId.toString() as PeerIdStr,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a caller that withholds its handshake answer (mux per peer)", () => {
  for (const [name, lastConfirmation] of [
    ["its credit, the last chunk's confirmation and its close", true],
    ["its credit and its close, though it confirms the last chunk", false],
  ] as const) {
    it(`withholding ${name}: the port is closed after drainTimeoutMs and its slot freed`, async () => {
      const { remote, target } = await pair(async () => new Response("x"), 1);
      Object.assign(withhold, { on: true, lastConfirmation });
      const first = await remote(target, new Request("http://peer.local/a"));
      // It reads the whole response.
      expect(await first.text()).toBe("x");
      await sleep(DRAIN_TIMEOUT_MS * 5);
      withhold.on = false;
      // Under a cap of one, an honest call is served: the port was released.
      const next = await remote(target, new Request("http://peer.local/b"));
      expect(await next.text()).toBe("x");
    }, 30_000);
  }
});

describe("an honest caller that reads a finished response late is not cut off (mux per peer)", () => {
  for (const [name, body] of [
    ["a small response", new TextEncoder().encode("small")],
    ["a 64 KiB response (several pieces, within the window)", new Uint8Array(64 * 1024).fill(3)],
  ] as const) {
    it(`${name}, read 4x drainTimeoutMs after its head`, async () => {
      const { remote, target } = await pair(async () => new Response(body));
      for (let i = 0; i < 3; i++) {
        const response = await remote(target, new Request("http://peer.local/x"));
        await sleep(DRAIN_TIMEOUT_MS * 4);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
      }
    }, 30_000);
  }
});

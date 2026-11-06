/**
 * Every call over a link gives its channel back, however the exchange ends.
 *
 * The bridge opens one duplex per call (`link.open`) and closes it only when a
 * call fails; on success "the stream ends itself when the body does". That
 * holds only if the HTTP layer ends the call once the exchange is over: a
 * response body read to its end used to leave it open (webrun-http-streams
 * < 0.3.1), so every successful call kept its channel — a MessagePort pair
 * here, a libp2p stream over libp2p — for as long as the peer lived.
 *
 * `pairedLinks` takes the channel factory, so the test counts the caller's
 * ports opened and closed.
 */

import { createMounts, createPeerRouter, json } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { createRemoteOverLink, serveFetchOverLink } from "../src/index.js";
import { type ChannelFactory, type PortLike, pairedLinks } from "../src/ports.js";

const ALICE = `12D3KooW${"A".repeat(44)}`;
const BOB = `12D3KooW${"B".repeat(44)}`;

declare const MessageChannel: { new (): { port1: PortLike; port2: PortLike } };

/** A channel factory that counts the calling ends opened and closed. */
function countingChannels(): { channel: ChannelFactory; opened(): number; closed(): number } {
  let opened = 0;
  let closed = 0;
  const channel: ChannelFactory = () => {
    const { port1, port2 } = new MessageChannel();
    opened++;
    let done = false;
    const close = port1.close?.bind(port1);
    port1.close = () => {
      if (!done) {
        done = true;
        closed++;
      }
      close?.();
    };
    return { port1, port2 };
  };
  return { channel, opened: () => opened, closed: () => closed };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

function bob() {
  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response("hello"));
  mounts.provide("/json", async () => json({ ok: true }));
  mounts.provide("/empty", async () => new Response(null, { status: 204 }));
  mounts.provide("/missing", async () => new Response("nope", { status: 404 }));
  mounts.provide("/echo", async (req) => new Response(await req.text()));
  mounts.provide("/stream", async () => {
    let n = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 20) c.close();
          else c.enqueue(new Uint8Array(512));
        },
      }),
    );
  });
  mounts.provide("/boom", async () => {
    throw new Error("bob blew up");
  });
  return createPeerRouter({
    selfPeerId: BOB,
    mounts,
    remote: async () => new Response("no relaying", { status: 403 }),
  });
}

const CASES: Array<{
  name: string;
  request: () => Request;
  consume: (r: Response) => Promise<unknown>;
  /** The call rejects (the peer's error crosses as an exception). */
  rejects?: RegExp;
}> = [
  {
    name: "GET, the body read to its end",
    request: () => new Request("http://peer.local/hello"),
    consume: async (r) => expect(await r.text()).toBe("hello"),
  },
  {
    name: "GET, JSON",
    request: () => new Request("http://peer.local/json"),
    consume: async (r) => expect(await r.json()).toEqual({ ok: true }),
  },
  {
    name: "GET, a streamed body",
    request: () => new Request("http://peer.local/stream"),
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(20 * 512),
  },
  {
    name: "GET, the body cancelled",
    request: () => new Request("http://peer.local/stream"),
    consume: async (r) => r.body?.cancel(),
  },
  {
    name: "HEAD",
    request: () => new Request("http://peer.local/hello", { method: "HEAD" }),
    consume: async (r) => expect(r.status).toBe(200),
  },
  {
    name: "204",
    request: () => new Request("http://peer.local/empty"),
    consume: async (r) => expect(r.status).toBe(204),
  },
  {
    name: "404 with a body",
    request: () => new Request("http://peer.local/missing"),
    consume: async (r) => expect([r.status, await r.text()]).toEqual([404, "nope"]),
  },
  {
    name: "POST, echoed",
    request: () => new Request("http://peer.local/echo", { method: "POST", body: "payload" }),
    consume: async (r) => expect(await r.text()).toBe("payload"),
  },
  {
    name: "the peer's handler throws",
    request: () => new Request("http://peer.local/boom"),
    consume: async () => {},
    rejects: /bob blew up/,
  },
];

describe("every call over a link gives its channel back", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const counts = countingChannels();
      const [a, b] = pairedLinks(ALICE, BOB, { channel: counts.channel });
      const stop = await serveFetchOverLink({ link: b, dispatch: bob() });
      try {
        const fromA = createRemoteOverLink({ link: a });
        for (let i = 0; i < 25; i++) {
          const run = async () => c.consume(await fromA(BOB, c.request()));
          if (c.rejects) await expect(run()).rejects.toThrow(c.rejects);
          else await run();
          await settle();
          expect(counts.closed(), `channels still open after call ${i + 1}`).toBe(counts.opened());
        }
        expect(counts.opened()).toBe(25);
      } finally {
        await stop();
      }
    }, 30_000);
  }

  it("concurrent calls, all read to the end", async () => {
    const counts = countingChannels();
    const [a, b] = pairedLinks(ALICE, BOB, { channel: counts.channel });
    const stop = await serveFetchOverLink({ link: b, dispatch: bob() });
    try {
      const fromA = createRemoteOverLink({ link: a });
      const texts = await Promise.all(
        Array.from({ length: 20 }, () =>
          fromA(BOB, new Request("http://peer.local/hello")).then((r) => r.text()),
        ),
      );
      expect(texts.every((t) => t === "hello")).toBe(true);
      await settle();
      expect([counts.opened(), counts.closed()]).toEqual([20, 20]);
    } finally {
      await stop();
    }
  }, 30_000);
});

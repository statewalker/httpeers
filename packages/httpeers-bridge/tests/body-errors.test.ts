/**
 * Errors that end a response body after its head is in.
 *
 * The link here is `pairedLinks` with each call's duplex wrapped so the test can
 * cut it mid-body, the way a transport does when the peer dies: the next read
 * of the caller's duplex throws. `mapBodyError` decides what the reader sees;
 * `mapError` (pre-head failures) is never consulted for it, and the caller's own
 * abort still surfaces its reason.
 */

import { createMounts, createPeerRouter, type PeerIdStr } from "@statewalker/httpeers-core";
import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import {
  type CreateRemoteOverLinkInit,
  createRemoteOverLink,
  type PeerLink,
  serveFetchOverLink,
} from "../src/index.js";
import { pairedLinks } from "../src/ports.js";

const ALICE = `12D3KooW${"A".repeat(44)}` as PeerIdStr;
const BOB = `12D3KooW${"B".repeat(44)}` as PeerIdStr;

class CutError extends Error {
  constructor() {
    super("the stream ended before the call finished");
    this.name = "CutError";
  }
}

class MappedError extends Error {
  constructor(options: { cause: unknown }) {
    super("mapped", options);
    this.name = "MappedError";
  }
}

/** `link`, whose calls all end with a `CutError` once `cut()` is called. */
function cuttable(link: PeerLink): { link: PeerLink; cut(): void } {
  let fire!: () => void;
  const cutting = new Promise<never>((_, reject) => {
    fire = () => reject(new CutError());
  });
  cutting.catch(() => {});
  const wrap = (call: Duplex): Duplex =>
    async function* (input) {
      const inner = call(input);
      try {
        for (;;) {
          const next = await Promise.race([inner.next(), cutting]);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        void inner.return(undefined).catch(() => {});
      }
    };
  return {
    link: {
      serve: (handlerFor) => link.serve(handlerFor),
      async open(peerId) {
        const opened = await link.open(peerId);
        return { call: wrap(opened.call), close: () => opened.close() };
      },
    },
    cut: () => fire(),
  };
}

/** Bob: one chunk, then nothing until the call ends. */
function dripping() {
  const mounts = createMounts();
  mounts.provide("/drip", async () => {
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          if (sent) return await new Promise<void>(() => {});
          sent = true;
          c.enqueue(new Uint8Array(8));
        },
      }),
    );
  });
  return createPeerRouter({
    selfPeerId: BOB,
    mounts,
    remote: async () => new Response("no relaying", { status: 403 }),
  });
}

async function cutMidBody(
  options: Omit<CreateRemoteOverLinkInit, "link">,
  signal?: AbortSignal,
  beforeCut?: () => void,
): Promise<unknown> {
  const [a, b] = pairedLinks(ALICE, BOB);
  const wrapped = cuttable(a);
  const stop = await serveFetchOverLink({ link: b, dispatch: dripping() });
  try {
    const call = createRemoteOverLink({ link: wrapped.link, ...options });
    const res = await call(BOB, new Request("http://peer.local/drip", { signal }));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).value?.byteLength).toBe(8);
    const pending = reader.read();
    beforeCut?.();
    wrapped.cut();
    return await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    await stop();
  }
}

describe("an error that ends the body", () => {
  it("surfaces what mapBodyError returns", async () => {
    const seen: unknown[] = [];
    const failure = await cutMidBody({
      mapBodyError: (error, target) => {
        seen.push([error, target]);
        return new MappedError({ cause: error });
      },
    });
    expect(failure).toBeInstanceOf(MappedError);
    expect((failure as MappedError).cause).toBeInstanceOf(CutError);
    expect(seen).toHaveLength(1);
    expect((seen[0] as unknown[])[1]).toBe(BOB);
  });

  it("keeps the original when mapBodyError returns undefined", async () => {
    const failure = await cutMidBody({ mapBodyError: () => undefined });
    expect(failure).toBeInstanceOf(CutError);
  });

  it("is not given to mapError, which covers pre-head failures only", async () => {
    let called = 0;
    const failure = await cutMidBody({
      mapError: (error) => {
        called++;
        return new MappedError({ cause: error });
      },
    });
    expect(failure).toBeInstanceOf(CutError);
    expect(called).toBe(0);
  });

  it("the caller's own abort still surfaces its reason, unmapped", async () => {
    const controller = new AbortController();
    const reason = new Error("gave up");
    let called = 0;
    const failure = await cutMidBody(
      {
        mapBodyError: (error) => {
          called++;
          return new MappedError({ cause: error });
        },
      },
      controller.signal,
      () => controller.abort(reason),
    );
    expect(failure).toBe(reason);
    expect(called).toBe(0);
  });
});

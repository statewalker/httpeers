/**
 * `extensionPlatform`: a platform with no edge, woken by the broker
 * (statewalker/httpeers#163).
 */

import { describe, expect, it } from "vitest";
import {
  extensionPlatform,
  type RuntimeMessages,
  runtimeMessageWake,
  WAKE_MESSAGE_TYPE,
} from "../src/extension.js";

function fakeRuntime() {
  const listeners = new Set<(message: unknown) => unknown>();
  const runtime: RuntimeMessages = {
    onMessage: {
      addListener: (l) => listeners.add(l),
      removeListener: (l) => listeners.delete(l),
    },
  };
  const send = (message: unknown): unknown[] => [...listeners].map((l) => l(message));
  return { runtime, send, listeners };
}

describe("extensionPlatform", () => {
  it("mounts no edge", () => {
    const platform = extensionPlatform({ pageWake: false });
    expect(platform.mountEdge).toBeUndefined();
    expect(typeof platform.createNode).toBe("function");
  });

  it("wakes on the broker's wake message only, and unsubscribes", () => {
    const { runtime, send, listeners } = fakeRuntime();
    const platform = extensionPlatform({ wake: runtimeMessageWake(runtime), pageWake: false });
    let wakes = 0;
    const stop = platform.watchWake?.(() => wakes++);
    send({ type: WAKE_MESSAGE_TYPE });
    send({ type: "something-else" });
    send("httpeers:wake");
    send(null);
    expect(wakes).toBe(1);
    // it answers nothing, so another listener's reply is not taken over
    expect(send({ type: WAKE_MESSAGE_TYPE })).toEqual([undefined]);
    expect(wakes).toBe(2);
    stop?.();
    expect(listeners.size).toBe(0);
    send({ type: WAKE_MESSAGE_TYPE });
    expect(wakes).toBe(2);
  });

  it("takes a custom message type", () => {
    const { runtime, send } = fakeRuntime();
    let wakes = 0;
    const stop = runtimeMessageWake(runtime, "mesh:wake")(() => wakes++);
    send({ type: WAKE_MESSAGE_TYPE });
    send({ type: "mesh:wake" });
    expect(wakes).toBe(1);
    stop();
  });

  it("without a document, does not watch page events by default", () => {
    // vitest runs in Node: no `document`, so watchPageWake (which would throw
    // on the missing `window`) is not called.
    const platform = extensionPlatform();
    const stop = platform.watchWake?.(() => {});
    expect(() => stop?.()).not.toThrow();
  });
});

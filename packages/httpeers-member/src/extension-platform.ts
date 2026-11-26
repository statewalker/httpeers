/**
 * A `MemberPlatform` for a browser runtime that has WebRTC but no edge of its
 * own: a Chrome MV3 extension's offscreen document, above all.
 *
 * An extension cannot register a second ServiceWorker, so `mountEdge` is not
 * an option there; the extension's own service worker is the edge, and
 * forwards to `MemberHandle.fetch`. So this platform builds the node with
 * `createBrowserNode` and mounts nothing. What wakes the supervisor is the
 * broker: a message from the service worker (`runtimeMessageWake`), plus the
 * document's own `online` events when there is a document.
 *
 * NOTHING HERE REACHES `@statewalker/webrun-http-browser`, which is what lets an
 * offscreen bundle build without it (`tests/boundary.test.ts`).
 */

import type { Ed25519PrivateKey } from "@libp2p/interface";
import type { IceServer } from "@statewalker/httpeers-libp2p";
import { createBrowserNode } from "./browser-profile.js";
import { watchPageWake } from "./page-wake.js";
import type { MemberPlatform } from "./start-member.js";

export interface ExtensionPlatformInit {
  /** Relax libp2p's dial gater for loopback and private addresses. Off in production. */
  dev?: boolean;
  /** WebRTC's STUN/TURN servers; unset keeps `@libp2p/webrtc`'s default. */
  iceServers?: readonly IceServer[];
  /**
   * Subscribe to the broker's wake signals; returns the unsubscribe. Typically
   * `runtimeMessageWake(chrome.runtime)`. Omitted, only the document's own
   * events wake the supervisor.
   */
  wake?: (onWake: () => void) => () => void;
  /**
   * Also wake on the document's `online`, `pageshow`, `resume` and
   * `visibilitychange` events (`watchPageWake`). Default: true when the
   * runtime has a `document` (an offscreen document does; a service worker
   * does not).
   */
  pageWake?: boolean;
}

declare const document: unknown;

export function extensionPlatform(init: ExtensionPlatformInit = {}): MemberPlatform {
  const pageWake = init.pageWake ?? typeof document !== "undefined";
  return {
    createNode: async ({ privateKey }: { privateKey: Ed25519PrivateKey }) =>
      createBrowserNode({
        privateKey,
        dev: init.dev ?? false,
        ...(init.iceServers != null ? { iceServers: init.iceServers } : {}),
      }),
    // No `mountEdge`: the extension's service worker is the edge.
    watchWake: (onWake) => {
      const stops: Array<() => void> = [];
      if (init.wake != null) stops.push(init.wake(onWake));
      if (pageWake) stops.push(watchPageWake(onWake));
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** The part of `chrome.runtime` `runtimeMessageWake` reads, typed locally. */
export interface RuntimeMessages {
  onMessage: {
    addListener(listener: (message: unknown) => unknown): void;
    removeListener(listener: (message: unknown) => unknown): void;
  };
}

/** The message a broker sends to wake members: `{ type: "httpeers:wake" }` by default. */
export const WAKE_MESSAGE_TYPE = "httpeers:wake";

/**
 * Wake on `{ type }` messages from `runtime` (`chrome.runtime` in an offscreen
 * document): the broker's service worker sends one when it starts, or when it
 * sees the network come back. Other messages are left alone, and nothing is
 * answered, so other listeners keep their replies.
 */
export function runtimeMessageWake(
  runtime: RuntimeMessages,
  type: string = WAKE_MESSAGE_TYPE,
): (onWake: () => void) => () => void {
  return (onWake) => {
    const listener = (message: unknown): undefined => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === type
      ) {
        onWake();
      }
      return undefined;
    };
    runtime.onMessage.addListener(listener);
    return () => runtime.onMessage.removeListener(listener);
  };
}

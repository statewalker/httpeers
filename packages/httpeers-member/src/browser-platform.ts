/**
 * The three things a page does differently, as one `MemberPlatform`.
 *
 * THIS IS WHAT THE EXTRACTION IS FOR. The prototype had two lifecycles —
 * `startBrowserPeer` (644 lines) and a Node equivalent — that agreed on every
 * step and diverged on three: how a node is built, whether an edge is mounted,
 * and whether the process gets wake events. Rung 01 replaced both with
 * `startMember` plus an injected platform, and porting `peer-runtime.ts` here
 * would have brought the duplication back through the front door.
 *
 * So there is no browser peer runtime in this package. There is one lifecycle
 * and this object.
 */

import type { Ed25519PrivateKey } from "@libp2p/interface";
import { createBrowserNode } from "./browser-profile.js";
import { mountEdge } from "./edge.js";
import { watchPageWake } from "./page-wake.js";
import type { MemberPlatform } from "./start-member.js";

export interface BrowserPlatformInit {
  /**
   * Where the ServiceWorker script lives. Omitting it is not an option the
   * edge survives — see `mountEdge`.
   */
  serviceWorkerUrl?: string;
  /**
   * Relax libp2p's dial gater for loopback and private addresses.
   *
   * A page dialling `127.0.0.1` is a development setup, and the default gater
   * refuses it silently. Off in production, where refusing is right.
   */
  dev?: boolean;
}

export function browserPlatform(init: BrowserPlatformInit = {}): MemberPlatform {
  return {
    createNode: async ({ privateKey }: { privateKey: Ed25519PrivateKey }) =>
      createBrowserNode({ privateKey, dev: init.dev ?? false }),

    // A PAGE ONLY. `MemberHandle.fetch` is the edge on both platforms; what a
    // page additionally gets is a same-origin URL a plain `fetch()` reaches it
    // through, which is what `baseUrl` is and why it is optional on the handle.
    mountEdge: async ({ key, dispatch }) =>
      mountEdge({ key, dispatch, serviceWorkerUrl: init.serviceWorkerUrl }),

    // A PAGE ONLY. A Node process gets no wake events, so there the
    // supervisor's backstop timer is the whole story. A tab that was suspended
    // and is now visible again should re-check its hub link immediately rather
    // than wait out a backoff the user can feel.
    watchWake: (onWake) => watchPageWake(onWake),
  };
}

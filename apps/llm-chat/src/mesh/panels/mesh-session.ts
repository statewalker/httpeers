/**
 * The live mesh data `SharingPanel` and `KeysPanel` read.
 *
 * A REF, NOT A SUBSCRIPTION: `ChatApp.tsx`'s own `ConnectionPanel`/`ModelsPanel` already read
 * their live data the same way (`configRef.current`, re-read on every call of the panel's
 * `Component` closure) rather than through a store of their own. A panel re-renders because an
 * ancestor re-renders -- here, `mesh.tsx`'s own session-state polling -- not because it
 * subscribed to anything itself. `handle.current` is mutated in place on every `mesh.tsx` render;
 * the object identity stays stable across the page's lifetime.
 */

import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import type { LlmService } from "../discover.js";

export interface MeshSessionSnapshot {
  /** `mesh.tsx`'s own `admin` hint (`isMeshAdmin`, or `true`/`false` once a mint has settled). */
  admin: boolean;
  /** `null` before the session has started. */
  session: PeerSession | null;
  /** `null` before the first state arrives. */
  state: SessionState | null;
  /** The discovered LLM service; `null` outside the "chat" stage the Keys panel only matters in. */
  service: LlmService | null;
  /** The page the Keys panel's minted-key message links back to. */
  pageUrl: string;
}

export interface MeshSessionHandle {
  current: MeshSessionSnapshot;
  /** Wrapped, never bare: `window.fetch` called unbound throws "Illegal invocation". */
  fetchImpl: typeof fetch;
}

/** A fresh handle, empty until `mesh.tsx` starts writing `current` on its own renders. */
export function createMeshSessionHandle(fetchImpl: typeof fetch): MeshSessionHandle {
  return {
    current: { admin: false, session: null, state: null, service: null, pageUrl: "" },
    fetchImpl,
  };
}

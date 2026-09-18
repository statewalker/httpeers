/**
 * The mesh session for `mesh.html`: a consumer member that serves nothing and calls the hub's LLM
 * service through this origin's ServiceWorker edge.
 *
 * MODELLED ON `apps/demos/src/app/main.ts`, and copied rather than imported: an app never imports
 * from another app. The edge key is `peers`, so every mesh URL is `/peers/<peerId>/…` and
 * `handle.baseUrl` ends with `/peers/`.
 *
 * Biscuit needs nothing here: `httpeers-access` evaluates tokens and rules in pure TypeScript.
 */

import { ruleSet } from "@statewalker/httpeers-access";
import { createMounts } from "@statewalker/httpeers-core";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";

/** The mount-prefix first segment and the ServiceWorker adapter key. One per origin. */
export const EDGE_KEY = "peers";

/** Copied un-hashed into `public/` by `scripts/copy-assets.mjs`; the edge registers it by URL. */
export const SERVICE_WORKER_URL = "/sw.js";

export const DEFAULT_RELAY_DOC_URL = "https://relay.httpeers.net/.well-known/httpeers-relay.json";

/**
 * The relay's dialable addresses, from its published document (as `apps/demos/src/shared/relay.ts`).
 * Throws rather than returning empty.
 */
export async function readRelayAddrs(url = DEFAULT_RELAY_DOC_URL): Promise<string[]> {
  let doc: { relayAddrs?: unknown };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    doc = (await res.json()) as { relayAddrs?: unknown };
  } catch (cause) {
    throw new Error(`Could not read the relay's address from ${url}.`, { cause });
  }
  const addrs = doc.relayAddrs;
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error(`The relay document at ${url} carries no relayAddrs.`);
  }
  return addrs.filter((a): a is string => typeof a === "string" && a !== "");
}

/** A loopback or private relay address needs libp2p's permissive dial gater (development only). */
export function needsPermissiveGater(addrs: readonly string[]): boolean {
  return addrs.some(
    (addr) =>
      /\/ip4\/127\./.test(addr) ||
      /\/ip4\/10\./.test(addr) ||
      /\/ip4\/192\.168\./.test(addr) ||
      /\/dns4?\/localhost(\/|$)/.test(addr),
  );
}

/**
 * This page's own rules. It serves nothing, so these only name the mesh protocol's capabilities; the
 * LLM policy lives on the hub, which decides every `/llm/…` call.
 */
function pageRules() {
  return ruleSet({
    version: 1,
    rules: [
      'capability("std:mesh.read")      <- role("member");',
      'capability("std:presence.write") <- role("member");',
      'role("member")                   <- role("admin");',
    ],
    policies: [
      'allow if capability("std:mesh.read"), resource("/.well-known")' +
        ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
    ],
  });
}

export interface MeshSessionInit {
  onChange(state: SessionState): void;
  /** Relay document to read for the dial-gater decision; `?relayDoc=` overrides it in development. */
  relayDocUrl?: string;
}

export interface MeshSession {
  session: PeerSession;
  /** `session.start()`: resolves once the first resume or `?join=` attempt has settled. */
  started: Promise<void>;
}

/**
 * Create the session and start it. The join comes from `?join=` (read by the session at start) or
 * from `session.join(text)` with a pasted link or blob. The session is returned BEFORE the start
 * settles, so the page can already act on the states `onChange` reports while it runs.
 */
export async function startMeshSession(init: MeshSessionInit): Promise<MeshSession> {
  // The relay document only decides the dial gater; the join blob carries the relay the member
  // really dials. An unreadable document therefore does not stop the page: a failing relay shows
  // up as the join's own error, with the production gater.
  let dev = false;
  try {
    dev = needsPermissiveGater(await readRelayAddrs(init.relayDocUrl));
  } catch (error) {
    console.warn(error);
  }

  const session = createSession({
    key: EDGE_KEY,
    // A CONSUMER SERVES NOTHING. It still joins, heartbeats and appears in the mesh view.
    mounts: createMounts(),
    rules: pageRules(),
    dev,
    serviceWorkerUrl: SERVICE_WORKER_URL,
    onChange: init.onChange,
    // No `httpeers.json` on this origin: the mesh always comes from an invitation or memory.
    readDeploymentConfig: async () => null,
  });
  return { session, started: session.start() };
}

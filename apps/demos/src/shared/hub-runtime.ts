/**
 * A hub in a tab — composed from the packages, not provided by one.
 *
 * WHY THE PAGE PART IS APP CODE. `httpeers-hub` deliberately has no
 * transport, so the browser composition lives in httpeers-member
 * (`startBrowserHub`), without an edge, for hosts that have none (an
 * extension's offscreen document). What stays here is the page's own edge.
 *
 * `httpeers-conformance`'s `rung12_browserHub` compiles this arrangement as a
 * consumer, so if the packages ever stop being sufficient for it, a test says
 * so before this page breaks.
 *
 * TWO PIECES: `startBrowserHub` (`@statewalker/httpeers-member/browser-hub`:
 *   node, relay, reservation, hub and `servePeer`, no edge) and
 *   `createEdgeDispatch` (as `hubEdgeDispatch`) behind `mountEdge`.
 */

import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import type { RuleSet } from "@statewalker/httpeers-access";
import type { PeerIdStr } from "@statewalker/httpeers-core";
import type { Hub } from "@statewalker/httpeers-hub";
// The IndexedDB store is behind the hub's BROWSER entry, which is the whole
// point of that split: the root stays runnable where there is no IndexedDB.
import { idbStorage } from "@statewalker/httpeers-hub/browser";
import type { Peer } from "@statewalker/httpeers-libp2p";
import { mountEdge } from "@statewalker/httpeers-member/browser";
import { startBrowserHub } from "@statewalker/httpeers-member/browser-hub";
import { hubEdgeDispatch } from "./hub-edge.js";

/** Coarse lifecycle states the page renders progress against; ordered, each passed once. */
export type HubState =
  | "connecting-relay"
  | "awaiting-reservation"
  | "starting-hub"
  | "mounting-edge"
  | "ready"
  | "stopped";

export interface StartHubInit {
  key: string;
  /**
   * Services this hub serves itself, and the advertisements that make them
   * discoverable.
   *
   * The prototype HARD-MOUNTED a demo `/search` inside the hub's own
   * endpoints, which made the hub's package carry an application's service and
   * -- worse -- mounted it without advertising it, so it was served, gated and
   * INVISIBLE. `createHub` takes both halves as parameters now, and supplying
   * them together here is what keeps them in step.
   */
  extraMounts?: Record<string, (request: Request) => Promise<Response>>;
  ownAdvertisements?: Array<{ id: string; kind: string; title: string }>;
  /** This hub's signing key. Its peerId IS the mesh — see `signerOf`. */
  privateKey: Ed25519PrivateKey;
  relayAddrs: string[];
  rules: RuleSet;
  /** Relax libp2p's dial gater for a loopback relay. Decided from the ADDRESS, not the hostname. */
  dev?: boolean;
  onState?: (state: HubState) => void;
}

export interface HubHandle {
  /** This hub's peerId — and therefore the mesh's name. */
  peerId: PeerIdStr;
  relayAddr: string;
  /** The `/p2p-circuit/webrtc` address a joining page must be told. */
  circuitAddr: string;
  /**
   * Where this page's own `fetch()` reaches the mesh. A call to this hub
   * itself passes `asHub()` (`./hub-edge.ts`), or it is not the hub's.
   */
  baseUrl: string;
  hub: Hub;
  peer: Peer;
  node: Libp2p;
  roles(): string[];
  stop(): Promise<void>;
}

export async function startHub(init: StartHubInit): Promise<HubHandle> {
  const onState = init.onState ?? ((): void => {});

  // Node, relay, reservation, hub and `servePeer`, with no edge: the package's
  // assembly (httpeers#163). What this page adds is its own edge.
  const base = await startBrowserHub({
    privateKey: init.privateKey,
    relayAddrs: init.relayAddrs,
    rules: init.rules,
    // Survives a reload: members and spent invitation ids are the hub's
    // durable state, and a hub that forgot them on refresh would re-admit
    // every spent code.
    storage: idbStorage(),
    extraMounts: init.extraMounts,
    ownAdvertisements: init.ownAdvertisements,
    dev: init.dev ?? false,
    onState: (state) => {
      if (state !== "ready" && state !== "stopped") onState(state);
    },
  });

  try {
    onState("mounting-edge");
    // The hub mints a token FOR ITSELF: its own endpoints sit behind the same
    // guard as everyone else's, so a hub with no token could not read its own
    // mesh view through its own edge.
    const selfToken = await base.mintSelfToken(["admin"]);
    // `hubEdgeDispatch`, not a bare `createEdgeDispatch`: the self-token alone
    // fails its own peer binding on a local request (httpeers#165). Only the
    // page's own calls, made with `asHub`, are bound to the hub.
    const edge = await mountEdge({
      key: init.key,
      dispatch: hubEdgeDispatch({
        key: init.key,
        selfPeerId: base.peerId,
        dispatch: base.peer.dispatch,
        token: () => selfToken,
      }),
    });

    onState("ready");
    return {
      peerId: base.peerId,
      relayAddr: base.relayAddr,
      circuitAddr: base.circuitAddr,
      baseUrl: edge.baseUrl,
      hub: base.hub,
      peer: base.peer,
      node: base.node,
      // Read off the RULES, never a hard-coded list: a role added to the policy
      // appears in the UI with no second place to update.
      roles: () => base.roles(),
      async stop() {
        onState("stopped");
        await edge.stop().catch(() => {});
        await base.stop();
      },
    };
  } catch (error) {
    await base.stop();
    throw error;
  }
}

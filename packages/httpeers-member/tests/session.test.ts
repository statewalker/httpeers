/**
 * The session decides things, and deciding is what is worth testing.
 *
 * Every seam `createPeerSession` takes is injected here -- the member
 * lifecycle, the identity store, the mesh memory, the deployment config and
 * the reload -- so all of this runs under Node with no browser, no relay and
 * no ServiceWorker. That is the whole point of `session.ts` having no DOM in
 * it, and this file is the proof rather than the claim.
 *
 * THE RULE THIS FILE EXISTS TO PIN DOWN is the mesh-selection one: a join
 * blob names its own mesh, a BARE invitation id means the mesh the deployment
 * names, and only a pure resume consults the remembered mesh. Three tests,
 * one each, because getting it wrong silently points a Node-hub join at
 * whatever mesh the page last saw.
 */
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import type { Libp2p } from "@libp2p/interface";
import type { MeshConfig, Mounts } from "@statewalker/httpeers-core";
import { createMounts } from "@statewalker/httpeers-core";
import { type RuleSet, ruleSet } from "@statewalker/httpeers-access";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeJoinBlob } from "../src/join-blob.js";
import type { MeshMemory } from "../src/mesh-memory.js";
import {
  createPeerSession,
  type IdentityStore,
  type PeerSessionInit,
  type SessionState,
  type StartPeer,
} from "../src/session.js";
import { MemberJoinError, type MemberHandle, type MemberPlatform } from "../src/start-member.js";
import { peerIdOf } from "../src/identity.js";

const DEPLOYMENT: MeshConfig = {
  relayAddrs: ["/ip4/127.0.0.1/tcp/9090/ws/p2p/12D3KooWDeployRelay"],
  hubPeerId: "12D3KooWDeploymentHub",
};

const REMEMBERED: MeshConfig = {
  relayAddrs: ["/ip4/127.0.0.1/tcp/9091/ws/p2p/12D3KooWRememberedRelay"],
  hubPeerId: "12D3KooWRememberedHub",
};

const BLOB_MESH: MeshConfig = {
  relayAddrs: ["/ip4/127.0.0.1/tcp/9092/ws/p2p/12D3KooWBlobRelay"],
  hubPeerId: "12D3KooWBlobHub",
};

let KEY: Ed25519PrivateKey;
let PEER_ID: string;

beforeAll(async () => {
  KEY = await generateKeyPair("Ed25519");
  PEER_ID = peerIdOf(KEY);
});

/** An identity store over a variable, not a database. */
function fakeIdentity(initial: Ed25519PrivateKey | null): IdentityStore & { current(): Ed25519PrivateKey | null } {
  let key = initial;
  return {
    read: async () => key,
    loadOrCreate: async () => {
      key ??= KEY;
      return key;
    },
    clear: async () => {
      key = null;
    },
    current: () => key,
  };
}

function fakeMeshMemory(initial: MeshConfig | null): MeshMemory & { current(): MeshConfig | null } {
  let mesh = initial;
  return {
    read: async () => mesh,
    write: async (config) => {
      mesh = config;
    },
    clear: async () => {
      mesh = null;
    },
    current: () => mesh,
  };
}

/** The node is never touched by the session, so a marker object is honest. */
const FAKE_NODE = { marker: "not a real libp2p node" } as unknown as Libp2p;

function fakeHandle(config: MeshConfig, joinedBy: "resumed" | "redeemed"): MemberHandle {
  return {
    peerId: PEER_ID,
    hubPeerId: config.hubPeerId,
    relayAddr: config.relayAddrs[0] as string,
    joinedBy,
    fetch: async () => new Response("ok"),
    meshView: () => null,
    token: () => "TOKEN",
    connectionKind: () => "none",
    node: FAKE_NODE,
    stop: async () => {},
  };
}

interface Harness {
  session: ReturnType<typeof createPeerSession>;
  states: SessionState[];
  calls: Array<Parameters<StartPeer>[0]>;
  identity: ReturnType<typeof fakeIdentity>;
  meshMemory: ReturnType<typeof fakeMeshMemory>;
  reloads: () => number;
}

interface HarnessInit {
  savedKey?: Ed25519PrivateKey | null;
  remembered?: MeshConfig | null;
  deployment?: MeshConfig | null;
  search?: string;
  /** What the injected `startPeer` does. Default: resume into whatever mesh it was given. */
  startPeer?: StartPeer;
  mounts?: Mounts;
  rules?: RuleSet;
}

function harness(init: HarnessInit = {}): Harness {
  const states: SessionState[] = [];
  const calls: Array<Parameters<StartPeer>[0]> = [];
  const identity = fakeIdentity(init.savedKey === undefined ? null : init.savedKey);
  const meshMemory = fakeMeshMemory(init.remembered ?? null);
  let reloads = 0;

  const startPeer: StartPeer = async (peerInit) => {
    calls.push(peerInit);
    if (init.startPeer != null) return init.startPeer(peerInit);
    return fakeHandle(peerInit.config, peerInit.invitationId == null ? "resumed" : "redeemed");
  };

  const sessionInit: PeerSessionInit = {
    key: "peers",
    mounts: init.mounts ?? createMounts(),
    rules:
      init.rules ??
      ruleSet({ version: 1, rules: [], policies: ['allow if resource("/hello");'] }),
    platform: { createNode: async () => FAKE_NODE } satisfies MemberPlatform,
    search: init.search ?? "",
    onChange: (state) => states.push(state),
    identity,
    meshMemory,
    reload: () => {
      reloads += 1;
    },
    startPeer,
    readDeploymentConfig: async () => init.deployment ?? null,
  };

  return {
    session: createPeerSession(sessionInit),
    states,
    calls,
    identity,
    meshMemory,
    reloads: () => reloads,
  };
}

describe("createPeerSession -- the first run", () => {
  it("says 'no saved identity' rather than generating one", async () => {
    const h = harness({ deployment: DEPLOYMENT });
    await h.session.start();

    const state = h.session.state();
    expect(state.phase.kind).toBe("needs-invitation");
    expect(state.phase.kind === "needs-invitation" && state.phase.reason).toBe("no-identity");
    // NOTHING WAS GENERATED. A key created here would make every later load
    // report an identity this browser has never used for anything.
    expect(h.identity.current()).toBeNull();
    expect(state.identity).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(state.controls.join).toBe(true);
  });
});

describe("createPeerSession -- which mesh is tried", () => {
  it("a pure resume uses the REMEMBERED mesh, not the deployment's", async () => {
    const h = harness({ savedKey: KEY, remembered: REMEMBERED, deployment: DEPLOYMENT });
    await h.session.start();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.config).toEqual(REMEMBERED);
    expect(h.calls[0]?.invitationId).toBeUndefined();
    expect(h.session.state().phase.kind).toBe("live");
  });

  it("a BARE invitation id uses the DEPLOYMENT's mesh, even with one remembered", async () => {
    // The contract `join-blob.ts` states: a bare id means "the mesh
    // httpeers.json names". Consulting the memory here would silently point
    // a Node-hub join at whatever mesh this page last saw.
    const h = harness({ savedKey: KEY, remembered: REMEMBERED, deployment: DEPLOYMENT });
    await h.session.join("inv-1234567890");

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.config).toEqual(DEPLOYMENT);
    expect(h.calls[0]?.invitationId).toBe("inv-1234567890");
  });

  it("a join blob names its OWN mesh, overriding both", async () => {
    const blob = encodeJoinBlob({
      invitationId: "inv-from-blob",
      relayAddrs: BLOB_MESH.relayAddrs,
      hubPeerId: BLOB_MESH.hubPeerId,
    });
    const h = harness({ savedKey: KEY, remembered: REMEMBERED, deployment: DEPLOYMENT });
    await h.session.join(blob);

    expect(h.calls[0]?.config).toEqual(BLOB_MESH);
    expect(h.calls[0]?.invitationId).toBe("inv-from-blob");
  });

  it("refuses with 'no-mesh' when nothing names a mesh at all", async () => {
    const h = harness({ savedKey: KEY, remembered: null, deployment: null });
    await h.session.start();

    const phase = h.session.state().phase;
    expect(phase.kind).toBe("needs-invitation");
    expect(phase.kind === "needs-invitation" && phase.reason).toBe("no-mesh");
    // The lifecycle was never entered: `startMember` requires a config and
    // there was none to give it.
    expect(h.calls).toHaveLength(0);
  });
});

describe("createPeerSession -- what it reports while starting", () => {
  it("reports 'loading-config' before the member lifecycle has any state of its own", async () => {
    const h = harness({ savedKey: KEY, remembered: REMEMBERED });
    await h.session.start();

    const starting = h.states
      .filter((s) => s.phase.kind === "starting")
      .map((s) => (s.phase.kind === "starting" ? s.phase.peerState : null));
    expect(starting[0]).toBe("loading-config");
  });

  it("forwards the member's own states, and ignores late ones after a stop", async () => {
    let leak: ((state: "ready") => void) | null = null;
    const h = harness({
      savedKey: KEY,
      remembered: REMEMBERED,
      startPeer: async (peerInit) => {
        peerInit.onState?.("dialing-hub");
        leak = (state) => peerInit.onState?.(state);
        return fakeHandle(peerInit.config, "resumed");
      },
    });
    await h.session.start();

    const starting = h.states
      .filter((s) => s.phase.kind === "starting")
      .map((s) => (s.phase.kind === "starting" ? s.phase.peerState : null));
    expect(starting).toEqual(["loading-config", "dialing-hub"]);

    // A callback arriving after the session has left `starting` must not
    // repaint the page -- a disconnect that redrew itself as "starting"
    // would be a lie.
    const before = h.states.length;
    (leak as unknown as (s: "ready") => void)("ready");
    expect(h.states).toHaveLength(before);
  });
});

describe("createPeerSession -- refusals", () => {
  it("a duplicate identity is 'blocked', not 'failed'", async () => {
    const h = harness({
      savedKey: KEY,
      remembered: REMEMBERED,
      startPeer: async () => {
        throw new MemberJoinError("duplicate-identity", "Another tab holds this identity.");
      },
    });
    await h.session.start();

    const state = h.session.state();
    expect(state.phase.kind).toBe("blocked");
    // Not a fault to retry, so the invitation field is closed and only the
    // reset control remains.
    expect(state.controls).toEqual({ join: false, disconnect: false, reconnect: false, reset: true });
  });

  it("a refused invitation reopens the field with its own reason", async () => {
    const h = harness({
      savedKey: KEY,
      deployment: DEPLOYMENT,
      startPeer: async () => {
        throw new MemberJoinError("invitation-refused", "That invitation has been spent.");
      },
    });
    await h.session.join("inv-spent-0000");

    const phase = h.session.state().phase;
    expect(phase.kind === "needs-invitation" && phase.reason).toBe("invitation-refused");
  });

  it("adds the mesh-drift sentence when a RESUME fails and the deployment has moved", async () => {
    const h = harness({
      savedKey: KEY,
      remembered: REMEMBERED,
      deployment: DEPLOYMENT,
      startPeer: async () => {
        throw new MemberJoinError("not-a-member", "This hub does not know this peer.");
      },
    });
    await h.session.start();

    const phase = h.session.state().phase;
    expect(phase.kind === "needs-invitation" && phase.reason).toBe("unknown-identity");
    expect(phase.kind === "needs-invitation" && phase.message).toContain(DEPLOYMENT.hubPeerId);
    expect(phase.kind === "needs-invitation" && phase.message).toContain("httpeers.json");
  });

  it("does NOT add the drift sentence when an invitation chose the mesh", async () => {
    // Comparing an invitation's mesh against httpeers.json would be comparing
    // two things nobody claimed were the same.
    const blob = encodeJoinBlob({
      invitationId: "inv-from-blob",
      relayAddrs: BLOB_MESH.relayAddrs,
      hubPeerId: BLOB_MESH.hubPeerId,
    });
    const h = harness({
      savedKey: KEY,
      deployment: DEPLOYMENT,
      startPeer: async () => {
        throw new MemberJoinError("not-a-member", "This hub does not know this peer.");
      },
    });
    await h.session.join(blob);

    const phase = h.session.state().phase;
    expect(phase.kind === "needs-invitation" && phase.message).not.toContain(DEPLOYMENT.hubPeerId);
  });
});

describe("createPeerSession -- the remembered mesh", () => {
  it("is written only after a join actually succeeds", async () => {
    const h = harness({
      savedKey: KEY,
      deployment: DEPLOYMENT,
      startPeer: async () => {
        throw new MemberJoinError("invitation-refused", "spent");
      },
    });
    await h.session.join("inv-spent-0000");
    expect(h.meshMemory.current()).toBeNull();

    const ok = harness({ savedKey: KEY, deployment: DEPLOYMENT });
    await ok.session.join("inv-good-0000");
    expect(ok.meshMemory.current()).toEqual(DEPLOYMENT);
  });
});

describe("createPeerSession -- the operator controls", () => {
  it("disconnect keeps membership and reconnect resumes with no invitation", async () => {
    const h = harness({ savedKey: KEY, remembered: REMEMBERED });
    await h.session.start();
    await h.session.disconnect();

    const disconnected = h.session.state();
    expect(disconnected.phase.kind).toBe("disconnected");
    expect(disconnected.controls).toEqual({
      join: false,
      disconnect: false,
      reconnect: true,
      reset: true,
    });
    // NOTHING SURRENDERED MEMBERSHIP: the key and the remembered mesh survive.
    expect(h.identity.current()).not.toBeNull();
    expect(h.meshMemory.current()).toEqual(REMEMBERED);

    await h.session.reconnect();
    expect(h.session.state().phase.kind).toBe("live");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.invitationId).toBeUndefined();
  });

  it("resetIdentity clears the key, KEEPS the remembered mesh, and reloads", async () => {
    const h = harness({ savedKey: KEY, remembered: REMEMBERED });
    await h.session.start();
    await h.session.resetIdentity();

    expect(h.identity.current()).toBeNull();
    // Kept deliberately: the new identity still joins the mesh this page was
    // pointed at, and forgetting it would break a bare invitation id against
    // a hub page.
    expect(h.meshMemory.current()).toEqual(REMEMBERED);
    expect(h.reloads()).toBe(1);
  });
});

describe("createPeerSession -- one attempt at a time", () => {
  it("a second attempt while one is in flight is dropped", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      savedKey: KEY,
      remembered: REMEMBERED,
      startPeer: async (peerInit) => {
        await gate;
        return fakeHandle(peerInit.config, "resumed");
      },
    });

    // `reconnect()` rather than `start()`: it enters `attempt` synchronously,
    // so the second call below is genuinely racing an attempt in flight.
    // `start()` awaits the identity read first, and a test that called it
    // here would be measuring that await instead of the guard.
    const first = h.session.reconnect();
    // A macrotask, not a microtask: the attempt awaits the mesh memory and
    // the identity store before it reaches `startPeer`. Asserting the call
    // landed is what keeps the next assertion from passing vacuously.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toHaveLength(1);

    // Two concurrent lifecycles would build two libp2p nodes on ONE identity
    // -- the very duplicate this session refuses when someone else does it.
    await h.session.reconnect();
    expect(h.calls).toHaveLength(1);

    (release as unknown as () => void)();
    await first;
    expect(h.session.state().phase.kind).toBe("live");
  });
});

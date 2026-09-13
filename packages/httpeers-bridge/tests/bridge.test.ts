/**
 * Two peers talking HTTP with no libp2p anywhere.
 *
 * THIS IS THE POINT OF THE PACKAGE. The bridge — fetch over a duplex, both
 * directions, with the proven peer bound on arrival — was welded to libp2p:
 * the only way to exercise it was to stand up a relay, a hub and a WebRTC
 * upgrade. Everything in it except "how do I get a duplex to that peer" is
 * transport-free, so that one question becomes `PeerLink` and the rest runs
 * over anything, including a `MessageChannel` in a single process.
 *
 * WHAT A MessagePort LINK CAN AND CANNOT PROVE. libp2p's Noise handshake
 * establishes who the far side is; a raw MessagePort establishes nothing. So
 * `pairedLinks` ASSERTS the two identities at construction — point-to-point,
 * both ends named up front. That is honest for a test harness and for a
 * trusted in-process transport, and it is exactly why this lives behind its
 * own entry point rather than looking like a peer transport you could deploy.
 */

import { describe, expect, it } from "vitest";
import { createMounts, createPeerRouter, json, lookupPeer } from "@statewalker/httpeers-core";
import { createRemoteOverLink, serveFetchOverLink } from "../src/index.js";
import { pairedLinks } from "../src/ports.js";

const ALICE = `12D3KooW${"A".repeat(44)}`;
const BOB = `12D3KooW${"B".repeat(44)}`;

/** A peer that answers `/whoami` with whatever the transport proved about its caller. */
function peerHandler(name: string) {
  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response(`hello from ${name}`));
  mounts.provide("/whoami", async (req) => json({ caller: String(lookupPeer(req)) }));
  return createPeerRouter({
    selfPeerId: name,
    mounts,
    remote: async () => new Response("no relaying", { status: 403 }),
  });
}

describe("the bridge, over MessagePorts", () => {
  it("carries a request and a response between two peers", async () => {
    const [a, b] = pairedLinks(ALICE, BOB);
    const stopA = await serveFetchOverLink({ link: a, dispatch: peerHandler(ALICE) });
    const stopB = await serveFetchOverLink({ link: b, dispatch: peerHandler(BOB) });
    try {
      const fromA = createRemoteOverLink({ link: a });
      const res = await fromA(BOB, new Request("http://peer.local/hello"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`hello from ${BOB}`);

      // Both directions, so this is not one lucky path.
      const fromB = createRemoteOverLink({ link: b });
      expect(await (await fromB(ALICE, new Request("http://peer.local/hello"))).text()).toBe(
        `hello from ${ALICE}`,
      );
    } finally {
      await stopA();
      await stopB();
    }
  }, 30_000);

  it("binds the peer the LINK proved, not one the caller claimed", async () => {
    // The same contract libp2p's ingress has: whatever arrives in the header
    // is replaced by what the transport says. Here the link asserts it, and
    // the assertion still wins over the caller's own value.
    const [a, b] = pairedLinks(ALICE, BOB);
    const stopB = await serveFetchOverLink({ link: b, dispatch: peerHandler(BOB) });
    try {
      const fromA = createRemoteOverLink({ link: a });
      const res = await fromA(
        BOB,
        new Request("http://peer.local/whoami", {
          headers: { "x-httpeers-peer": "12D3KooWSomebodyElse" },
        }),
      );
      expect((await res.json()) as { caller: string }).toEqual({ caller: ALICE });
    } finally {
      await stopB();
    }
  }, 30_000);

  it("streams a body of real size rather than buffering a token one", async () => {
    // A duplex that only ever carried short strings would pass every test
    // above while being unusable. 256 KiB is past any single-chunk path.
    const big = "x".repeat(256 * 1024);
    const [a, b] = pairedLinks(ALICE, BOB);
    const mounts = createMounts();
    mounts.provide("/echo", async (req) => new Response(await req.text()));
    const stopB = await serveFetchOverLink({
      link: b,
      dispatch: createPeerRouter({
        selfPeerId: BOB,
        mounts,
        remote: async () => new Response(null, { status: 403 }),
      }),
    });
    try {
      const fromA = createRemoteOverLink({ link: a });
      const res = await fromA(
        BOB,
        new Request("http://peer.local/echo", { method: "POST", body: big }),
      );
      expect((await res.text()).length).toBe(big.length);
    } finally {
      await stopB();
    }
  }, 30_000);
});

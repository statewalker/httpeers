/**
 * The extraction's acceptance, at RUNTIME.
 *
 * Five components that have never met outside a type checker meet here: a
 * Circuit Relay v2 server, a hub that reserves through it and relays for its
 * own members, `createHub`'s membership and minting, `withAccess`'s Biscuit
 * verification, and `startMember`'s whole lifecycle. Nothing is stubbed.
 *
 * Every other test in this repository answers "is the API sufficient" or "does
 * this unit behave". This one answers the question those cannot: **do the
 * packages actually work together**. The runtime-import test already showed
 * how wide that gap can be — a published entry point that could not be
 * imported, green across 637 type-checked tests.
 */

import { access } from "@statewalker/httpeers-access";
import { createMounts, json, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { type MemberHandle, MemberJoinError, startMember } from "@statewalker/httpeers-member";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  MESH_RULES,
  type Mesh,
  startMesh,
  testPlatform,
} from "./mesh-harness.js";

let mesh: Mesh | null = null;
const members: MemberHandle[] = [];

afterEach(async () => {
  while (members.length > 0)
    await members
      .pop()
      ?.stop()
      .catch(() => {});
  await mesh?.stop();
  mesh = null;
}, 30_000);

/** A member that serves one greeting, joined with a fresh invitation unless told otherwise. */
async function join(
  live: Mesh,
  opts: { invitationId?: string | null; body?: string } = {},
): Promise<MemberHandle> {
  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response(opts.body ?? "hello from the mesh"));
  // WHAT THE FAR SIDE BELIEVES ABOUT ITS CALLER, reported back so a test can
  // check it. `claims.sub` comes from the verified Biscuit; `peer` is what the
  // transport proved. That they agree is the binding working.
  mounts.provide("/whoami", async (request) => {
    const ctx = access(request);
    return json({ sub: ctx?.claims?.sub ?? null, peer: ctx?.peer ?? null });
  });

  const invitationId =
    opts.invitationId === null ? undefined : (opts.invitationId ?? (await live.invite()));

  const member = await startMember({
    key: "peers",
    mounts,
    rules: MESH_RULES,
    config: { relayAddrs: [live.relayAddr], hubPeerId: live.hubPeerId },
    platform: testPlatform,
    invitationId,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  members.push(member);
  return member;
}

describe("a member joins a real mesh", () => {
  it("redeems an invitation and comes up ready", async () => {
    mesh = await startMesh();
    const member = await join(mesh);

    expect(member.joinedBy).toBe("redeemed");
    expect(member.peerId).toMatch(/^12D3Koo/);
    expect(member.hubPeerId).toBe(mesh.hubPeerId);
    // The hub agrees, which is the half a member cannot fake.
    expect(mesh.hub.isMember(member.peerId)).toBe(true);
  }, 60_000);

  it("refuses a peer the hub does not know and that brings no invitation", async () => {
    mesh = await startMesh();
    // THE REASON IS THE ASSERTION, not merely that it threw. This is the state
    // a page renders as "paste an invitation", and a transport failure that
    // happened to throw here would pass a bare `toThrow` while meaning
    // something completely different.
    const err = await join(mesh, { invitationId: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberJoinError);
    expect((err as MemberJoinError).reason).toBe("not-a-member");
  }, 60_000);

  it("refuses an invitation that has already been spent", async () => {
    mesh = await startMesh();
    const invitationId = await mesh.invite();
    await join(mesh, { invitationId });

    // A SECOND peer, the SAME invitation. One invitation per page is the whole
    // point of the design; a reusable one is a way into the mesh.
    const err = await join(mesh, { invitationId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberJoinError);
    expect((err as MemberJoinError).reason).toBe("invitation-refused");
  }, 60_000);
});

describe("two members, through the mesh", () => {
  it("one calls the other's mount and gets its body", async () => {
    mesh = await startMesh();
    const alice = await join(mesh, { body: "alice speaking" });
    const bob = await join(mesh, { body: "bob speaking" });

    // THE EDGE IS THE SAME HANDLER A PAGE REACHES THROUGH ITS SERVICEWORKER.
    // A Node caller writes `member.fetch(...)` where a page writes
    // `fetch(baseUrl + ...)`, and both take the identical path from there.
    const res = await alice.fetch(new Request(`http://local/peers/${bob.peerId}/hello`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bob speaking");

    // And the other direction, so this is not one lucky route.
    const back = await bob.fetch(new Request(`http://local/peers/${alice.peerId}/hello`));
    expect(await back.text()).toBe("alice speaking");
  }, 90_000);

  it("carries a token the far side verifies, bound to the peer the transport proved", async () => {
    mesh = await startMesh();
    const alice = await join(mesh);
    const bob = await join(mesh);

    const res = await alice.fetch(new Request(`http://local/peers/${bob.peerId}/whoami`));
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { sub: string | null; peer: string | null };

    // THE WHOLE CHAIN IN ONE ASSERTION. `sub` is read out of a Biscuit that
    // Bob verified against the hub's self-certifying key; `peer` is what
    // Bob's libp2p handshake proved. Both must be Alice, and they must AGREE
    // -- a token whose subject differed from the proven caller is precisely
    // the stolen-token case `withAccess` exists to refuse.
    expect(seen.sub).toBe(alice.peerId);
    expect(seen.peer).toBe(alice.peerId);

    // A real Biscuit, not a placeholder.
    expect(alice.token().length).toBeGreaterThan(40);
  }, 90_000);

  it("404s an unmounted path rather than leaking it as a refusal", async () => {
    mesh = await startMesh();
    const alice = await join(mesh);
    const bob = await join(mesh);

    // Asserted EXACTLY, because `not.toBe(200)` passes on a 403 too and would
    // have hidden the forwarding defect this suite just caught.
    const res = await alice.fetch(new Request(`http://local/peers/${bob.peerId}/nothing-here`));
    expect(res.status).toBe(404);
  }, 90_000);
});

describe("a forged identity, against a real transport", () => {
  it("is overwritten by the peer the handshake proved", async () => {
    // THE HEADER SWITCH'S CENTRAL CLAIM, tested where it matters rather than
    // in a unit. Alice sets the proven-peer header by hand, naming Bob. The
    // request crosses a real libp2p connection, and Bob's ingress rebinds it
    // from `context.remotePeer` -- what the Noise handshake established.
    //
    // Under the old WeakMap this was unforgeable by construction. Under a
    // header it is only unforgeable because every ingress strips, so this is
    // the test that says the rule was actually applied end to end.
    mesh = await startMesh();
    const alice = await join(mesh);
    const bob = await join(mesh);

    const res = await alice.fetch(
      new Request(`http://local/peers/${bob.peerId}/whoami`, {
        headers: { [PEER_ID_HEADER]: bob.peerId },
      }),
    );
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { sub: string | null; peer: string | null };

    // Alice, because the transport said so -- not Bob, as she claimed.
    expect(seen.peer).toBe(alice.peerId);
    expect(seen.peer).not.toBe(bob.peerId);
    // And the Biscuit's subject still agrees with the proven peer.
    expect(seen.sub).toBe(alice.peerId);
  }, 90_000);
});

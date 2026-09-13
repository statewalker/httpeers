/**
 * `createHub`, end to end — the assembly the prototype wrote three times.
 *
 * The spec said there would be no `createHub`. The prototype's Node hub,
 * browser hub and test hub each wired the same seven pieces differently, which
 * is the argument for one constructor that returns the parts. These tests
 * exercise it the way an assembly would, over the mount surface a remote peer
 * actually sees.
 */

import { ruleSet } from "@statewalker/httpeers-access";
import { describe, expect, it } from "vitest";
import { createHub } from "../src/create-hub.js";
import { memoryStorage } from "../src/storage.js";

const SELF = "12D3KooWHubSelfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMBER = "12D3KooWMemberBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const RULES = ruleSet({
  version: 1,
  rules: [
    'capability("std:mesh.read")  <- role("member");',
    'capability("std:mesh.admin") <- role("admin");',
    'role("member")               <- role("admin");',
  ],
  policies: [
    'allow if capability("std:mesh.read"), resource("/.well-known")' +
      ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
  ],
});

/** A stand-in signer: the hub's minting is injected, so no crypto is needed here. */
const mintToken = async (sub: string, roles: string[]) => `token:${sub}:${roles.join("+")}`;

function hub(storage = memoryStorage(), now = () => 1_000) {
  return createHub({ selfPeerId: SELF, mintToken, policies: RULES, storage, now });
}

describe("createHub", () => {
  it("returns the parts an assembly needs, wired together", async () => {
    const h = await hub();

    expect(h.mounts.match("/.well-known/mesh")).not.toBeNull();
    expect(typeof h.sweep).toBe("function");
    expect(h.rules).toBe(RULES);
    expect(h.isMember(MEMBER)).toBe(false);

    await h.stop();
  });

  it("an invitation redeems once, and only once", async () => {
    const h = await hub();

    const invite = await h.invitations.create(["member"], 60_000);
    expect(h.invitations.status(invite.id)).toBe("unspent");

    // No peerId argument: who is redeeming is what the TRANSPORT proved at
    // the endpoint, never something the caller states here.
    const first = await h.invitations.redeem(invite.id);
    expect(first).toMatchObject({ ok: true, roles: ["member"] });

    // The whole point of persisting spent ids: a replayed invitation is not a
    // second membership.
    const second = await h.invitations.redeem(invite.id);
    expect(second).toMatchObject({ ok: false, reason: "already-redeemed" });

    await h.stop();
  });

  it("members and spent invitations SURVIVE a restart", async () => {
    // Rung 04's claim, at the level a hub actually uses it. One storage, two
    // hubs — which is what a restart is.
    const storage = memoryStorage();

    const first = await hub(storage);
    const invite = await first.invitations.create(["member"], 60_000);
    await first.invitations.redeem(invite.id);
    first.members.add(MEMBER, ["member"]);
    await first.stop();

    const second = await hub(storage);

    expect(second.isMember(MEMBER)).toBe(true);
    expect(second.invitations.status(invite.id)).toBe("redeemed");

    await second.stop();
  });

  it("an UNREDEEMED invitation also survives, which the prototype's did not", async () => {
    // Recorded as a deliberate departure: the prototype kept unredeemed
    // invitations in memory only, so a hub restart silently invalidated every
    // invitation an operator had already handed out.
    const storage = memoryStorage();

    const first = await hub(storage);
    const invite = await first.invitations.create(["member"], 600_000);
    await first.stop();

    const second = await hub(storage);

    expect(second.invitations.status(invite.id)).toBe("unspent");
    expect(await second.invitations.redeem(invite.id)).toMatchObject({ ok: true });

    await second.stop();
  });

  it("setRoles refuses a role no rule knows", async () => {
    const h = await hub();
    h.members.add(MEMBER, ["member"]);

    expect(() => h.members.setRoles(MEMBER, ["superuser"])).toThrow(/unknown role/);
    expect(h.members.get(MEMBER)?.roles).toEqual(["member"]);

    await h.stop();
  });

  it("stop() is idempotent", async () => {
    const h = await hub();
    await h.stop();
    await expect(h.stop()).resolves.toBeUndefined();
  });

  it("reset() forgets the mesh", async () => {
    const storage = memoryStorage();
    const h = await hub(storage);
    h.members.add(MEMBER, ["member"]);

    await h.reset();

    expect(h.isMember(MEMBER)).toBe(false);
    const restarted = await hub(storage);
    expect(restarted.isMember(MEMBER)).toBe(false);

    await h.stop();
    await restarted.stop();
  });
});

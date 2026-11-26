/**
 * Two memberships in one runtime (statewalker/httpeers#159).
 *
 * One libp2p node per mesh is the working rule: each `startMember` builds its
 * own node through the platform. A caller may still hand `startMember` a node
 * it owns (`node`), for example to run two memberships on one node; then the
 * second membership needs a protocol of its own (`protocol`), served by its
 * hub too, because a node takes one handler per protocol. Whatever happens,
 * `startMember` never stops a node it was given: before the fix, a second
 * start on a shared node failed with `DuplicateProtocolHandlerError` and its
 * cleanup stopped the node, taking the first membership's links with it.
 */

import type { Libp2p } from "@libp2p/interface";
import { createMounts } from "@statewalker/httpeers-core";
import { type MemberHandle, startMember } from "@statewalker/httpeers-member";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  MESH_RULES,
  type Mesh,
  memberNode,
  type StartMeshInit,
  startMesh,
  testPlatform,
} from "./mesh-harness.js";

const meshes: Mesh[] = [];
const members: MemberHandle[] = [];
const nodes: Libp2p[] = [];

afterEach(async () => {
  while (members.length > 0)
    await members
      .pop()
      ?.stop()
      .catch(() => {});
  while (nodes.length > 0) await Promise.resolve(nodes.pop()?.stop()).catch(() => {});
  while (meshes.length > 0) await meshes.pop()?.stop();
}, 60_000);

async function mesh(init: StartMeshInit = {}): Promise<Mesh> {
  const live = await startMesh(init);
  meshes.push(live);
  return live;
}

async function join(
  live: Mesh,
  opts: { key: string; body: string; node?: Libp2p; protocol?: string },
): Promise<MemberHandle> {
  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response(opts.body));
  const member = await startMember({
    key: opts.key,
    mounts,
    rules: MESH_RULES,
    config: { relayAddrs: [live.relayAddr], hubPeerId: live.hubPeerId },
    platform: testPlatform,
    invitationId: await live.invite(),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    ...(opts.node == null ? {} : { node: opts.node }),
    ...(opts.protocol == null ? {} : { protocol: opts.protocol }),
  });
  members.push(member);
  return member;
}

/** A second member of `live` calls `target` and returns what it answered. */
async function callFrom(live: Mesh, target: MemberHandle, protocol?: string): Promise<string> {
  const caller = await join(live, {
    key: "caller",
    body: "caller",
    ...(protocol == null ? {} : { protocol }),
  });
  const res = await caller.fetch(new Request(`http://local/caller/${target.peerId}/hello`));
  expect(res.status).toBe(200);
  return await res.text();
}

describe("two memberships in one runtime", () => {
  it("one node per mesh: both memberships serve their own mesh", async () => {
    const a = await mesh();
    const b = await mesh();
    const inA = await join(a, { key: "a", body: "member of A" });
    const inB = await join(b, { key: "b", body: "member of B" });

    expect(inA.node).not.toBe(inB.node);
    expect(await callFrom(a, inA)).toBe("member of A");
    expect(await callFrom(b, inB)).toBe("member of B");
  }, 120_000);

  it("a failed start leaves a node it was given running", async () => {
    const a = await mesh();
    const b = await mesh();
    const node = await memberNode();
    nodes.push(node);

    const inA = await join(a, { key: "a", body: "member of A", node });
    // Same node, same (default) protocol: the second start cannot register
    // its handler and fails.
    const err = await join(b, { key: "b", body: "member of B", node }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);

    expect(node.status).toBe("started");
    expect(await callFrom(a, inA)).toBe("member of A");
  }, 120_000);

  it("one node, two meshes on two protocols", async () => {
    const a = await mesh();
    const b = await mesh({ protocol: "/httpeers-b/1.0.0/ports" });
    const node = await memberNode();
    nodes.push(node);

    const inA = await join(a, { key: "a", body: "member of A", node });
    const inB = await join(b, {
      key: "b",
      body: "member of B",
      node,
      protocol: "/httpeers-b/1.0.0/ports",
    });

    expect(inA.peerId).toBe(inB.peerId);
    expect(await callFrom(a, inA)).toBe("member of A");
    expect(await callFrom(b, inB, "/httpeers-b/1.0.0/ports")).toBe("member of B");

    // Stopping a membership on a borrowed node leaves the node to its owner.
    await inA.stop();
    expect(node.status).toBe("started");
  }, 120_000);
});

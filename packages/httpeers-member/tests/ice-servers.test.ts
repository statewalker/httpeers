/**
 * `iceServers` reaches the WebRTC transport: what `createBrowserNode`, `browserPlatform` and
 * `createNodeMemberNode` / `nodePlatformWith` are given is what `webRTC()` is built with.
 *
 * `webRTC` is wrapped, not replaced: the real transport is still built (so the node starts and
 * stops as usual) and the spy only records its init. Dropping the argument anywhere on the path
 * makes the recorded init `{}` and these tests fail. Never the real stun.httpeers.net: nothing
 * here dials, and the URLs are `.test` names.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Libp2p } from "@libp2p/interface";
import * as webrtc from "@libp2p/webrtc";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@libp2p/webrtc", async (importOriginal) => {
  const real = await importOriginal<typeof webrtc>();
  return {
    ...real,
    webRTC: vi.fn((init?: Parameters<typeof real.webRTC>[0]) => real.webRTC(init)),
  };
});

const { createBrowserNode } = await import("../src/browser-profile.js");
const { browserPlatform } = await import("../src/browser-platform.js");
const { createNodeMemberNode, nodePlatform, nodePlatformWith } = await import("../src/node.js");

const ICE = [{ urls: "stun:stun.example.test:3478" }];
const webRTC = vi.mocked(webrtc.webRTC);

/** The init of the one `webRTC()` call made since the last clear. */
function lastInit(): unknown {
  expect(webRTC).toHaveBeenCalledTimes(1);
  return webRTC.mock.calls[0]?.[0];
}

describe("iceServers reaches webRTC()", () => {
  const nodes: Libp2p[] = [];
  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.stop();
    webRTC.mockClear();
  });
  const keep = (node: Libp2p): Libp2p => {
    nodes.push(node);
    return node;
  };

  it("createBrowserNode: given, then unset", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    keep(await createBrowserNode({ privateKey, dev: true, iceServers: ICE }));
    expect(lastInit()).toEqual({ rtcConfiguration: { iceServers: ICE } });
    webRTC.mockClear();

    keep(await createBrowserNode({ privateKey: await generateKeyPair("Ed25519"), dev: true }));
    expect(lastInit()).toEqual({});
  });

  it("browserPlatform passes it to the node it builds", async () => {
    const platform = browserPlatform({ dev: true, iceServers: ICE });
    keep(await platform.createNode({ privateKey: await generateKeyPair("Ed25519") }));
    expect(lastInit()).toEqual({ rtcConfiguration: { iceServers: ICE } });
  });

  it("createNodeMemberNode: given, then unset", async () => {
    keep(await createNodeMemberNode({ iceServers: ICE }));
    expect(lastInit()).toEqual({ rtcConfiguration: { iceServers: ICE } });
    webRTC.mockClear();

    keep(await nodePlatform.createNode({}));
    expect(lastInit()).toEqual({});
  });

  it("nodePlatformWith passes it to the node it builds", async () => {
    keep(await nodePlatformWith({ iceServers: ICE }).createNode({}));
    expect(lastInit()).toEqual({ rtcConfiguration: { iceServers: ICE } });
  });
});

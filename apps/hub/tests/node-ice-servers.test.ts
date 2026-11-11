/**
 * `HUB_ICE_SERVERS` reaches the hub's WebRTC transport: `loadConfig` parses it, and
 * `createHubNode` builds `webRTC()` with it (`startDaemon` passes `config.iceServers` straight
 * through). `webRTC` is wrapped, not replaced, so the real node starts; dropping the argument
 * makes the recorded init `{}` and this fails. Nothing dials, and no real STUN server is named.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import * as webrtc from "@libp2p/webrtc";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@libp2p/webrtc", async (importOriginal) => {
  const real = await importOriginal<typeof webrtc>();
  return {
    ...real,
    webRTC: vi.fn((init?: Parameters<typeof real.webRTC>[0]) => real.webRTC(init)),
  };
});

const { loadConfig } = await import("../src/config.js");
const { createHubNode } = await import("../src/node.js");

const webRTC = vi.mocked(webrtc.webRTC);

describe("HUB_ICE_SERVERS reaches the hub's webRTC()", () => {
  afterEach(() => webRTC.mockClear());

  it("is the transport's rtcConfiguration when set", async () => {
    const config = loadConfig({ HUB_ICE_SERVERS: "stun:stun.example.test:3478" });
    const node = await createHubNode({
      privateKey: await generateKeyPair("Ed25519"),
      isMember: () => () => false,
      ...(config.iceServers != null ? { iceServers: config.iceServers } : {}),
    });
    try {
      expect(webRTC).toHaveBeenCalledTimes(1);
      expect(webRTC.mock.calls[0]?.[0]).toEqual({
        rtcConfiguration: { iceServers: [{ urls: "stun:stun.example.test:3478" }] },
      });
    } finally {
      await node.stop();
    }
  });

  it("leaves the transport's default when unset", async () => {
    const node = await createHubNode({
      privateKey: await generateKeyPair("Ed25519"),
      isMember: () => () => false,
    });
    try {
      expect(webRTC.mock.calls[0]?.[0]).toEqual({});
    } finally {
      await node.stop();
    }
  });
});

/**
 * The ICE server choice (`../src/ice-servers.ts`): unset keeps `@libp2p/webrtc`'s default, a
 * list reaches the WebRTC stack, and an env-var list is parsed strictly.
 *
 * NEVER THE REAL stun.httpeers.net. The end-to-end case below points node-datachannel -- the
 * RTCPeerConnection `@libp2p/webrtc` uses under Node -- at a STUN server this test runs on
 * loopback, and asserts that the ICE agent asks it for a Binding.
 */

import { createSocket } from "node:dgram";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  HTTPEERS_ICE_SERVERS,
  HTTPEERS_STUN_URL,
  parseIceServers,
  webRTCInitOf,
} from "../src/ice-servers.js";

describe("webRTCInitOf", () => {
  it("is empty when unset, so @libp2p/webrtc keeps its own default list", () => {
    expect(webRTCInitOf()).toEqual({});
    expect(webRTCInitOf(undefined)).toEqual({});
  });

  it("passes an empty list through: host candidates only", () => {
    expect(webRTCInitOf([])).toEqual({ rtcConfiguration: { iceServers: [] } });
  });

  it("copies the list, so the frozen constant is never what libp2p writes into", () => {
    const init = webRTCInitOf(HTTPEERS_ICE_SERVERS);
    expect(init.rtcConfiguration?.iceServers).toEqual([
      { urls: HTTPEERS_STUN_URL },
      { urls: "stun:stun.l.google.com:19302" },
    ]);
    expect(init.rtcConfiguration?.iceServers).not.toBe(HTTPEERS_ICE_SERVERS);
    expect(Object.isFrozen(init.rtcConfiguration?.iceServers)).toBe(false);
    expect(Object.isFrozen(init.rtcConfiguration?.iceServers[0])).toBe(false);
  });

  it("puts the mesh's own STUN server first", () => {
    expect(HTTPEERS_ICE_SERVERS[0]?.urls).toBe("stun:stun.httpeers.net:3478");
  });
});

describe("parseIceServers", () => {
  it("is undefined for an unset or blank value", () => {
    expect(parseIceServers(undefined)).toBeUndefined();
    expect(parseIceServers("  ")).toBeUndefined();
  });

  it("reads `none` as the empty list", () => {
    expect(parseIceServers("none")).toEqual([]);
  });

  it("splits on commas and trims", () => {
    expect(parseIceServers(" stun:a.test:3478 ,, turns:b.test:5349?transport=tcp ")).toEqual([
      { urls: "stun:a.test:3478" },
      { urls: "turns:b.test:5349?transport=tcp" },
    ]);
  });

  it("refuses a URL without a stun:/turn: scheme, naming it", () => {
    expect(() => parseIceServers("stun:a.test,stun.httpeers.net:3478")).toThrow(
      /"stun\.httpeers\.net:3478"/,
    );
    expect(() => parseIceServers("https://stun.test")).toThrow(/not a stun:/);
  });
});

describe("the list reaches the ICE agent (node-datachannel)", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const step of cleanup.splice(0).reverse()) step();
  });

  it("sends a STUN Binding request to the configured server", async () => {
    // A loopback STUN "server" that records what arrives; answering is not needed for this.
    const server = createSocket("udp4");
    cleanup.push(() => server.close());
    const binding = new Promise<Buffer>((resolve) => {
      server.on("message", (msg) => {
        // RFC 5389: type 0x0001 (Binding request), magic cookie 0x2112A442.
        if (
          msg.length >= 20 &&
          msg.readUInt16BE(0) === 0x0001 &&
          msg.readUInt32BE(4) === 0x2112a442
        ) {
          resolve(msg);
        }
      });
    });
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    const { port } = server.address();

    // The copy of node-datachannel that `@libp2p/webrtc` loads (see `loadedLibdatachannelVersion`).
    const load = createRequire(import.meta.resolve("@libp2p/webrtc"));
    const { RTCPeerConnection } = load("node-datachannel/polyfill") as {
      RTCPeerConnection: new (
        config: unknown,
      ) => {
        createDataChannel(label: string): unknown;
        createOffer(): Promise<unknown>;
        setLocalDescription(d: unknown): Promise<void>;
        close(): void;
      };
    };

    const init = webRTCInitOf([{ urls: `stun:127.0.0.1:${port}` }]);
    const pc = new RTCPeerConnection(init.rtcConfiguration);
    cleanup.push(() => pc.close());
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());

    const msg = await Promise.race([
      binding,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("no Binding request within 5s")), 5000),
      ),
    ]);
    expect(msg.readUInt16BE(0)).toBe(0x0001);
  });
});

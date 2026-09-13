import { describe, expect, it } from "vitest";
import { classifyConnection, describeConnection } from "../src/connection-kind.js";

describe("classifyConnection", () => {
  it("calls a /webrtc address direct — the relay is out of the data path", () => {
    expect(
      classifyConnection([
        "/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3Relay/p2p-circuit/webrtc/p2p/12D3Peer",
      ]),
    ).toBe("direct");
  });

  // THE CASE THAT COST AN AFTERNOON. A circuit address WITHOUT /webrtc means
  // the WebRTC upgrade never completed and every byte crosses the relay.
  it("calls a bare circuit address relayed", () => {
    expect(
      classifyConnection([
        "/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3Relay/p2p-circuit/p2p/12D3Peer",
      ]),
    ).toBe("relayed");
  });

  it("prefers direct when both exist, because that is the one traffic uses", () => {
    expect(
      classifyConnection([
        "/dns4/r/tcp/443/tls/ws/p2p/12D3Relay/p2p-circuit/p2p/12D3Peer",
        "/dns4/r/tcp/443/tls/ws/p2p/12D3Relay/p2p-circuit/webrtc/p2p/12D3Peer",
      ]),
    ).toBe("direct");
  });

  it("reports none when nothing is open", () => {
    expect(classifyConnection([])).toBe("none");
  });

  it("treats a plain non-circuit address as direct", () => {
    expect(classifyConnection(["/ip4/1.2.3.4/tcp/4001/p2p/12D3Peer"])).toBe("direct");
  });
});

describe("describeConnection", () => {
  it("says plainly that a relayed peer is slower and crosses the relay", () => {
    const text = describeConnection("relayed");
    expect(text.toLowerCase()).toContain("relay");
    expect(text).not.toBe("");
  });

  it("has wording for every state, so a caller can render it unconditionally", () => {
    for (const kind of ["direct", "relayed", "none"] as const) {
      expect(describeConnection(kind).length).toBeGreaterThan(0);
    }
  });
});

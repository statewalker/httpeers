/**
 * A deployment config is parsed, never cast.
 *
 * `readDeploymentConfigOverHttp` used to do this:
 *
 *     return (await res.json()) as HttpeersConfig;
 *
 * — a cast, which checks nothing. It mattered the moment the hub moved into a
 * TAB: a hub-page deployment has no stable `hubPeerId` to publish, so its
 * `httpeers.json` carries `relayAddrs` alone. That config reached `startMember`
 * with `hubPeerId: undefined` and failed somewhere far from the cause.
 *
 * `null` is the right answer for anything unusable, because the session already
 * renders it correctly: "there is no mesh to join, paste an invitation" — which
 * is exactly the state a hub-page deployment starts every other page in.
 */
import { describe, expect, it } from "vitest";
import { parseMeshConfig } from "../src/mesh-config.js";

const RELAY = "/dns4/relay.httpeers.net/tcp/443/wss/p2p/12D3KooWRelay";

describe("parseMeshConfig", () => {
  it("accepts a complete config", () => {
    expect(parseMeshConfig({ relayAddrs: [RELAY], hubPeerId: "12D3KooWHub" })).toEqual({
      relayAddrs: [RELAY],
      hubPeerId: "12D3KooWHub",
    });
  });

  it("refuses a config with no hubPeerId — the hub-page case", () => {
    // THE CASE THIS EXISTS FOR. Not malformed, just incomplete: a deployment
    // whose hub is a browser tab cannot name one ahead of time.
    expect(parseMeshConfig({ relayAddrs: [RELAY] })).toBeNull();
    expect(parseMeshConfig({ relayAddrs: [RELAY], hubPeerId: "" })).toBeNull();
  });

  it("refuses a config with no usable relay", () => {
    expect(parseMeshConfig({ hubPeerId: "12D3KooWHub" })).toBeNull();
    expect(parseMeshConfig({ relayAddrs: [], hubPeerId: "12D3KooWHub" })).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    for (const bad of [null, undefined, 42, "nope", [], true]) {
      expect(parseMeshConfig(bad)).toBeNull();
    }
  });

  it("keeps only the two fields it knows", () => {
    // A deployment may publish more; carrying unknown fields into `MeshConfig`
    // would let an unrelated key look like configuration this library honours.
    const parsed = parseMeshConfig({ relayAddrs: [RELAY], hubPeerId: "H", extra: "ignored" });
    expect(parsed).toEqual({ relayAddrs: [RELAY], hubPeerId: "H" });
  });
});

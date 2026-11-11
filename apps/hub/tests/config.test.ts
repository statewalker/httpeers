import { describe, expect, it } from "vitest";
import { loadConfig, MIN_MUX_WINDOW } from "../src/config.js";

describe("loadConfig", () => {
  it("has the appliance's defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual({
      dataDir: "/data",
      relayDoc: "https://relay.httpeers.net/.well-known/httpeers-relay.json",
      services: [],
      joinPageUrl: "https://llm-chat.httpeers.net/mesh.html",
      localDoorPort: 8787,
      localDoorHost: "0.0.0.0",
      doorAllowedHosts: ["127.0.0.1:8080", "localhost:8080"],
    });
  });

  it("reads every setting from the environment", () => {
    expect(
      loadConfig({
        HUB_DATA_DIR: "/srv/data",
        HUB_RELAY_DOC: "http://127.0.0.1:1234/relay.json",
        HUB_SERVICES: " llm, echo ,,",
        HUB_JOIN_PAGE_URL: "https://example.test/join.html",
        HUB_LOCAL_DOOR_PORT: "9999",
        HUB_LOCAL_DOOR_HOST: "127.0.0.1",
        HUB_DOOR_SECRET: "door-secret",
        HUB_DOOR_ALLOWED_HOSTS: " 127.0.0.1:8080, hub.local:9000 ,",
        HUB_MAX_RESERVATIONS: "500",
        HUB_MUX_PER_PEER: "true",
        HUB_MUX_WINDOW: "4194304",
        HUB_LLM_UPSTREAM: "http://litellm:4000",
        LITELLM_MASTER_KEY: "sk-master",
      }),
    ).toEqual({
      dataDir: "/srv/data",
      relayDoc: "http://127.0.0.1:1234/relay.json",
      services: ["llm", "echo"],
      joinPageUrl: "https://example.test/join.html",
      localDoorPort: 9999,
      localDoorHost: "127.0.0.1",
      doorSecret: "door-secret",
      doorAllowedHosts: ["127.0.0.1:8080", "hub.local:9000"],
      maxReservations: 500,
      muxPerPeer: { window: 4194304 },
      llmUpstream: "http://litellm:4000",
      litellmMasterKey: "sk-master",
    });
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({
      HUB_DATA_DIR: "",
      HUB_SERVICES: "",
      LITELLM_MASTER_KEY: "",
      HUB_DOOR_SECRET: "  ",
      HUB_DOOR_ALLOWED_HOSTS: " , ",
      HUB_MAX_RESERVATIONS: "",
      HUB_ICE_SERVERS: "",
      HUB_MUX_PER_PEER: " ",
      HUB_MUX_WINDOW: "",
    });
    expect(config.dataDir).toBe("/data");
    expect(config.services).toEqual([]);
    expect("litellmMasterKey" in config).toBe(false);
    expect("doorSecret" in config).toBe(false);
    expect("maxReservations" in config).toBe(false);
    expect("iceServers" in config).toBe(false);
    expect("muxPerPeer" in config).toBe(false);
    expect(config.doorAllowedHosts).toEqual(["127.0.0.1:8080", "localhost:8080"]);
  });

  it("refuses a port that is not a port", () => {
    expect(() => loadConfig({ HUB_LOCAL_DOOR_PORT: "eighty" })).toThrow(/HUB_LOCAL_DOOR_PORT/);
    expect(() => loadConfig({ HUB_LOCAL_DOOR_PORT: "70000" })).toThrow(/HUB_LOCAL_DOOR_PORT/);
  });

  it("refuses a reservation store size that is not a positive integer", () => {
    for (const bad of ["0", "-5", "1.5", "lots", "1e3"]) {
      expect(() => loadConfig({ HUB_MAX_RESERVATIONS: bad })).toThrow(/HUB_MAX_RESERVATIONS/);
    }
  });

  it("reads HUB_ICE_SERVERS as a list of ICE server URLs", () => {
    expect(
      loadConfig({ HUB_ICE_SERVERS: "stun:stun.example.test:3478, stun:stun2.example.test" })
        .iceServers,
    ).toEqual([{ urls: "stun:stun.example.test:3478" }, { urls: "stun:stun2.example.test" }]);
    // `none`: host candidates only -- not the same as unset, which keeps libp2p's default.
    expect(loadConfig({ HUB_ICE_SERVERS: "none" }).iceServers).toEqual([]);
    expect(() => loadConfig({ HUB_ICE_SERVERS: "turn:turn.example.test:3478" })).toThrow(
      /HUB_ICE_SERVERS.*TURN URL/,
    );
    expect(() => loadConfig({ HUB_ICE_SERVERS: "stun.example.test:3478" })).toThrow(
      /HUB_ICE_SERVERS.*stun\.example\.test:3478/,
    );
  });

  it("reads HUB_MUX_PER_PEER as an opt-in flag, off by default", () => {
    expect("muxPerPeer" in loadConfig({})).toBe(false);
    for (const on of ["true", "TRUE", "1", "yes", "on", " On "]) {
      expect(loadConfig({ HUB_MUX_PER_PEER: on }).muxPerPeer).toEqual({});
    }
    for (const off of ["false", "0", "no", "off"]) {
      expect("muxPerPeer" in loadConfig({ HUB_MUX_PER_PEER: off })).toBe(false);
    }
    expect(() => loadConfig({ HUB_MUX_PER_PEER: "maybe" })).toThrow(/HUB_MUX_PER_PEER/);
  });

  it("reads HUB_MUX_WINDOW only with the flag on, and at least MIN_MUX_WINDOW bytes", () => {
    expect(loadConfig({ HUB_MUX_PER_PEER: "1", HUB_MUX_WINDOW: "1048576" }).muxPerPeer).toEqual({
      window: 1048576,
    });
    expect(
      loadConfig({ HUB_MUX_PER_PEER: "1", HUB_MUX_WINDOW: String(MIN_MUX_WINDOW) }).muxPerPeer,
    ).toEqual({ window: MIN_MUX_WINDOW });
    // A window for a path that is off would be silently ignored: refused instead.
    expect(() => loadConfig({ HUB_MUX_WINDOW: "1048576" })).toThrow(
      /HUB_MUX_WINDOW.*HUB_MUX_PER_PEER/,
    );
    expect(() => loadConfig({ HUB_MUX_PER_PEER: "off", HUB_MUX_WINDOW: "1048576" })).toThrow(
      /HUB_MUX_WINDOW/,
    );
    for (const bad of ["0", "-1", "1.5", "big", String(MIN_MUX_WINDOW - 1)]) {
      expect(() => loadConfig({ HUB_MUX_PER_PEER: "1", HUB_MUX_WINDOW: bad })).toThrow(
        /HUB_MUX_WINDOW/,
      );
    }
  });
});

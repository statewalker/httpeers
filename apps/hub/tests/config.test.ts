import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
    });
    expect(config.dataDir).toBe("/data");
    expect(config.services).toEqual([]);
    expect("litellmMasterKey" in config).toBe(false);
    expect("doorSecret" in config).toBe(false);
    expect("maxReservations" in config).toBe(false);
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
});

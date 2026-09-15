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
        HUB_LLM_UPSTREAM: "http://litellm:4000",
        LITELLM_MASTER_KEY: "sk-master",
      }),
    ).toEqual({
      dataDir: "/srv/data",
      relayDoc: "http://127.0.0.1:1234/relay.json",
      services: ["llm", "echo"],
      joinPageUrl: "https://example.test/join.html",
      localDoorPort: 9999,
      llmUpstream: "http://litellm:4000",
      litellmMasterKey: "sk-master",
    });
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({ HUB_DATA_DIR: "", HUB_SERVICES: "", LITELLM_MASTER_KEY: "" });
    expect(config.dataDir).toBe("/data");
    expect(config.services).toEqual([]);
    expect("litellmMasterKey" in config).toBe(false);
  });

  it("refuses a port that is not a port", () => {
    expect(() => loadConfig({ HUB_LOCAL_DOOR_PORT: "eighty" })).toThrow(/HUB_LOCAL_DOOR_PORT/);
    expect(() => loadConfig({ HUB_LOCAL_DOOR_PORT: "70000" })).toThrow(/HUB_LOCAL_DOOR_PORT/);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyEndpoint,
  applyModels,
  type ChatConfig,
  normalizeBaseUrl,
  refreshModels,
  resolveModel,
  startupStep,
} from "../src/core/config.js";
import { titleFrom } from "../src/core/sessions.js";

const ready: ChatConfig = {
  baseUrl: "http://llm.test/v1",
  apiKey: "k",
  models: ["a", "b"],
  defaultModel: "b",
};

describe("startup", () => {
  it("asks for settings, then a model, then opens the chat", () => {
    expect(startupStep(null)).toBe("settings");
    expect(startupStep({ baseUrl: "", models: [] })).toBe("settings");
    expect(startupStep({ baseUrl: "http://x/v1", models: [] })).toBe("models");
    expect(startupStep(ready)).toBe("chat");
  });
});

describe("applyEndpoint", () => {
  it("normalizes the base URL", () => {
    expect(normalizeBaseUrl(" http://x/v1// ")).toBe("http://x/v1");
  });

  it("keeps models when only the key changes", () => {
    expect(applyEndpoint(ready, { baseUrl: "http://llm.test/v1/", apiKey: "k2" })).toEqual({
      ...ready,
      apiKey: "k2",
    });
  });

  it("clears models and the default when the base URL changes", () => {
    expect(applyEndpoint(ready, { baseUrl: "http://other/v1", apiKey: "k" })).toEqual({
      baseUrl: "http://other/v1",
      apiKey: "k",
      models: [],
    });
  });
});

describe("applyEndpoint and the key header", () => {
  const mesh: ChatConfig = { ...ready, apiKeyHeader: "x-litellm-api-key" };

  it("keeps the stored header when the settings dialog saves only a URL and a key", () => {
    expect(applyEndpoint(mesh, { baseUrl: mesh.baseUrl, apiKey: "k2" })).toEqual({
      ...mesh,
      apiKey: "k2",
    });
    expect(applyEndpoint(mesh, { baseUrl: "http://other/v1", apiKey: "k" })).toEqual({
      baseUrl: "http://other/v1",
      apiKey: "k",
      apiKeyHeader: "x-litellm-api-key",
      models: [],
    });
  });

  it("takes a header the endpoint names, and keeps the models when only the header changes", () => {
    expect(
      applyEndpoint(ready, { baseUrl: ready.baseUrl, apiKey: "k", apiKeyHeader: "x-api-key" }),
    ).toEqual({ ...ready, apiKeyHeader: "x-api-key" });
    expect(
      applyEndpoint(null, { baseUrl: "http://x/v1", apiKey: "k", apiKeyHeader: "x-api-key" }),
    ).toEqual({ baseUrl: "http://x/v1", apiKey: "k", apiKeyHeader: "x-api-key", models: [] });
  });

  it("adds no header field to a config that never had one", () => {
    expect(Object.keys(applyEndpoint(null, { baseUrl: "http://x/v1" }))).not.toContain(
      "apiKeyHeader",
    );
  });
});

describe("models", () => {
  it("applyModels sets the default and adds a typed-in id to the list", () => {
    expect(applyModels(ready, ["a"], "custom")).toMatchObject({
      models: ["a", "custom"],
      defaultModel: "custom",
    });
  });

  it("refreshModels keeps a surviving default, else takes the first, and ignores an empty list", () => {
    expect(refreshModels(ready, ["b", "c"]).defaultModel).toBe("b");
    expect(refreshModels(ready, ["c", "d"])).toMatchObject({
      models: ["c", "d"],
      defaultModel: "c",
    });
    expect(refreshModels(ready, [])).toBe(ready);
  });

  it("resolveModel prefers a listed session model, else the default", () => {
    expect(resolveModel(ready, "a")).toBe("a");
    expect(resolveModel(ready, "gone")).toBe("b");
    expect(resolveModel(ready, undefined)).toBe("b");
    expect(resolveModel({ ...ready, defaultModel: undefined }, undefined)).toBe("a");
    expect(resolveModel(null, "a")).toBeUndefined();
  });
});

describe("titleFrom", () => {
  it("uses the first message on one line, cut to 60 characters", () => {
    expect(titleFrom("  hello\n  world ")).toBe("hello world");
    expect(titleFrom("x".repeat(80))).toHaveLength(60);
    expect(titleFrom("x".repeat(80)).endsWith("…")).toBe(true);
    expect(titleFrom("   ")).toBe("New chat");
  });
});

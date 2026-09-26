import { describe, expect, it } from "vitest";
import {
  fetchExternalConfig,
  parseExternalConfig,
  resolveConfig,
} from "../src/core/external-config.js";

const VALID = { schemaVersion: 1, baseUrl: "https://h/v1", apiKey: "k", label: "Home appliance" };

describe("parseExternalConfig", () => {
  it("accepts a well-formed document", () => {
    expect(parseExternalConfig(VALID).baseUrl).toBe("https://h/v1");
  });

  it("refuses an unknown schemaVersion, naming both versions", () => {
    expect(() => parseExternalConfig({ ...VALID, schemaVersion: 2 })).toThrow(/2.*1/);
  });

  it("refuses a missing baseUrl, naming the field", () => {
    expect(() => parseExternalConfig({ schemaVersion: 1 })).toThrow(/baseUrl/);
  });

  it("refuses a non-http baseUrl", () => {
    expect(() => parseExternalConfig({ ...VALID, baseUrl: "javascript:alert(1)" })).toThrow(
      /baseUrl/,
    );
  });

  it("normalises a trailing slash away", () => {
    expect(parseExternalConfig({ ...VALID, baseUrl: "https://h/v1/" }).baseUrl).toBe(
      "https://h/v1",
    );
  });
});

describe("resolveConfig", () => {
  const saved = { baseUrl: "https://saved/v1", apiKey: "s", models: ["m"], defaultModel: "m" };

  it("prefers what the user saved over the document", () => {
    const { config, source } = resolveConfig({ saved, external: parseExternalConfig(VALID) });
    expect(config?.baseUrl).toBe("https://saved/v1");
    expect(source).toBe("saved");
  });

  it("uses the document when nothing is saved", () => {
    const { config, source } = resolveConfig({ saved: null, external: parseExternalConfig(VALID) });
    expect(config?.baseUrl).toBe("https://h/v1");
    expect(source).toBe("external");
  });

  it("carries the document's key header, so a mesh key is not sent as a Bearer", () => {
    const external = parseExternalConfig({ ...VALID, apiKeyHeader: "x-litellm-api-key" });
    expect(resolveConfig({ saved: null, external }).config?.apiKeyHeader).toBe("x-litellm-api-key");
  });

  it("starts an empty model list for a document-supplied endpoint", () => {
    expect(
      resolveConfig({ saved: null, external: parseExternalConfig(VALID) }).config?.models,
    ).toEqual([]);
  });

  it("reports none when there is neither", () => {
    expect(resolveConfig({ saved: null, external: null })).toEqual({
      config: null,
      source: "none",
    });
  });
});

describe("fetchExternalConfig", () => {
  it("throws a message naming the URL when the fetch fails", async () => {
    const failing = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchExternalConfig("https://c/conf.json", failing)).rejects.toThrow(
      /https:\/\/c\/conf\.json/,
    );
  });

  it("throws a message naming the status on a non-2xx", async () => {
    const notFound = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(fetchExternalConfig("https://c/conf.json", notFound)).rejects.toThrow(/404/);
  });

  it("throws on a body that is not JSON, without leaking the whole body", async () => {
    const html = (async () =>
      new Response("<!doctype html><html>…</html>")) as unknown as typeof globalThis.fetch;
    await expect(fetchExternalConfig("https://c/conf.json", html)).rejects.toThrow(/JSON/);
  });
});

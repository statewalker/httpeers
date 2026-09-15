import { describe, expect, it } from "vitest";
import { buildLlmOpenApi } from "../src/services/llm/openapi.js";

describe("buildLlmOpenApi", () => {
  it("is servers-relative, so it carries no hubPeerId anywhere", () => {
    const doc = buildLlmOpenApi();
    expect(doc.servers).toEqual([{ url: "." }]);
    expect(JSON.stringify(doc)).not.toContain("hubPeerId");
  });

  it("names the llmKey security scheme", () => {
    const doc = buildLlmOpenApi();
    expect(doc.components).toMatchObject({
      securitySchemes: {
        llmKey: { type: "apiKey", in: "header", name: "x-litellm-api-key" },
      },
    });
  });

  it("has exactly the five curated paths with their operationIds", () => {
    const doc = buildLlmOpenApi();
    expect(Object.keys(doc.paths).sort()).toEqual(
      ["/keys", "/ui/", "/v1/chat/completions", "/v1/embeddings", "/v1/models"].sort(),
    );
    expect((doc.paths["/ui/"].get as { operationId: string }).operationId).toBe("ui");
    expect((doc.paths["/v1/models"].get as { operationId: string }).operationId).toBe("listModels");
    expect((doc.paths["/v1/chat/completions"].post as { operationId: string }).operationId).toBe(
      "createChatCompletion",
    );
    expect((doc.paths["/v1/embeddings"].post as { operationId: string }).operationId).toBe(
      "createEmbedding",
    );
    expect((doc.paths["/keys"].post as { operationId: string }).operationId).toBe("createKey");
  });

  it("carries x-httpeers-capability on every operation, admin for /ui/ and /keys, use elsewhere", () => {
    const doc = buildLlmOpenApi();
    const operations: Array<[string, Record<string, unknown>]> = [
      ["/ui/", doc.paths["/ui/"].get as Record<string, unknown>],
      ["/v1/models", doc.paths["/v1/models"].get as Record<string, unknown>],
      ["/v1/chat/completions", doc.paths["/v1/chat/completions"].post as Record<string, unknown>],
      ["/v1/embeddings", doc.paths["/v1/embeddings"].post as Record<string, unknown>],
      ["/keys", doc.paths["/keys"].post as Record<string, unknown>],
    ];
    for (const [path, op] of operations) {
      expect(op["x-httpeers-capability"], path).toBeTruthy();
    }
    expect(doc.paths["/ui/"].get).toMatchObject({ "x-httpeers-capability": "app:llm.admin" });
    expect(doc.paths["/keys"].post).toMatchObject({ "x-httpeers-capability": "app:llm.admin" });
    expect(doc.paths["/v1/models"].get).toMatchObject({ "x-httpeers-capability": "app:llm.use" });
    expect(doc.paths["/v1/chat/completions"].post).toMatchObject({
      "x-httpeers-capability": "app:llm.use",
    });
    expect(doc.paths["/v1/embeddings"].post).toMatchObject({
      "x-httpeers-capability": "app:llm.use",
    });
  });

  it("the chat completion response describes both JSON and SSE", () => {
    const doc = buildLlmOpenApi();
    const responses = (
      doc.paths["/v1/chat/completions"].post as {
        responses: { "200": { content: Record<string, unknown> } };
      }
    ).responses["200"].content;
    expect(Object.keys(responses).sort()).toEqual(["application/json", "text/event-stream"]);
  });

  it("/ui/ names the html-app resource and its entry", () => {
    const doc = buildLlmOpenApi();
    expect(doc.paths["/ui/"].get).toMatchObject({
      "x-httpeers-resource": "html-app",
      "x-httpeers-entry": "ui/login/",
    });
  });

  it("points externalDocs at the full document", () => {
    expect(buildLlmOpenApi().externalDocs).toEqual({ url: "openapi.full.json" });
  });
});

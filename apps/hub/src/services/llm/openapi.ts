/**
 * `GET /llm/openapi.json` — the curated document, spec §5.6.
 *
 * A PLAIN OBJECT, BUILT ONCE. `servers: [{ url: "." }]` makes every path
 * relative to wherever this document was fetched from — no `hubPeerId` (or
 * anything else per-hub) appears anywhere in it, so `buildLlmOpenApi()` takes
 * no arguments and its result is effectively a constant (`admin-openapi.ts`
 * makes the same choice, for the same reason).
 *
 * `x-httpeers-capability` on every operation is what Task 8's browser page
 * uses to decide which calls to even attempt before trying them.
 */

/** Loose enough to describe OpenAPI 3.1 without pulling in a schema package — mirrors `admin-openapi.ts`. */
export interface LlmOpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  components: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  externalDocs: { url: string };
}

const SECURITY = [{ llmKey: [] as string[] }];

const jsonSchema = (schema: Record<string, unknown>) => ({ "application/json": { schema } });

/** Build the LLM service's curated OpenAPI 3.1 document. */
export function buildLlmOpenApi(): LlmOpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "LLM", version: "1.0.0" },
    servers: [{ url: "." }],
    components: {
      securitySchemes: {
        llmKey: { type: "apiKey", in: "header", name: "x-litellm-api-key" },
      },
    },
    paths: {
      "/ui/": {
        get: {
          operationId: "ui",
          summary: "The LiteLLM admin dashboard.",
          "x-httpeers-capability": "app:llm.admin",
          "x-httpeers-resource": "html-app",
          "x-httpeers-entry": "ui/login/",
          security: SECURITY,
          responses: {
            "200": {
              description: "The dashboard shell.",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/v1/models": {
        get: {
          operationId: "listModels",
          summary: "List the models this key can use.",
          "x-httpeers-capability": "app:llm.use",
          security: SECURITY,
          responses: {
            "200": { description: "Models.", content: jsonSchema({ type: "object" }) },
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          operationId: "createChatCompletion",
          summary: "Create a chat completion, optionally streamed.",
          "x-httpeers-capability": "app:llm.use",
          security: SECURITY,
          requestBody: {
            required: true,
            content: jsonSchema({ type: "object" }),
          },
          responses: {
            "200": {
              description: "The completion, or an SSE stream when `stream: true`.",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/v1/embeddings": {
        post: {
          operationId: "createEmbedding",
          summary: "Create embeddings.",
          "x-httpeers-capability": "app:llm.use",
          security: SECURITY,
          requestBody: {
            required: true,
            content: jsonSchema({ type: "object" }),
          },
          responses: {
            "200": { description: "Embeddings.", content: jsonSchema({ type: "object" }) },
          },
        },
      },
      "/keys": {
        post: {
          operationId: "createKey",
          summary: "Mint a scoped LiteLLM key, using the hub's master key.",
          "x-httpeers-capability": "app:llm.admin",
          // NO llmKey security scheme here: unlike every other operation,
          // this one is not forwarded to LiteLLM with a caller-supplied
          // x-litellm-api-key at all — it is authorized purely by the mesh's
          // own app:llm.admin capability, and the hub itself holds (and never
          // exposes) the master key that actually talks to LiteLLM.
          requestBody: {
            required: true,
            content: jsonSchema({
              type: "object",
              properties: {
                key_alias: { type: "string" },
                user_id: { type: "string" },
                models: { type: "array", items: { type: "string" } },
                max_budget: { type: "number" },
                budget_duration: { type: "string" },
                duration: { type: "string" },
                tpm_limit: { type: "number" },
                rpm_limit: { type: "number" },
                metadata: { type: "object" },
              },
            }),
          },
          responses: {
            "200": {
              description: "The minted key.",
              content: jsonSchema({
                type: "object",
                required: ["key", "key_alias", "expires"],
                properties: {
                  key: { type: "string" },
                  key_alias: { type: "string" },
                  expires: { type: ["string", "null"] },
                },
              }),
            },
          },
        },
      },
    },
    externalDocs: { url: "openapi.full.json" },
  };
}

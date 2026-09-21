import { describe, expect, it } from "vitest";
import type { ChatConfig } from "../src/core/config.js";
import {
  discoverLlm,
  findLlmAdvert,
  isMeshAdmin,
  KeyRequestError,
  keyShareText,
  meshConfig,
  mintKey,
} from "../src/mesh/discover.js";

const EDGE = "https://chat.test/peers/";
const HUB = "12D3KooWHub";

/** The hub's curated document, trimmed to what discovery reads (spec §5.6). */
const documentStub = (overrides: Record<string, unknown> = {}) => ({
  openapi: "3.1.0",
  servers: [{ url: "." }],
  components: {
    securitySchemes: { llmKey: { type: "apiKey", in: "header", name: "x-litellm-api-key" } },
  },
  paths: {
    "/ui/": { get: { "x-httpeers-entry": "ui/" } },
    "/v1/models": { get: {} },
    "/v1/chat/completions": { post: {} },
    "/keys": { post: { "x-httpeers-capability": "app:llm.admin" } },
  },
  ...overrides,
});

function fetchAnswering(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("discoverLlm", () => {
  it("reads openapi.json under the hub's llm mount and resolves the relative server", async () => {
    const { calls, fetchImpl } = fetchAnswering(() => Response.json(documentStub()));
    const service = await discoverLlm(fetchImpl, EDGE, HUB);
    expect(calls.map((c) => c.url)).toEqual([`${EDGE}${HUB}/llm/openapi.json`]);
    expect(service).toEqual({
      serviceBase: `${EDGE}${HUB}/llm/`,
      baseUrl: `${EDGE}${HUB}/llm/v1`,
      apiKeyHeader: "x-litellm-api-key",
      canMintKeys: true,
      dashboardUrl: `${EDGE}${HUB}/llm/ui/`,
    });
  });

  it("accepts an edge base without its trailing slash", async () => {
    const { calls, fetchImpl } = fetchAnswering(() => Response.json(documentStub()));
    await discoverLlm(fetchImpl, EDGE.slice(0, -1), HUB);
    expect(calls[0]?.url).toBe(`${EDGE}${HUB}/llm/openapi.json`);
  });

  it("accepts a server URL other than '.' that stays under the hub's llm mount", async () => {
    const { fetchImpl } = fetchAnswering(() =>
      Response.json(
        documentStub({
          servers: [{ url: "./" }],
          components: { securitySchemes: { llmKey: { in: "header", name: "x-api-key" } } },
          paths: { "/ui/": { get: { "x-httpeers-entry": "ui/" } } },
        }),
      ),
    );
    expect(await discoverLlm(fetchImpl, EDGE, HUB)).toEqual({
      serviceBase: `${EDGE}${HUB}/llm/`,
      baseUrl: `${EDGE}${HUB}/llm/v1`,
      apiKeyHeader: "x-api-key",
      canMintKeys: false,
      dashboardUrl: `${EDGE}${HUB}/llm/ui/`,
    });
  });

  describe("refuses a document that would send the key or the admin anywhere but the hub's llm mount", () => {
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["an absolute off-origin server", { servers: [{ url: "https://evil.example/v1/" }] }],
      ["a same-origin server on another peer", { servers: [{ url: `${EDGE}rogue/llm/` }] }],
      ["a ../ escape to a sibling mount", { servers: [{ url: "../llm2/" }] }],
      ["a ../ escape out of the hub", { servers: [{ url: "../../rogue/llm/" }] }],
      ["an encoded ../ escape", { servers: [{ url: "%2e%2e/llm2/" }] }],
      ["a protocol-relative server", { servers: [{ url: "//evil.example/llm/" }] }],
      ["a server carrying a query", { servers: [{ url: ".?to=evil" }] }],
      [
        "an absolute dashboard entry",
        { paths: { "/ui/": { get: { "x-httpeers-entry": "https://evil.example/ui/" } } } },
      ],
      [
        "an escaping dashboard entry",
        { paths: { "/ui/": { get: { "x-httpeers-entry": "../../rogue/ui/" } } } },
      ],
      [
        "a root-relative dashboard entry",
        { paths: { "/ui/": { get: { "x-httpeers-entry": "/ui/login/" } } } },
      ],
    ];
    for (const [name, overrides] of hostile) {
      it(name, async () => {
        const { fetchImpl } = fetchAnswering(() => Response.json(documentStub(overrides)));
        await expect(discoverLlm(fetchImpl, EDGE, HUB)).rejects.toThrow(
          `outside ${EDGE}${HUB}/llm/`,
        );
      });
    }
  });

  /**
   * The dashboard is opened at its MOUNT, whatever page the hub names inside it.
   *
   * MEASURED, 2026-09-20: LiteLLM's exported UI is client-routed and knows nothing of
   * `SERVER_ROOT_PATH`. Opened at `…/llm/ui/login/` in a browser that already holds LiteLLM's
   * `token` cookie, its login page routes to `/ui` at the ORIGIN ROOT — off the mesh path, 404.
   * Opened at `…/llm/ui/` it lands on the same login page with a prefixed absolute
   * `?redirect_to=` and stays. A hub we do not control may still advertise the old entry (the
   * mesh page is a static site and cannot be upgraded with every hub), so the page normalizes it
   * here rather than trusting it.
   */
  it("opens the dashboard at its mount even when the hub names a page inside it", async () => {
    for (const entry of ["ui/login/", "ui/login", "ui/models", "./ui/login/", "ui/"]) {
      const { fetchImpl } = fetchAnswering(() =>
        Response.json(documentStub({ paths: { "/ui/": { get: { "x-httpeers-entry": entry } } } })),
      );
      expect((await discoverLlm(fetchImpl, EDGE, HUB)).dashboardUrl, entry).toBe(
        `${EDGE}${HUB}/llm/ui/`,
      );
    }
  });

  it("leaves an entry that is not inside the dashboard alone", async () => {
    const { fetchImpl } = fetchAnswering(() =>
      Response.json(
        documentStub({ paths: { "/ui/": { get: { "x-httpeers-entry": "console/" } } } }),
      ),
    );
    expect((await discoverLlm(fetchImpl, EDGE, HUB)).dashboardUrl).toBe(
      `${EDGE}${HUB}/llm/console/`,
    );
  });

  it("falls back to the /ui/ path when the entry extension is absent", async () => {
    const { fetchImpl } = fetchAnswering(() =>
      Response.json(documentStub({ paths: { "/ui/": { get: {} } } })),
    );
    expect((await discoverLlm(fetchImpl, EDGE, HUB)).dashboardUrl).toBe(`${EDGE}${HUB}/llm/ui/`);
  });

  it("refuses a document without the llmKey header scheme rather than defaulting to Authorization", async () => {
    const { fetchImpl } = fetchAnswering(() => Response.json(documentStub({ components: {} })));
    await expect(discoverLlm(fetchImpl, EDGE, HUB)).rejects.toThrow(/llmKey/);
  });

  it("reports a failed fetch with its status", async () => {
    const { fetchImpl } = fetchAnswering(() => new Response("denied", { status: 403 }));
    await expect(discoverLlm(fetchImpl, EDGE, HUB)).rejects.toThrow(/403/);
  });
});

describe("mintKey", () => {
  const SERVICE = `${EDGE}${HUB}/llm/`;
  const now = new Date("2026-09-15T10:20:30.456Z");

  it("POSTs a dated key alias with a 30-day duration to keys and returns the key", async () => {
    const { calls, fetchImpl } = fetchAnswering(() =>
      Response.json({ key: "sk-new", key_alias: "a", expires: null }),
    );
    expect(await mintKey(fetchImpl, SERVICE, now)).toBe("sk-new");
    expect(calls[0]?.url).toBe(`${SERVICE}keys`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(Object.keys(calls[0]?.init?.headers ?? {})).not.toContain("authorization");
    // Exactly these two: no budget or limits are invented here.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      key_alias: "mesh-chat-2026-09-15T10:20:30.456Z",
      duration: "30d",
    });
  });

  it("names a key minted for someone in its alias, keeping the timestamp that makes it unique", async () => {
    const { calls, fetchImpl } = fetchAnswering(() => Response.json({ key: "sk-bob" }));
    expect(await mintKey(fetchImpl, SERVICE, now, "Bob Smith")).toBe("sk-bob");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      key_alias: "mesh-chat-Bob-Smith-2026-09-15T10:20:30.456Z",
      duration: "30d",
    });
  });

  it("keeps only safe characters of the name, and ignores a blank one", async () => {
    const { calls, fetchImpl } = fetchAnswering(() => Response.json({ key: "sk-x" }));
    await mintKey(fetchImpl, SERVICE, now, "  ../al ice@example.com/x ");
    await mintKey(fetchImpl, SERVICE, now, "   ");
    const aliases = calls.map((c) => JSON.parse(String(c.init?.body)).key_alias);
    expect(aliases).toEqual([
      "mesh-chat-al-ice-example.com-x-2026-09-15T10:20:30.456Z",
      "mesh-chat-2026-09-15T10:20:30.456Z",
    ]);
  });

  it("turns a 403 into a KeyRequestError that says an admin must do it", async () => {
    const { fetchImpl } = fetchAnswering(() => new Response("forbidden", { status: 403 }));
    const error = await mintKey(fetchImpl, SERVICE, now).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyRequestError);
    expect(error).toMatchObject({ status: 403 });
    expect(String((error as Error).message)).toMatch(/admin/);
  });

  it("reports any other failure, and a 2xx without a key", async () => {
    const failing = fetchAnswering(() => new Response('{"error":"x"}', { status: 502 }));
    await expect(mintKey(failing.fetchImpl, SERVICE, now)).rejects.toThrow(/502/);
    const keyless = fetchAnswering(() => Response.json({ key_alias: "a" }));
    await expect(mintKey(keyless.fetchImpl, SERVICE, now)).rejects.toThrow(/no key/);
  });
});

describe("keyShareText", () => {
  it("carries the key and the mesh page to paste it into, without the page's query or hash", () => {
    const text = keyShareText("sk-bob", "https://chat.test/mesh.html?join=secret#x");
    expect(text).toContain("sk-bob");
    expect(text).toContain("https://chat.test/mesh.html");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("#x");
    expect(text).toMatch(/30 days/);
  });
});

describe("the mesh view", () => {
  const images = { peerId: "p1", id: "images", kind: "openapi-service", title: "Images" };
  const llm = { peerId: HUB, id: "llm", kind: "openapi-service", title: "LLM" };
  const view = {
    self: "me",
    members: [
      { peerId: "other", roles: ["admin"] },
      { peerId: "me", roles: ["member"] },
    ],
    advertisements: [images, llm],
  };

  it("finds the llm openapi-service advert of the hub and nothing else", () => {
    expect(findLlmAdvert(view, HUB)?.peerId).toBe(HUB);
    expect(findLlmAdvert({ ...view, advertisements: [images] }, HUB)).toBeUndefined();
    expect(
      findLlmAdvert({ ...view, advertisements: [{ ...llm, kind: "images" }] }, HUB),
    ).toBeUndefined();
    expect(findLlmAdvert(null, HUB)).toBeUndefined();
  });

  it("ignores an llm advert from any peer but the hub, even when it comes first", () => {
    const rogue = { ...llm, peerId: "rogue-member" };
    expect(findLlmAdvert({ ...view, advertisements: [rogue] }, HUB)).toBeUndefined();
    expect(findLlmAdvert({ ...view, advertisements: [rogue, llm] }, HUB)).toBe(llm);
  });

  it("is admin only when this member's own roles carry admin", () => {
    expect(isMeshAdmin(view)).toBe(false);
    expect(isMeshAdmin({ ...view, self: "other" })).toBe(true);
    expect(isMeshAdmin({ ...view, self: "absent" })).toBe(false);
    expect(isMeshAdmin(null)).toBe(false);
  });
});

describe("meshConfig", () => {
  const service = { baseUrl: `${EDGE}${HUB}/llm/v1`, apiKeyHeader: "x-litellm-api-key" };

  it("writes the discovered endpoint with no key on a first run", () => {
    expect(meshConfig(null, service)).toEqual({ ...service, apiKey: "", models: [] });
  });

  it("keeps a stored key, models and default when re-discovering the same endpoint", () => {
    const stored: ChatConfig = {
      ...service,
      apiKey: "sk-kept",
      models: ["fake"],
      defaultModel: "fake",
    };
    expect(meshConfig(stored, service)).toEqual(stored);
  });

  it("drops the stored key and the models when the endpoint changed: hub A's key never goes to hub B", () => {
    const stored: ChatConfig = {
      baseUrl: `${EDGE}other/llm/v1`,
      apiKey: "sk-kept",
      apiKeyHeader: "authorization",
      models: ["fake"],
      defaultModel: "fake",
    };
    expect(meshConfig(stored, service)).toEqual({ ...service, apiKey: "", models: [] });
  });
});

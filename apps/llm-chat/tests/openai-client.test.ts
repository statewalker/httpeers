import { describe, expect, it } from "vitest";
import {
  ChatHttpError,
  ChatNetworkError,
  ChatStreamError,
  describeError,
  listModels,
  requestHeaders,
  streamChat,
} from "../src/core/openai-client.js";
import { chunked, collect, deltaEvent, hangingSseResponse, sseResponse } from "./helpers.js";

const config = { baseUrl: "http://llm.test/v1", apiKey: "sk-test" };
const messages = [{ role: "user" as const, content: "hi" }];

/** A fetch that records what it was called with and answers with `respond`. */
function recordingFetch(respond: (init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const stream = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof streamChat>[0]> = {}) =>
  streamChat({ config, model: "m1", messages, fetchImpl, ...extra });

describe("streamChat", () => {
  it("yields deltas when events and lines straddle chunk boundaries", async () => {
    const text = `${deltaEvent("Hel")}${deltaEvent("lo")}data: [DONE]\n\n`;
    const { fetchImpl } = recordingFetch(() => sseResponse(chunked(text, 7)));
    expect(await collect(stream(fetchImpl))).toEqual(["Hel", "lo"]);
  });

  it("yields every delta when several events share one chunk", async () => {
    const text = `${deltaEvent("a")}${deltaEvent("b")}${deltaEvent("c")}`;
    const { fetchImpl } = recordingFetch(() => sseResponse([text]));
    expect(await collect(stream(fetchImpl))).toEqual(["a", "b", "c"]);
  });

  it("accepts CRLF line endings and ignores comments and other fields", async () => {
    const text = `: keep-alive\r\nevent: message\r\n${deltaEvent("x").replace(/\n/g, "\r\n")}`;
    const { fetchImpl } = recordingFetch(() => sseResponse([text]));
    expect(await collect(stream(fetchImpl))).toEqual(["x"]);
  });

  it("stops at [DONE] even if more data follows", async () => {
    const text = `${deltaEvent("a")}data: [DONE]\n\n${deltaEvent("late")}`;
    const { fetchImpl } = recordingFetch(() => sseResponse([text]));
    expect(await collect(stream(fetchImpl))).toEqual(["a"]);
  });

  it("turns an error event into ChatStreamError", async () => {
    const text = `${deltaEvent("a")}data: ${JSON.stringify({ error: { message: "quota" } })}\n\n`;
    const { fetchImpl } = recordingFetch(() => sseResponse([text]));
    await expect(collect(stream(fetchImpl))).rejects.toThrow(ChatStreamError);
    await expect(collect(stream(fetchImpl))).rejects.toThrow("quota");
  });

  it("POSTs model, messages and stream:true with a bearer key", async () => {
    const { calls, fetchImpl } = recordingFetch(() => sseResponse(["data: [DONE]\n\n"]));
    await collect(stream(fetchImpl));
    expect(calls[0]?.url).toBe("http://llm.test/v1/chat/completions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "m1",
      messages,
      stream: true,
    });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer sk-test" });
  });

  it("sends no Authorization header when the key is empty or absent", async () => {
    for (const apiKey of ["", undefined]) {
      const { calls, fetchImpl } = recordingFetch(() => sseResponse(["data: [DONE]\n\n"]));
      await collect(stream(fetchImpl, { config: { baseUrl: config.baseUrl, apiKey } }));
      expect(Object.keys(calls[0]?.init?.headers ?? {})).not.toContain("authorization");
    }
  });

  it("maps 401 to ChatHttpError with an API key hint", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("bad key", { status: 401 }));
    const error = await collect(stream(fetchImpl)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatHttpError);
    expect(describeError(error)).toEqual({
      message: "HTTP 401: bad key",
      hint: "Check the API key.",
    });
  });

  it("maps a 502 mesh error body to a hub hint naming the kind", async () => {
    const body = JSON.stringify({ error: "no answer", kind: "request-timeout", peerId: "p" });
    const { fetchImpl } = recordingFetch(() => new Response(body, { status: 502 }));
    const error = await collect(stream(fetchImpl)).catch((e: unknown) => e);
    expect(describeError(error).hint).toBe(
      "The mesh peer or hub is unreachable (request-timeout).",
    );
  });

  it("maps a rejected fetch to ChatNetworkError with a CORS hint", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const error = await collect(stream(fetchImpl)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatNetworkError);
    expect(describeError(error).hint).toMatch(/cross-origin/);
  });

  it("rejects with AbortError when aborted mid-stream", async () => {
    const controller = new AbortController();
    const { fetchImpl } = recordingFetch((init) =>
      hangingSseResponse(deltaEvent("a"), init?.signal),
    );
    const seen: string[] = [];
    const run = (async () => {
      for await (const delta of stream(fetchImpl, { signal: controller.signal })) {
        seen.push(delta);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["a"]);
  });
});

describe("the key header", () => {
  const LITELLM = "x-litellm-api-key";

  it("defaults to Authorization with a bearer key", () => {
    expect(requestHeaders(config, false)).toEqual({ authorization: "Bearer sk-test" });
    expect(requestHeaders({ ...config, apiKeyHeader: undefined }, true)).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-test",
    });
  });

  it("sends a bearer key in a configured header and leaves Authorization unset", () => {
    const headers = requestHeaders({ ...config, apiKeyHeader: LITELLM }, true);
    expect(headers).toEqual({ "content-type": "application/json", [LITELLM]: "Bearer sk-test" });
    expect(Object.keys(headers)).not.toContain("authorization");
  });

  it("sends no key header at all when the key is empty, whatever the header", () => {
    expect(
      requestHeaders({ baseUrl: config.baseUrl, apiKey: "", apiKeyHeader: LITELLM }, false),
    ).toEqual({});
  });

  it("listModels uses the configured header", async () => {
    const body = JSON.stringify({ data: [{ id: "a" }] });
    const { calls, fetchImpl } = recordingFetch(() => new Response(body, { status: 200 }));
    await listModels({ ...config, apiKeyHeader: LITELLM }, { fetchImpl });
    expect(calls[0]?.init?.headers).toEqual({ [LITELLM]: "Bearer sk-test" });
  });

  it("streamChat uses the configured header", async () => {
    const { calls, fetchImpl } = recordingFetch(() => sseResponse(["data: [DONE]\n\n"]));
    await collect(stream(fetchImpl, { config: { ...config, apiKeyHeader: LITELLM } }));
    expect(calls[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      [LITELLM]: "Bearer sk-test",
    });
  });
});

describe("listModels", () => {
  it("returns the sorted, unique model ids and sends the key", async () => {
    const body = JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { nope: 1 }] });
    const { calls, fetchImpl } = recordingFetch(() => new Response(body, { status: 200 }));
    expect(await listModels(config, { fetchImpl })).toEqual(["a", "b"]);
    expect(calls[0]?.url).toBe("http://llm.test/v1/models");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer sk-test" });
  });

  it("maps a 404 to ChatHttpError", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("", { status: 404 }));
    await expect(listModels(config, { fetchImpl })).rejects.toBeInstanceOf(ChatHttpError);
  });
});

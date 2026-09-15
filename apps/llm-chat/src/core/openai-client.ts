/**
 * The OpenAI-compatible HTTP client: `GET /models` and streamed `POST /chat/completions`.
 *
 * `Authorization` is sent ONLY when an API key is set. In mesh mode the key is empty on purpose:
 * the ServiceWorker edge adds the mesh token only to a request that has no `Authorization`, so a
 * header set here would replace the token and the hub would refuse the call.
 */

import type { ChatMessage } from "./sessions.js";

export interface EndpointConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface ClientOptions {
  signal?: AbortSignal;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
}

export class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly hint: string | undefined,
  ) {
    super(`HTTP ${status}${body === "" ? "" : `: ${body.slice(0, 300)}`}`);
    this.name = "ChatHttpError";
  }
}

export class ChatNetworkError extends Error {
  readonly hint = "The endpoint is unreachable, or it does not allow cross-origin requests.";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChatNetworkError";
  }
}

export class ChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStreamError";
  }
}

export interface ErrorNotice {
  message: string;
  hint?: string;
}

export function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

export function hintFor(status: number, body: string): string | undefined {
  if (status === 401 || status === 403) return "Check the API key.";
  if (status === 502 || status === 504) {
    try {
      const parsed = JSON.parse(body) as { kind?: unknown };
      if (typeof parsed.kind === "string") {
        return `The mesh peer or hub is unreachable (${parsed.kind}).`;
      }
    } catch {
      // Not a mesh error body.
    }
  }
  return undefined;
}

export function describeError(error: unknown): ErrorNotice {
  if (error instanceof ChatHttpError) return { message: error.message, hint: error.hint };
  if (error instanceof ChatNetworkError) return { message: error.message, hint: error.hint };
  return { message: error instanceof Error ? error.message : String(error) };
}

export function requestHeaders(config: EndpointConfig, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["content-type"] = "application/json";
  if (config.apiKey != null && config.apiKey !== "") {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

/** Wrapped, never passed bare: `window.fetch` called unbound throws "Illegal invocation". */
const platformFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

async function send(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ChatNetworkError(error);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ChatHttpError(response.status, body, hintFor(response.status, body));
  }
  return response;
}

export async function listModels(
  config: EndpointConfig,
  options: ClientOptions = {},
): Promise<string[]> {
  const response = await send(
    `${config.baseUrl}/models`,
    { headers: requestHeaders(config, false), signal: options.signal },
    options.fetchImpl ?? platformFetch,
  );
  const json = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (json.data ?? []).map((model) => model.id);
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))].sort();
}

/** The payload of every `data:` line, in order. A line may span chunks. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) {
        finished = true;
        buffer += "\n";
      }
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
  } finally {
    // Stopped early by the consumer: release the connection rather than leave it open.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type StreamEvent = {
  choices?: Array<{ delta?: { content?: unknown } }>;
  error?: string | { message?: string };
};

export interface StreamChatRequest extends ClientOptions {
  config: EndpointConfig;
  model: string;
  messages: readonly ChatMessage[];
}

/** Text deltas of a streamed completion. Always `stream: true`: see the spec's 30 s limit. */
export async function* streamChat(request: StreamChatRequest): AsyncGenerator<string> {
  const response = await send(
    `${request.config.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: requestHeaders(request.config, true),
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: true }),
      signal: request.signal,
    },
    request.fetchImpl ?? platformFetch,
  );
  if (response.body == null) throw new ChatStreamError("The response has no body.");
  for await (const data of sseData(response.body)) {
    if (data === "[DONE]") return;
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      continue;
    }
    if (event.error != null) {
      const { error } = event;
      throw new ChatStreamError(
        typeof error === "string" ? error : (error.message ?? JSON.stringify(error)),
      );
    }
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta !== "") yield delta;
  }
}

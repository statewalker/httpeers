/**
 * The externally-fetched connection document: parsing, resolution against what the user saved,
 * and fetching. Pure — no React, no network beyond the injected `fetch`.
 *
 * Resolution order: built-in defaults < the fetched document < what the user saved. The saved
 * value wins, so a user who typed an endpoint by hand never has it silently replaced on the next
 * load. A document that should override is applied through `applyEndpoint` and then saved by the
 * caller (Task 9/10), becoming the user's value rather than fighting it every load.
 */

import { applyEndpoint, type ChatConfig } from "./config.js";

export interface ExternalConfig {
  schemaVersion: 1;
  /** No trailing slash, e.g. "https://hub.example/v1". http: or https: only. */
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  defaultModel?: string;
  label?: string;
}

const SUPPORTED_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses and validates an untrusted document into an {@link ExternalConfig}. */
export function parseExternalConfig(value: unknown): ExternalConfig {
  if (!isRecord(value)) {
    throw new Error("external config: expected a JSON object");
  }

  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `external config: unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}, expected ${SUPPORTED_SCHEMA_VERSION}`,
    );
  }

  if (typeof value.baseUrl !== "string" || value.baseUrl.trim() === "") {
    throw new Error("external config: missing or empty baseUrl");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.baseUrl);
  } catch {
    throw new Error(`external config: baseUrl is not a valid URL: ${value.baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`external config: baseUrl must be http: or https:, got ${parsed.protocol}`);
  }

  const baseUrl = value.baseUrl.trim().replace(/\/+$/, "");

  const external: ExternalConfig = { schemaVersion: SUPPORTED_SCHEMA_VERSION, baseUrl };

  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== "string")
      throw new Error("external config: apiKey must be a string");
    external.apiKey = value.apiKey;
  }
  if (value.apiKeyHeader !== undefined) {
    if (typeof value.apiKeyHeader !== "string")
      throw new Error("external config: apiKeyHeader must be a string");
    external.apiKeyHeader = value.apiKeyHeader;
  }
  if (value.defaultModel !== undefined) {
    if (typeof value.defaultModel !== "string")
      throw new Error("external config: defaultModel must be a string");
    external.defaultModel = value.defaultModel;
  }
  if (value.label !== undefined) {
    if (typeof value.label !== "string") throw new Error("external config: label must be a string");
    external.label = value.label;
  }

  return external;
}

export interface ResolveConfigInput {
  saved: ChatConfig | null;
  external: ExternalConfig | null;
}

export interface ResolveConfigResult {
  config: ChatConfig | null;
  source: "saved" | "external" | "none";
}

/** Resolves the config to use: the saved value wins, then the external document, then none. */
export function resolveConfig(input: ResolveConfigInput): ResolveConfigResult {
  if (input.saved != null) return { config: input.saved, source: "saved" };
  if (input.external != null) {
    return { config: applyEndpoint(null, input.external), source: "external" };
  }
  return { config: null, source: "none" };
}

/**
 * Fetches and parses an external config document. Rejects a non-2xx response, and rejects a
 * non-JSON body right where the parse fails — without dumping the whole body into the error — so
 * a static host's 200-with-an-HTML-index never reaches JSON parsing or a half-populated config.
 */
export async function fetchExternalConfig(
  url: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<ExternalConfig> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new Error(
      `external config: failed to fetch ${url}: ${(cause as Error).message ?? cause}`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(`external config: ${url} responded with status ${response.status}`);
  }

  const body = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`external config: ${url} did not return JSON`);
  }

  return parseExternalConfig(json);
}

/**
 * The endpoint a chat talks to, and the async store it lives behind.
 *
 * One config per page: the standalone page and the mesh page keep separate configs, so joining a
 * mesh never overwrites an endpoint typed by hand.
 */

export interface ChatConfig {
  /** No trailing slash, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  /** Empty or absent: no Authorization header is sent. */
  apiKey?: string;
  /** The last list fetched from `GET {baseUrl}/models`. */
  models: string[];
  defaultModel?: string;
}

export interface ConfigStore {
  get(): Promise<ChatConfig | null>;
  set(config: ChatConfig): Promise<void>;
  clear(): Promise<void>;
}

export type StartupStep = "settings" | "models" | "chat";

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Which screen a page load starts on. */
export function startupStep(config: ChatConfig | null): StartupStep {
  if (config == null || config.baseUrl === "") return "settings";
  if (config.models.length === 0) return "models";
  return "chat";
}

/**
 * Apply what the settings dialog saved. A different base URL clears the model list and the
 * default, because both belonged to the old endpoint.
 */
export function applyEndpoint(
  previous: ChatConfig | null,
  endpoint: { baseUrl: string; apiKey?: string },
): ChatConfig {
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  const apiKey = endpoint.apiKey?.trim() ?? "";
  if (previous != null && previous.baseUrl === baseUrl) return { ...previous, apiKey };
  return { baseUrl, apiKey, models: [] };
}

/** Apply what the model dialog picked. A typed-in id joins the list. */
export function applyModels(previous: ChatConfig, models: string[], chosen: string): ChatConfig {
  return { ...previous, models: [...new Set([...models, chosen])], defaultModel: chosen };
}

/** Apply a refreshed list: keep the default when it survived, otherwise take the first. */
export function refreshModels(previous: ChatConfig, fetched: string[]): ChatConfig {
  if (fetched.length === 0) return previous;
  const keep = previous.defaultModel != null && fetched.includes(previous.defaultModel);
  return { ...previous, models: fetched, defaultModel: keep ? previous.defaultModel : fetched[0] };
}

/** The session's model while the endpoint still lists it; otherwise the default. */
export function resolveModel(
  config: ChatConfig | null,
  sessionModel: string | undefined,
): string | undefined {
  if (config == null) return undefined;
  if (sessionModel != null && config.models.includes(sessionModel)) return sessionModel;
  return config.defaultModel ?? config.models[0];
}

export function memoryConfigStore(initial: ChatConfig | null = null): ConfigStore {
  let value = initial == null ? null : structuredClone(initial);
  return {
    async get() {
      return value == null ? null : structuredClone(value);
    },
    async set(config) {
      value = structuredClone(config);
    },
    async clear() {
      value = null;
    },
  };
}

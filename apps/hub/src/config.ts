/**
 * The daemon's settings, from the environment.
 *
 * A FUNCTION OF ITS ARGUMENT, never of `process.env` directly, so a test (and
 * an in-process caller such as the UI test) builds a config without touching
 * the process's environment.
 *
 * AN EMPTY VALUE IS UNSET. Compose passes `FOO=` through as an empty string
 * when `.env` leaves a variable blank; treating that as a value would turn a
 * missing setting into an empty data directory or an empty master key.
 */

export interface HubConfig {
  /** The data root; the hub owns `<dataDir>/hub`. */
  dataDir: string;
  /** URL of the relay document `{ relayAddrs: string[] }`. */
  relayDoc: string;
  /** Enabled service modules, by id (`HUB_SERVICES`, comma-separated). */
  services: string[];
  /** The page an invitation link opens. */
  joinPageUrl: string;
  /** The local door's port. `0` picks a free one (tests). */
  localDoorPort: number;
  /**
   * The address the local door binds (`HUB_LOCAL_DOOR_HOST`). `0.0.0.0` is right
   * on a compose bridge network, where the proxy reaches it from another
   * container. A HOST-networked hub must set `127.0.0.1`: there `0.0.0.0` puts
   * the unauthenticated door on every host interface.
   */
  localDoorHost: string;
  llmUpstream?: string;
  litellmMasterKey?: string;
}

export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_RELAY_DOC = "https://relay.httpeers.net/.well-known/httpeers-relay.json";
export const DEFAULT_JOIN_PAGE_URL = "https://llm-chat.httpeers.net/mesh.html";
export const DEFAULT_LOCAL_DOOR_PORT = 8787;
export const DEFAULT_LOCAL_DOOR_HOST = "0.0.0.0";

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value == null || value === "" ? undefined : value;
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = setting(env, name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value > 65_535) {
    throw new Error(`config: ${name} must be a port number (0-65535), got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): HubConfig {
  const llmUpstream = setting(env, "HUB_LLM_UPSTREAM");
  const litellmMasterKey = setting(env, "LITELLM_MASTER_KEY");
  return {
    dataDir: setting(env, "HUB_DATA_DIR") ?? DEFAULT_DATA_DIR,
    relayDoc: setting(env, "HUB_RELAY_DOC") ?? DEFAULT_RELAY_DOC,
    services: (setting(env, "HUB_SERVICES") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
    joinPageUrl: setting(env, "HUB_JOIN_PAGE_URL") ?? DEFAULT_JOIN_PAGE_URL,
    localDoorPort: port(env, "HUB_LOCAL_DOOR_PORT", DEFAULT_LOCAL_DOOR_PORT),
    localDoorHost: setting(env, "HUB_LOCAL_DOOR_HOST") ?? DEFAULT_LOCAL_DOOR_HOST,
    ...(llmUpstream != null ? { llmUpstream } : {}),
    ...(litellmMasterKey != null ? { litellmMasterKey } : {}),
  };
}

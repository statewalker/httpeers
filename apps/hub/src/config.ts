/**
 * The daemon's settings, from the environment.
 *
 * A FUNCTION OF ITS ARGUMENT, never of `process.env` directly, so a test (and
 * an in-process caller such as the UI test) builds a config without touching
 * the process's environment.
 *
 * AN EMPTY VALUE IS UNSET. Compose passes `FOO=` through as an empty string
 * when `.env` leaves a variable blank; treating that as a value would turn a
 * missing setting into an empty data directory, an empty master key, or an
 * empty door secret.
 */

import {
  type IceServer,
  type MuxPerPeerOptions,
  parseIceServers,
} from "@statewalker/httpeers-libp2p";

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
   * the door on every host interface (still gated by the secret, but there is
   * no reason to offer it beyond loopback).
   */
  localDoorHost: string;
  /**
   * `HUB_DOOR_SECRET`: the value the reverse proxy puts in `x-hub-door-secret`
   * on every request it forwards. The door refuses every request without it,
   * and `startDaemon` refuses to start when it is unset -- being on a bridge
   * network is no protection, the host routes to bridge addresses.
   */
  doorSecret?: string;
  /**
   * `HUB_DOOR_ALLOWED_HOSTS` (comma-separated `host:port`): the `Host` values
   * the door answers. The proxy passes the client's own Host through, so this
   * names the address a browser uses to reach the proxy; any other Host (a
   * DNS-rebound name, a bridge IP) is refused.
   */
  doorAllowedHosts: string[];
  /**
   * `HUB_MAX_RESERVATIONS`: how many members may hold a relay reservation on
   * this hub at once (default `HUB_MAX_RESERVATIONS` from
   * `@statewalker/httpeers-libp2p`, 4096). A member that cannot reserve cannot
   * join, so this must exceed the members connected at any one time. It sizes
   * the reservation store only; it does not change how much data a circuit
   * through the hub may carry.
   */
  maxReservations?: number;
  /**
   * `HUB_ICE_SERVERS` (comma-separated `stun:`/`stuns:` URLs, or `none`; TURN
   * is refused, it needs credentials a URL list cannot carry): the
   * STUN/TURN servers the hub's WebRTC transport gathers candidates from when
   * a member upgrades to a direct connection. Unset keeps `@libp2p/webrtc`'s
   * public default. `stun:stun.httpeers.net:3478,stun:stun.l.google.com:19302`
   * is the mesh's own server with one public fallback (deploy/README.md, "The
   * STUN server").
   */
  iceServers?: IceServer[];
  /**
   * `HUB_MUX_PER_PEER` (`true`/`false`, also `1`/`0`, `yes`/`no`, `on`/`off`;
   * default off): EXPERIMENTAL (#56). The hub's `servePeer` serves the
   * one-mux-per-peer protocol beside the per-exchange one, and its own calls
   * (forwarding) use it. Members without the flag are unaffected: they keep
   * one stream per exchange. `HUB_MUX_WINDOW` (bytes, at least
   * {@link MIN_MUX_WINDOW}) sets the per-exchange window, else the library's
   * default (`DEFAULT_MUX_WINDOW`, 256 KiB); it is refused without the flag.
   * Absent when off.
   */
  muxPerPeer?: MuxPerPeerOptions;
  llmUpstream?: string;
  litellmMasterKey?: string;
}

export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_RELAY_DOC = "https://relay.httpeers.net/.well-known/httpeers-relay.json";
export const DEFAULT_JOIN_PAGE_URL = "https://llm-chat.httpeers.net/mesh.html";
export const DEFAULT_LOCAL_DOOR_PORT = 8787;
export const DEFAULT_LOCAL_DOOR_HOST = "0.0.0.0";
export const DEFAULT_DOOR_ALLOWED_HOSTS = ["127.0.0.1:8080", "localhost:8080"];
/**
 * The smallest `HUB_MUX_WINDOW`: 64 KiB, two of the mux's default frames. A
 * window much smaller than a frame still works, one message at a time, but
 * only by stalling every exchange on each round trip; it is never what an
 * operator means.
 */
export const MIN_MUX_WINDOW = 64 * 1024;

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value == null || value === "" ? undefined : value;
}

function list(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = setting(env, name);
  if (raw == null) return undefined;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 ? items : undefined;
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

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = setting(env, name);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`config: ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = setting(env, name);
  if (raw == null) return undefined;
  const value = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`config: ${name} must be true or false, got "${raw}"`);
}

function muxPerPeerOf(env: NodeJS.ProcessEnv): MuxPerPeerOptions | undefined {
  const on = flag(env, "HUB_MUX_PER_PEER") ?? false;
  const window = positiveInteger(env, "HUB_MUX_WINDOW");
  if (window != null && !on) {
    // A window for a path that is off would be silently ignored.
    throw new Error("config: HUB_MUX_WINDOW is set but HUB_MUX_PER_PEER is not on");
  }
  if (window != null && window < MIN_MUX_WINDOW) {
    throw new Error(
      `config: HUB_MUX_WINDOW must be at least ${MIN_MUX_WINDOW} bytes, got "${window}"`,
    );
  }
  if (!on) return undefined;
  return window != null ? { window } : {};
}

function iceServerList(env: NodeJS.ProcessEnv, name: string): IceServer[] | undefined {
  try {
    return parseIceServers(setting(env, name));
  } catch (error) {
    throw new Error(`config: ${name}: ${(error as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): HubConfig {
  const llmUpstream = setting(env, "HUB_LLM_UPSTREAM");
  const litellmMasterKey = setting(env, "LITELLM_MASTER_KEY");
  const doorSecret = setting(env, "HUB_DOOR_SECRET");
  const maxReservations = positiveInteger(env, "HUB_MAX_RESERVATIONS");
  const iceServers = iceServerList(env, "HUB_ICE_SERVERS");
  const muxPerPeer = muxPerPeerOf(env);
  return {
    dataDir: setting(env, "HUB_DATA_DIR") ?? DEFAULT_DATA_DIR,
    relayDoc: setting(env, "HUB_RELAY_DOC") ?? DEFAULT_RELAY_DOC,
    services: list(env, "HUB_SERVICES") ?? [],
    joinPageUrl: setting(env, "HUB_JOIN_PAGE_URL") ?? DEFAULT_JOIN_PAGE_URL,
    localDoorPort: port(env, "HUB_LOCAL_DOOR_PORT", DEFAULT_LOCAL_DOOR_PORT),
    localDoorHost: setting(env, "HUB_LOCAL_DOOR_HOST") ?? DEFAULT_LOCAL_DOOR_HOST,
    doorAllowedHosts: list(env, "HUB_DOOR_ALLOWED_HOSTS") ?? [...DEFAULT_DOOR_ALLOWED_HOSTS],
    ...(doorSecret != null ? { doorSecret } : {}),
    ...(maxReservations != null ? { maxReservations } : {}),
    ...(iceServers != null ? { iceServers } : {}),
    ...(muxPerPeer != null ? { muxPerPeer } : {}),
    ...(llmUpstream != null ? { llmUpstream } : {}),
    ...(litellmMasterKey != null ? { litellmMasterKey } : {}),
  };
}

/**
 * What a test needs to talk to a real local door the way the reverse proxy
 * does: the secret header, and a `Host` the door allows.
 *
 * `fetch` cannot set `Host` (undici sends the connection's own), so a test
 * cannot pretend to be `127.0.0.1:8080`. Instead it picks the door's port up
 * front and allows exactly `127.0.0.1:<that port>`.
 */

import { once } from "node:events";
import { createServer } from "node:net";

export const TEST_DOOR_SECRET = "test-door-secret-0123456789abcdef";

/** A port that was free a moment ago: bind 0, read it, release it. */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The door settings of a `HubConfig` for a door on `127.0.0.1:<port>`. */
export function doorSettings(port: number) {
  return {
    localDoorPort: port,
    localDoorHost: "127.0.0.1",
    doorSecret: TEST_DOOR_SECRET,
    doorAllowedHosts: [`127.0.0.1:${port}`],
  };
}

/** `fetch`, with the secret header the proxy would add. */
export function doorFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-hub-door-secret", TEST_DOOR_SECRET);
  return fetch(url, { ...init, headers });
}

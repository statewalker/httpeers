/**
 * The relay's listen addresses and its announce addresses, which behind a
 * reverse proxy are NOT the same thing.
 *
 * WHY THIS MODULE EXISTS AT ALL. When the relay terminated TLS itself, it
 * listened on `/ip4/0.0.0.0/tcp/443/tls/ws` and that same string was what
 * peers dialled -- one address, no distinction to draw. Behind Caddy the two
 * diverge completely:
 *
 *   listens on   /ip4/0.0.0.0/tcp/9090/ws          (plain, inside the network)
 *   dialled at   /dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/<peerId>
 *
 * libp2p advertises what it LISTENS on unless told otherwise, so without an
 * explicit announce list this relay would publish a container-internal
 * address, every peer would fail to connect, and the symptom -- "peers cannot
 * reach the relay" -- would point at the relay's health rather than at its
 * advertised address. That is the single most expensive way this deployment
 * can break, which is why the address list is a module with tests rather than
 * an inline array.
 *
 * `/tls/ws` NOT `/wss`. Verified against the installed `@libp2p/websockets`
 * 10.1.19, whose own documented example reads
 * `multiaddr('/dns4/example.com/tcp/9090/tls/ws')`. `/wss` is the legacy
 * shorthand; do not "modernise" this to it.
 */
import { multiaddr } from "@multiformats/multiaddr";

/** Matches the httpeers-stack design's `/ip4/0.0.0.0/tcp/9090/ws` example. */
export const DEFAULT_RELAY_PORT = 9090;

/** The port a browser reaches the reverse proxy on. Not the port the relay binds. */
export const DEFAULT_PUBLIC_PORT = 443;

/**
 * What the relay actually binds: plain `ws` on all interfaces. TLS is the
 * reverse proxy's job, so there is no `tls` variant of this.
 */
export function listenAddrs(port: number = DEFAULT_RELAY_PORT): string[] {
  return [`/ip4/0.0.0.0/tcp/${port}/ws`];
}

/**
 * The address a peer outside the network dials, for a relay published at
 * `host` behind a TLS-terminating proxy. Carries no `/p2p/` component -- see
 * `assertAnnounceAddr`.
 */
export function publicAnnounceAddr(host: string, port: number = DEFAULT_PUBLIC_PORT): string {
  return `/dns4/${host}/tcp/${port}/tls/ws`;
}

/**
 * Rejects an announce address libp2p would either fail on or silently
 * mangle. Both checks earn their place:
 *
 * - **Unparseable** -- libp2p throws deep inside address-manager
 *   initialisation, far from the environment variable that caused it.
 * - **Carries `/p2p/<id>`** -- libp2p appends the peer id itself when it
 *   reports addresses, so a hand-written one produces
 *   `/p2p/<id>/p2p/<id>`. This is the likely mistake, because the address an
 *   operator copies out of the logs or out of `httpeers.json` DOES include
 *   the peer id, and pasting it here looks obviously right.
 */
export function assertAnnounceAddr(addr: string): void {
  if (addr.includes("/p2p/")) {
    throw new Error(
      `relay: announce address "${addr}" must not contain a /p2p/ component -- ` +
        "libp2p appends the peer id itself, so including it here yields /p2p/<id>/p2p/<id>. " +
        "Drop everything from /p2p/ onwards.",
    );
  }
  try {
    multiaddr(addr);
  } catch (err) {
    throw new Error(
      `relay: announce address "${addr}" is not a valid multiaddr: ${(err as Error).message}`,
    );
  }
}

/**
 * Parses `RELAY_ANNOUNCE_ADDRS` -- a comma-separated multiaddr list.
 *
 * An empty or absent value yields `[]`, which is correct for local runs where
 * the listen address IS reachable. It is wrong for the deployment, and
 * `main.ts` is where that is enforced, because only the entrypoint knows
 * whether it is in production.
 */
export function parseAnnounceAddrs(raw: string | undefined): string[] {
  if (raw == null) return [];
  const addrs = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const addr of addrs) assertAnnounceAddr(addr);
  return addrs;
}

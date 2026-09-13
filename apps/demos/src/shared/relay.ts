/**
 * Where this deployment's relay is.
 *
 * THE RELAY PUBLISHES ITS OWN ADDRESS, at
 * `https://relay.httpeers.net/.well-known/httpeers-relay.json`, with
 * `Access-Control-Allow-Origin: *`. So a page asks the relay rather than
 * carrying a build-time copy, and there is no per-site `httpeers.json` to
 * generate and keep in step — which is what the sandbox had to do.
 *
 * This is deployment policy, not library behaviour, which is why it lives in
 * the app: another deployment might hard-code an address or read it from a
 * query parameter, and `httpeers-member` should not have an opinion.
 */

/** The document the relay serves. Its own `RelayDocument`, restated so this app does not depend on the relay package. */
interface RelayDocument {
  relayAddrs?: unknown;
}

/** Default for a deployed page; overridden in local development. */
export const DEFAULT_RELAY_DOC_URL = "https://relay.httpeers.net/.well-known/httpeers-relay.json";

export class RelayUnavailableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `Could not read the relay's address from ${url}. Without it this page cannot reach the ` +
        "mesh at all. The relay may be down, or this deployment may not have been bootstrapped.",
      { cause },
    );
    this.name = "RelayUnavailableError";
  }
}

/**
 * The relay's dialable addresses.
 *
 * Throws rather than returning empty: a page with no relay cannot do anything,
 * and saying so plainly beats a mesh that silently never connects.
 */
export async function readRelayAddrs(url = DEFAULT_RELAY_DOC_URL): Promise<string[]> {
  let doc: RelayDocument;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    doc = (await res.json()) as RelayDocument;
  } catch (cause) {
    throw new RelayUnavailableError(url, cause);
  }

  const addrs = doc.relayAddrs;
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new RelayUnavailableError(url, new Error("the document carries no relayAddrs"));
  }
  return addrs.filter((a): a is string => typeof a === "string" && a !== "");
}

/**
 * Is this page talking to a loopback relay?
 *
 * Decided from the ADDRESS BEING DIALLED, never from the page's own hostname.
 * libp2p's browser gater refuses loopback and private dials, and a page served
 * from `192.168.1.5` dialling a loopback relay is still a development setup --
 * the hostname test would call it production and every dial would be denied
 * with an error blaming the relay.
 */
export function needsPermissiveGater(addrs: readonly string[]): boolean {
  return addrs.some(
    (addr) =>
      /\/ip4\/127\./.test(addr) ||
      /\/ip4\/10\./.test(addr) ||
      /\/ip4\/192\.168\./.test(addr) ||
      /\/dns4?\/localhost(\/|$)/.test(addr),
  );
}

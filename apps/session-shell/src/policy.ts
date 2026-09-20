/**
 * The session shell's contract, in one place: which names are sessions, who
 * may drive one, and what its worker leaves alone.
 *
 * THREE PARTIES READ THIS MODULE. The relay page (`relay.ts`) checks who is
 * handing it a port; the worker (`sw.ts`) decides what to route and which
 * navigations to serve; a ghost app (`client.ts`) builds session names and
 * origins. Keeping the rules here means the page that enforces a rule and the
 * app that relies on it cannot disagree about it.
 *
 * WHAT A SESSION IS. `<name>.p.httpeers.net` -- every name serves the same
 * static files, and each name is its own ORIGIN, so its storage, cookies and
 * ServiceWorker are its own. A ghost app on `*.httpeers.net` frames the
 * session's `relay.html`, hands it a MessagePort, and from then on every
 * request inside that origin -- `index.html` included -- is answered over the
 * port.
 *
 * THE NAME IS NOT A SECRET. It travels through DNS resolvers, `Referer`
 * headers, history and logs. Nothing here treats knowing a name as authority:
 * authority is the port, and what the ghost's handler lets through it.
 */

/** The zone every session lives under. One wildcard certificate covers it. */
export const SESSION_ZONE = "p.httpeers.net";

/** The registrable domain the ghost apps are published on. */
export const GHOST_ZONE = "httpeers.net";

/** The page a ghost app frames to connect. The user-facing URL of the contract. */
export const RELAY_PATH = "/relay.html";

/** The worker. At the root, because a worker's scope cannot exceed its own directory. */
export const WORKER_PATH = "/relay-sw.js";

/** The shell's own assets. Never routed to the app. */
export const SHELL_PREFIX = "/_shell/";

/**
 * The name a session's app registers under when nobody chooses one.
 *
 * A DEFAULT, NOT A LIMIT. Since `webrun-http-browser` 0.6.0 a service claims a
 * path prefix, so a session serves as many services as its app registers --
 * the app at the root, the mesh under `MESH_PREFIX`. This is only the key the
 * root app takes when the caller gives none.
 */
export const DEFAULT_SERVICE_KEY = "session";

/**
 * The mesh's namespace inside a session, reserved.
 *
 * The same shape the member edge serves (`/{edgeKey}/{peerId}/{path}`), so an
 * app written against a member origin runs unchanged in a session. The cost is
 * that an app can never own a path under `/peers/`; it is documented in the
 * README beside `/_shell/` and `/relay.html`.
 */
export const MESH_PREFIX = "/peers/";

/** The session's app, mounted at the origin root. */
export const APP_SERVICE_KEY = "app";

/** The mesh, mounted at `MESH_PREFIX`. */
export const MESH_SERVICE_KEY = "mesh";

/**
 * Every service key a session will accept -- an ALLOWLIST, and the reason is
 * the mount table.
 *
 * `takeover: "first-wins"` defends a key that is already held; it says nothing
 * about a key nobody asked for. Any `*.httpeers.net` page may frame this
 * relay, and the name of a session is not a secret, so without this a second
 * ghost could register a key of its own -- `evil` at `/index.html` -- and beat
 * the app's root mount on longest-prefix, serving one page of the session
 * without ever taking the app's key from it.
 *
 * "Keys are the caller's" is the LIBRARY's rule, and right for a library. A
 * session is a host with a threat model, so it names its services. Adding one
 * is a one-line change here, which is the point: visible, rather than open.
 */
export const SESSION_SERVICE_KEYS: ReadonlySet<string> = new Set([
  APP_SERVICE_KEY,
  MESH_SERVICE_KEY,
  DEFAULT_SERVICE_KEY,
]);

/**
 * May the page at `clientUrl` register `key`? BOTH halves, or neither.
 *
 * The worker passes this to the relay's `canRegister`. It lives here, taking a
 * URL string rather than a `Client`, so the rule can be tested as arithmetic
 * instead of through a ServiceWorker -- the worker itself is a bundle with
 * top-level side effects and cannot be imported by a test.
 */
export function canRegisterService(clientUrl: string, key: string): boolean {
  if (!SESSION_SERVICE_KEYS.has(key)) return false;
  try {
    return new URL(clientUrl).pathname === RELAY_PATH;
  } catch {
    return false;
  }
}

/**
 * Who may frame a session. Also written in `deploy/Caddyfile` for the shell's
 * own files -- a test compares the two.
 *
 * `https://*.httpeers.net` INCLUDES OTHER SESSIONS, and CSP has no way to say
 * "except". That is why framing is not the only check: the relay page refuses
 * a port from another session (`isAllowedParentOrigin`) and the worker refuses
 * a navigation another session started (`navigationAllowed`).
 */
export const FRAME_ANCESTORS = `'self' https://${GHOST_ZONE} https://*.${GHOST_ZONE}`;

/** A lowercase DNS label: hostnames are case-insensitive, so a name must be too. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isSessionName(name: string): boolean {
  return LABEL.test(name);
}

/** `https://<name>.p.httpeers.net`. Throws on a name that is not one label. */
export function sessionOrigin(name: string, zone: string = SESSION_ZONE): string {
  if (!isSessionName(name)) throw new Error(`not a session name: ${JSON.stringify(name)}`);
  return `https://${name}.${zone}`;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * 26 characters of base32: 130 bits, lowercase, one label.
 *
 * Base32 rather than base64 because DNS folds case -- `aB` and `ab` are the
 * same host, so a case-sensitive alphabet would silently lose a bit per
 * character. Not a secret (see the module comment); the length is there so
 * two ghost apps never pick the same origin by accident.
 */
export function randomSessionName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * May a page on `origin` hand this session its port?
 *
 * A ghost app lives on `httpeers.net` or ONE label under it, over HTTPS on the
 * default port. Anything else is refused -- and specifically `*.p.httpeers.net`:
 * another session is exactly the party that must not be able to drive this
 * one, and it is the party a naive `endsWith(".httpeers.net")` lets in.
 *
 * `selfHostname` is where the shell itself is served. Only a shell on
 * localhost -- a developer's machine, never production -- accepts localhost
 * parents, so a local build is testable end to end without widening the
 * deployed rule.
 */
export function isAllowedParentOrigin(origin: string, selfHostname: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false; // a path, credentials, or an opaque "null"

  if (isLocalHost(selfHostname)) {
    return (url.protocol === "http:" || url.protocol === "https:") && isLocalHost(url.hostname);
  }

  if (url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname;
  if (host === GHOST_ZONE) return true;
  if (!host.endsWith(`.${GHOST_ZONE}`)) return false;
  const label = host.slice(0, -(GHOST_ZONE.length + 1));
  // ONE label, and not the session zone's own: `p.httpeers.net` is not an app
  // and `x.p.httpeers.net` is another session.
  return LABEL.test(label) && `${label}.${GHOST_ZONE}` !== SESSION_ZONE;
}

/**
 * Should the worker serve a navigation that arrived with this `Referer`?
 *
 * Framing is policed by `frame-ancestors`, but a worker-made response carries
 * only the headers the worker gives it, and CSP cannot exclude another
 * session (see `FRAME_ANCESTORS`). The referrer closes both gaps: it is set by
 * the browser, so a page can WITHHOLD it but cannot forge it -- which is why a
 * missing referrer is a refusal rather than a pass.
 *
 * Allowed: the session itself (a link inside the app) and a ghost-app origin
 * (the iframe's `src`). Refused: everything else, including a top-level visit
 * typed or pasted with no referrer, and a form posted from a foreign site --
 * the cross-site request an app behind this origin would otherwise receive
 * with the viewer's credentials attached.
 */
export function navigationAllowed(referrer: string, selfOrigin: string): boolean {
  if (referrer === "") return false;
  let from: URL;
  try {
    from = new URL(referrer);
  } catch {
    return false;
  }
  if (from.origin === selfOrigin) return true;
  return isAllowedParentOrigin(from.origin, new URL(selfOrigin).hostname);
}

/** The shell's own files: fetched from the network, never answered by the app. */
export function isShellPath(pathname: string): boolean {
  return pathname === RELAY_PATH || pathname === WORKER_PATH || pathname.startsWith(SHELL_PREFIX);
}

/** The frame-ancestors source list for a shell served on `hostname`. */
export function frameAncestorsFor(hostname: string): string {
  return isLocalHost(hostname) ? `'self' http://localhost:* http://127.0.0.1:*` : FRAME_ANCESTORS;
}

/**
 * Stamp `frame-ancestors` onto a response the worker made.
 *
 * APPENDED AS A SEPARATE POLICY, never merged into the app's own: a browser
 * enforces every policy it is given, so the app keeps whatever CSP it chose
 * and gains this one. Rewriting the app's header instead would mean parsing
 * it, and a parser here is one more way to weaken it.
 */
export function withFrameAncestors(response: Response, sources: string): Response {
  const headers = new Headers(response.headers);
  headers.append("content-security-policy", `frame-ancestors ${sources}`);
  // A null-body status must be constructed with a null body, or `new
  // Response` throws -- and a 304 or 204 from the app is ordinary.
  const nullBody = [204, 205, 304].includes(response.status);
  return new Response(nullBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

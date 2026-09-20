/**
 * The ghost-app side: open a session origin and serve one or more services
 * into it.
 *
 * ```ts
 * const session = await openSession({
 *   services: [{ key: APP_SERVICE_KEY, path: "/", handler: serveApp }],
 * });
 * iframe.src = session.url("/");       // https://<random>.p.httpeers.net/
 * ```
 *
 * This is `webrun-http-browser`'s relay mode, and nothing more: the library's
 * `newRemoteRelayChannel` frames `relay.html` and hands it a port, and
 * `initHttpService` registers each service under its key, mounted at its
 * path. Since 0.6.0 a CONNECT reaches only the service its key names, so a
 * session serves as many services as its app registers, all over that one
 * connection -- an app at `/`, a mesh gateway at `MESH_PREFIX`. An app
 * mounted at `/` gets the origin root; `DEFAULT_SERVICE_KEY` is only the key
 * a single, unnamed service takes when a caller registers one and does not
 * choose a key for it.
 *
 * WHAT A SERVICE'S HANDLER LETS THROUGH IS THE WHOLE OF ITS AUTHORITY. The
 * session is a separate origin, so the app in it cannot touch the ghost app's
 * storage, DOM or ServiceWorker; it can only make requests, and every request
 * routed to a service lands at that service's handler. A handler that
 * forwards to one pinned peer (`httpeers-ghost`'s `pinnedPeer`) gives the app
 * that peer and nothing else.
 *
 * THE WHOLE KEY SPACE IS RESERVED, not only the keys the caller asked for --
 * see `reservedPlaceholders` for why and how.
 */

import { initHttpService, newRemoteRelayChannel } from "@statewalker/webrun-http-browser";
import {
  isSessionName,
  isShellPath,
  RELAY_PATH,
  randomSessionName,
  SESSION_SERVICE_KEYS,
  SHELL_PREFIX,
  sessionOrigin,
} from "./policy.js";

export {
  APP_SERVICE_KEY,
  DEFAULT_SERVICE_KEY,
  FRAME_ANCESTORS,
  isSessionName,
  MESH_PREFIX,
  MESH_SERVICE_KEY,
  RELAY_PATH,
  randomSessionName,
  SESSION_ZONE,
  sessionOrigin,
} from "./policy.js";

export interface SessionService {
  /** The service's name on the relay. The caller's to choose. */
  key: string;
  /** Where it is mounted in the session origin, e.g. `/` or `/peers/`. */
  path: string;
  handler: (request: Request) => Promise<Response>;
}

/**
 * The services a session will serve, checked.
 *
 * Two services under ONE key on one connection both install a matching CONNECT
 * listener and answer each other's calls. The library does not guard it, and
 * the failure looks like a corrupted response rather than a registration
 * error, so it is refused here where the caller can still read the message.
 */
export function servicesOf(services: SessionService[]): SessionService[] {
  if (services.length === 0) {
    throw new Error("a session needs at least one service; nothing would answer its origin");
  }
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.key)) {
      throw new Error(`two services with the same key ("${service.key}") on one session`);
    }
    seen.add(service.key);
    if (isShellPath(service.path) || service.path.startsWith(SHELL_PREFIX)) {
      throw new Error(`"${service.path}" is reserved by the session shell`);
    }
  }
  return services;
}

/** What a placeholder registration looks like: a key and a handler, deliberately no `path`. */
interface ReservedPlaceholder {
  key: string;
  handler: (request: Request) => Promise<Response>;
}

/** Answers every call a placeholder key ever receives. Nothing should reach this. */
async function refuseReservedKey(): Promise<Response> {
  return new Response("this key is reserved by the session shell", { status: 410 });
}

/**
 * A placeholder registration for every key in `keys` that `services` does not
 * use.
 *
 * A HELD KEY IS ONE A HOSTILE GHOST CANNOT TAKE. Any `*.httpeers.net` page may
 * frame this session's `relay.html` -- the session name is not a secret -- so
 * a second ghost is free to register a key this app never claimed. The
 * worker's `canRegisterService` closes the key space to `SESSION_SERVICE_KEYS`,
 * but not the path within it: `mayRegister` lets a candidate take an UNHELD
 * key regardless of `takeover`, and the registrant's own path then mounts and
 * can outrank the app's root on longest-prefix (`/index.html` beats `/`,
 * after normalisation). If this session registers only `app`, a second ghost
 * could take `mesh` at `/index.html` and serve the session's own index page.
 *
 * So `openSession` registers a live, refusing placeholder for every key it is
 * not otherwise using -- holding the key defeats `mayRegister`'s "unheld"
 * check the same way a real registration would, WITHOUT asking every caller
 * to remember to do it themselves. NO PATH: `initHttpService` mounts a
 * service only when given one; a path-less registration is reachable at
 * `/~<key>/` and nowhere else, so a placeholder can never compete with a real
 * mount. Cost of being wrong here is one extra registration per unused key,
 * on a connection that is already open.
 *
 * A pure function of the requested services and the allowlist, so the
 * reservation is testable without a browser -- `openSession` itself is not.
 */
export function reservedPlaceholders(
  services: SessionService[],
  keys: ReadonlySet<string>,
): ReservedPlaceholder[] {
  const used = new Set(services.map((service) => service.key));
  return [...keys]
    .filter((key) => !used.has(key))
    .map((key) => ({ key, handler: refuseReservedKey }));
}

export interface OpenSessionOptions {
  /** What this session serves, and where. */
  services: SessionService[];
  /** The session's name. Default: a fresh random one, i.e. a fresh origin. */
  name?: string;
  /**
   * Where the name lives. Default `https://<name>.p.httpeers.net`. A local
   * shell (`vite preview`) passes a function returning its own origin -- one
   * origin for every name, which exercises the protocol but not the isolation.
   */
  origin?: (name: string) => string;
  /** Where the hidden relay iframe goes. Default `document.body`. */
  container?: HTMLElement;
  /** How long the relay may take to accept the app. Default 20 s. */
  timeoutMs?: number;
}

export interface Session {
  name: string;
  /** `https://<name>.p.httpeers.net` -- no trailing slash. */
  origin: string;
  /** An absolute URL inside the session, for an iframe's `src`. */
  url(path?: string): string;
  /** Stop serving and remove the relay iframe. An iframe showing the session goes blank on its next request. */
  close(): void;
}

export async function openSession(options: OpenSessionOptions): Promise<Session> {
  const services = servicesOf(options.services);
  const name = options.name ?? randomSessionName();
  if (!isSessionName(name)) throw new Error(`not a session name: ${JSON.stringify(name)}`);
  const origin = (options.origin ?? sessionOrigin)(name);

  const connection = await newRemoteRelayChannel({
    baseUrl: new URL(`${origin}/`),
    url: new URL(RELAY_PATH, origin),
    container: options.container,
  });

  // A TIMEOUT, BECAUSE NOTHING ELSE WILL SAY NO. If the relay page is refused
  // -- a parent `frame-ancestors` rejects, a DNS failure, the relay's own
  // origin check -- the iframe still fires `load` and the REGISTER call below
  // simply never gets an answer.
  const timeoutMs = options.timeoutMs ?? 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stops: Array<() => void> = [];
  try {
    const [first, ...rest] = services;
    stops.push(
      await Promise.race([
        initHttpService(first.handler, { key: first.key, path: first.path, port: connection.port }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`the session relay at ${origin} did not answer in ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]),
    );

    // Once the first registration has answered, the relay is demonstrably
    // alive -- a second timeout would only add a way to fail.
    for (const service of rest) {
      stops.push(
        await initHttpService(service.handler, {
          key: service.key,
          path: service.path,
          port: connection.port,
        }),
      );
    }

    // RESERVE THE WHOLE KEY SPACE, not only the keys the caller asked for --
    // see `reservedPlaceholders`. Also unraced: the relay is already proven
    // alive by the registrations above.
    for (const placeholder of reservedPlaceholders(services, SESSION_SERVICE_KEYS)) {
      stops.push(
        await initHttpService(placeholder.handler, { key: placeholder.key, port: connection.port }),
      );
    }
  } catch (error) {
    for (const stop of stops) stop();
    connection.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    name,
    origin,
    url: (path = "/") => new URL(path, `${origin}/`).href,
    close() {
      for (const stop of stops) stop();
      connection.close();
    },
  };
}

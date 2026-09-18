/**
 * The ghost-app side: open a session origin and serve an app into it.
 *
 * ```ts
 * const session = await openSession({ handler: (request) => serveApp(request) });
 * iframe.src = session.url("/");       // https://<random>.p.httpeers.net/
 * ```
 *
 * This is `webrun-http-browser`'s relay mode, and nothing more: the library's
 * `newRemoteRelayChannel` frames `relay.html` and hands it a port, and
 * `initHttpService` registers `handler` as the session's one service. From
 * then on every request made inside the session origin -- its `index.html`
 * first -- arrives at `handler` as a `Request`.
 *
 * WHAT `handler` LETS THROUGH IS THE WHOLE OF THE SESSION'S AUTHORITY. The
 * session is a separate origin, so the app in it cannot touch the ghost app's
 * storage, DOM or ServiceWorker; it can only make requests, and every one of
 * them lands here. A handler that forwards to one pinned peer
 * (`httpeers-ghost`'s `pinnedPeer`) gives the app that peer and nothing else.
 */

import { initHttpService, newRemoteRelayChannel } from "@statewalker/webrun-http-browser";
import {
  isSessionName,
  RELAY_PATH,
  randomSessionName,
  SESSION_SERVICE_KEY,
  sessionOrigin,
} from "./policy.js";

export {
  FRAME_ANCESTORS,
  isSessionName,
  RELAY_PATH,
  randomSessionName,
  SESSION_SERVICE_KEY,
  SESSION_ZONE,
  sessionOrigin,
} from "./policy.js";

export interface OpenSessionOptions {
  /** Answers every request the session makes. */
  handler: (request: Request) => Promise<Response>;
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
  let stop: () => void;
  try {
    stop = await Promise.race([
      initHttpService(options.handler, { key: SESSION_SERVICE_KEY, port: connection.port }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`the session relay at ${origin} did not answer in ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
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
      stop();
      connection.close();
    },
  };
}

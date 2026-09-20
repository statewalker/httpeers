/**
 * A test ghost app: serves a three-file "app" into a session through the
 * shell's client, exactly as a real ghost app does, with no mesh behind it.
 * Driven by `scripts/browser-test.mjs`.
 *
 * TWO SERVICES OVER ONE CONNECTION, as every real caller now registers: the
 * app at the origin root and a stand-in for the mesh at `MESH_PREFIX`. The
 * mesh here is deliberately NOT a mesh -- its routing is proven in
 * `apps/demos`; what this fixture has to prove is that the shell sends a
 * request to the right one of two mounts, in a real browser, through a real
 * ServiceWorker. So the stand-in answers with the service that got the
 * request, and with the body that arrived.
 */
import {
  APP_SERVICE_KEY,
  MESH_PREFIX,
  MESH_SERVICE_KEY,
  openSession,
  type Session,
} from "../../src/client.js";

const APP_HTML =
  '<!doctype html><meta charset="utf-8"><title>test app</title>' +
  // ROOT-ABSOLUTE on purpose: inside a session, `/app.js` is the session's own,
  // which is the escape a same-origin ghost iframe could not contain.
  '<h1 id="hello">hello from the app</h1><script src="/app.js"></script>';

const APP_JS = `
  document.body.insertAdjacentHTML("beforeend", '<p id="where">' + location.origin + '</p>');
  fetch("/api/echo?x=1", { method: "POST", body: "ping" })
    .then((r) => r.text())
    .then((t) => document.body.insertAdjacentHTML("beforeend", '<p id="api">' + t + "</p>"));
`;

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname === "/app.js") {
    return new Response(APP_JS, { headers: { "content-type": "text/javascript" } });
  }
  if (url.pathname === "/api/echo") {
    return new Response(`echo ${request.method} ${url.search} ${await request.text()}`);
  }
  return new Response("no such page", { status: 404 });
}

/**
 * The mesh's stand-in, mounted at `MESH_PREFIX`.
 *
 * `mesh:<pathname>` NAMES THE SERVICE THAT ANSWERED, which is the whole point:
 * the app is mounted at `/` and so matches this path too, and only the answer
 * tells the two apart -- a test that asserted a 200 would pass either way. The
 * pathname is the one the handler was given, unshortened, because the library
 * does not strip the mount prefix and a real gateway relies on that.
 *
 * The method and body follow only when a body arrived, so a GET keeps the
 * plain `mesh:<pathname>` shape while a POST can be asserted on what it
 * actually carried.
 */
async function meshHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.text();
  const answer =
    body === "" ? `mesh:${url.pathname}` : `mesh:${url.pathname} ${request.method} ${body}`;
  return new Response(answer);
}

let session: Session | undefined;

declare global {
  interface Window {
    openTestSession(shellOrigin: string, name: string): Promise<string>;
  }
}

window.openTestSession = async (shellOrigin, name) => {
  session = await openSession({
    name,
    origin: () => shellOrigin,
    services: [
      { key: APP_SERVICE_KEY, path: "/", handler },
      // FROM THE CONSTANTS, never a literal: the worker's allowlist
      // (`SESSION_SERVICE_KEYS`) refuses a key it does not know, and in a
      // browser a refused REGISTER is a rejection the fixture would report as
      // a timeout rather than as the drift it is.
      { key: MESH_SERVICE_KEY, path: MESH_PREFIX, handler: meshHandler },
    ],
    timeoutMs: 15_000,
  });
  const frame = document.createElement("iframe");
  frame.id = "session";
  frame.src = session.url("/");
  document.body.append(frame);
  return session.origin;
};

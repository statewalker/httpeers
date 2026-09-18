/**
 * A test ghost app: serves a three-file "app" into a session through the
 * shell's client, exactly as a real ghost app does, with no mesh behind it.
 * Driven by `scripts/browser-test.mjs`.
 */
import { openSession, type Session } from "../../src/client.js";

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

let session: Session | undefined;

declare global {
  interface Window {
    openTestSession(shellOrigin: string, name: string): Promise<string>;
  }
}

window.openTestSession = async (shellOrigin, name) => {
  session = await openSession({ name, origin: () => shellOrigin, handler, timeoutMs: 15_000 });
  const frame = document.createElement("iframe");
  frame.id = "session";
  frame.src = session.url("/");
  document.body.append(frame);
  return session.origin;
};

/**
 * What a session shows when THE RELAY ITSELF has to answer.
 *
 * The library's relay worker answers a failure with a JSON envelope, which is
 * right for a `fetch()` caller and useless in a visible iframe -- a session's
 * `index.html` IS a navigation, and a viewer reading raw JSON has been told
 * nothing. So a failure a human will look at becomes a page, and everything
 * else is left exactly as the library made it.
 *
 * "THE RELAY ITSELF" IS THE WHOLE DIFFICULTY. `decorateResponse` runs on every
 * answer the relay carries, and most of them are the APP's -- the relay is a
 * pipe, not the origin of what flows through it. A rule of "not ok" would have
 * the shell overwrite an app's own 404 page with its own words, and, because a
 * rewrite builds a new `Response`, silently drop the `Location` off a 302 and
 * break every app-level redirect. So this rewrites only what carries the
 * envelope's own content type, and never a 3xx at all.
 *
 * THE STATUS IS NOT REWRITTEN. The library decides what went wrong; this only
 * decides how it reads.
 */

/** Statuses a viewer can do something about, and what to tell them. */
const EXPLAINED: Record<number, { title: string; text: string }> = {
  403: {
    title: "Refused",
    text: "The app declined this request.",
  },
  410: {
    title: "No app is connected",
    text: "Nothing is serving this session right now. Reopen it from the app that created it.",
  },
};

const NULL_BODY = [204, 205, 304];

/**
 * The content type the relay's own envelope carries -- `serve()`'s catch
 * builds it as `JSON.stringify(errorOptions)` with `Content-Type:
 * application/json`. It is the only signal available here that tells the
 * relay's failure from the app's answer, because both arrive as a plain
 * `Response` through the same `decorateResponse` hook.
 */
const ENVELOPE_TYPE = "application/json";

function isRelayEnvelope(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(ENVELOPE_TYPE);
}

function wantsHtml(request: Request): boolean {
  if (request.mode === "navigate") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

/**
 * The shell's page for `response`, or `null` to leave `response` exactly as it
 * is -- which is the answer for everything except the relay's own envelope.
 *
 * THE RESIDUAL, STATED PLAINLY. An app that answers a NAVIGATION with a JSON
 * error body is indistinguishable here from the relay's envelope, and gets the
 * shell's page instead of its JSON. That is a deliberate trade: a JSON body is
 * not something a viewer can read either way, and the alternative -- a private
 * marker header the relay does not send -- would mean the relay's own failures
 * stayed raw JSON in an iframe, which is the whole problem this file exists
 * for. An app that wants its own error rendered should answer with HTML.
 */
export function sessionErrorPage(response: Response, request: Request): Response | null {
  // FIRST AND UNCONDITIONAL. A redirect is not an error to re-render, and
  // rebuilding the response is exactly what would drop its `Location`.
  if (response.status >= 300 && response.status < 400) return null;
  if (response.ok) return null;
  if (NULL_BODY.includes(response.status)) return null;
  // Only what the relay made. The app's own error keeps its own body.
  if (!isRelayEnvelope(response)) return null;
  if (!wantsHtml(request)) return null;

  const known = EXPLAINED[response.status];
  const title = known?.title ?? (response.statusText || "This session could not answer");
  const text = known?.text ?? "The session's app did not answer this request.";

  const body =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:15px/1.6 system-ui,sans-serif;margin:2rem">` +
    `<h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-httpeers-session": "shell",
    },
  });
}

/**
 * What a session shows when the relay itself has to answer.
 *
 * The library's relay worker answers a failure with a JSON envelope, which is
 * right for a `fetch()` caller and useless in a visible iframe -- a session's
 * `index.html` IS a navigation, and a viewer reading raw JSON has been told
 * nothing. So a failure a human will look at becomes a page, and everything
 * else is left exactly as the library made it.
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

export function sessionErrorPage(response: Response, request: Request): Response | null {
  if (response.ok) return null;
  if (NULL_BODY.includes(response.status)) return null;
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

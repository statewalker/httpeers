/**
 * Deciding whether a config URL may be fetched and obeyed without asking the user first.
 *
 * SAME RULE AS `../mesh/discover.ts`'s header comment, applied to the config URL instead of the
 * hub's service document: a URL the app fetches and obeys is a redirect of every message the user
 * sends and any key that document contains. `discover.ts` trusts only the hub's own peer id under
 * the mesh edge; this trusts only the page's own origin, or that same specific edge -- and nothing
 * else. In particular, once a mesh edge is known, plain same-origin is NOT enough: the edge's host
 * serves every peer's mount side by side (`<host>/peers/<peerId>/...`), so "same origin" would also
 * cover a sibling peer's mount, which is exactly the "another peer is not your hub" case `discover
 * .ts` guards against. Same-origin trust is only for the plain, non-mesh case (`edgeBase == null`).
 *
 * PURE. No fetching, no React: `pageUrl` and `edgeBase` are passed in so this runs the same in a
 * unit test and in the browser.
 */

export type ConfigUrlVerdict =
  | { trusted: true; reason: "same-origin" | "mesh-edge" }
  | { trusted: false; origin: string };

export function judgeConfigUrl(
  configUrl: string,
  context: { pageUrl: string; edgeBase: string | null },
): ConfigUrlVerdict {
  // RFC 3986 §4.2: a relative-path reference whose first segment contains a colon is
  // indistinguishable from an attempt at a scheme, and WHATWG's own resolver still accepts it
  // (e.g. "::::" against a base quietly becomes the path "/::::"). A string that is not already a
  // genuine, self-contained absolute URL, but whose first segment carries a colon anyway, is
  // refused outright rather than trusted to whichever way base-relative resolution happens to
  // read it -- this is what makes an "unparseable" candidate like "::::" distrusted without ever
  // needing to throw.
  if (!isAbsoluteUrl(configUrl) && configUrl.split("/", 1)[0].includes(":")) {
    return { trusted: false, origin: configUrl };
  }

  let candidate: URL;
  try {
    candidate = new URL(configUrl, context.pageUrl);
  } catch {
    // An unparseable URL is distrusted, never an exception.
    return { trusted: false, origin: configUrl };
  }

  // Restrict to http:/https: before anything else: javascript:, data: and file: all parse to a
  // perfectly well-formed URL, so without this gate they would sail through the checks below.
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    return { trusted: false, origin: candidate.origin };
  }

  if (context.edgeBase != null) {
    let base: URL;
    try {
      base = new URL(context.edgeBase, context.pageUrl);
    } catch {
      return { trusted: false, origin: candidate.origin };
    }
    const baseHref = base.href.endsWith("/") ? base.href : `${base.href}/`;
    // Per RFC 3986 `%2F`/`%5C` are not path separators, so `<edge>..%2f..%2felsewhere/c.json`
    // genuinely stays under `baseHref` by this prefix test -- `new URL` never decodes them into
    // `/` or `\`. That holds only so long as nothing downstream (a proxy, the mesh edge's own
    // router) decodes them before routing; refusing them here removes the fragile assumption
    // instead of relying on it, at the cost of a config document that legitimately needs an
    // encoded slash in a path segment -- one this app has no documented use for.
    if (/%2f|%5c/i.test(candidate.pathname)) {
      return { trusted: false, origin: candidate.origin };
    }
    // `new URL` has already resolved and collapsed any ".." by the time `.href` is read here, so
    // a path built to escape the edge base (`<edge>../../elsewhere/...`) no longer starts with it
    // -- there is no separate traversal check to get wrong. The same prefix test is what keeps a
    // *different peer's* mount under the same edge (`<edge-host>/peers/OtherPeer/...`) untrusted:
    // it shares the host but is not a path under this specific edge, so it fails the prefix.
    return candidate.href.startsWith(baseHref)
      ? { trusted: true, reason: "mesh-edge" }
      : { trusted: false, origin: candidate.origin };
  }

  const page = new URL(context.pageUrl);
  // Compare url.origin, never a string prefix: origin is scheme + host + port only, so it is
  // immune to the userinfo trick (`https://llm-chat.httpeers.net@evil.example/...` carries that
  // whole prefix as *userinfo*, and its real origin is `https://evil.example`) and to a host that
  // merely ends with the trusted one (`https://evil-llm-chat.httpeers.net` is its own, distinct
  // origin, however its hostname reads as a substring).
  return candidate.origin === page.origin
    ? { trusted: true, reason: "same-origin" }
    : { trusted: false, origin: candidate.origin };
}

/** Whether `raw` is a complete, self-contained absolute URL -- parseable with no base at all. */
function isAbsoluteUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

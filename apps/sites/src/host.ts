/**
 * The `Host` header, turned into a storage prefix.
 *
 * THIS VALUE BECOMES A PATH. Every site lives at a first-level prefix named
 * after its domain, so an unvalidated `Host` is a path-traversal primitive.
 * Caddy constrains this hard today -- its wildcard site block matches exactly
 * one label of `*.httpeers.net`, which can contain no dots or slashes -- but
 * the app must not depend on the proxy for correctness. The day someone
 * publishes port 3000 to debug, that guarantee ends and this function is the
 * only thing left.
 */

/** Labels of [a-z0-9-], no leading or trailing hyphen, 253 characters overall. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function siteFromHost(host: string | undefined): string | undefined {
  if (host == null) return undefined;
  let h = host.trim().toLowerCase();

  // Strip a port. IPv6 literals are bracketed and are never valid site names
  // here, so the bracket check keeps a `::1` style value from being mangled
  // into something that accidentally passes the pattern.
  if (!h.includes("[")) {
    const colon = h.lastIndexOf(":");
    if (colon !== -1) h = h.slice(0, colon);
  }

  // A fully-qualified name may carry a trailing dot; storage keys do not.
  if (h.endsWith(".")) h = h.slice(0, -1);

  return HOSTNAME.test(h) ? h : undefined;
}

/**
 * Where the Bridge may relay: the Sharer's own machine, LAN and tailnet,
 * nothing else.
 *
 * Literal addresses are checked as they are. A DNS name is decided by whoever
 * controls its zone at request time (DNS rebinding), so names are refused,
 * with three exceptions: `localhost`; mDNS `.local` names, which are
 * resolved FIRST and allowed only if every address they resolve to is
 * private (some company networks serve `.local` from ordinary DNS, so the
 * name alone proves nothing); and `*.localhost` names, which RFC 6761
 * reserves for loopback, resolved FIRST and allowed only if every address
 * is loopback (a resolver that forwards them to DNS could answer anything).
 */

export type TargetVerdict =
  | "allowed"
  | "forbidden"
  /** Resolve `resolve`, then allow only if every address passes `require`. */
  | { resolve: string; require: "private" | "loopback" };

export function checkTarget(target: string): TargetVerdict {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "forbidden";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "forbidden";

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return "allowed";
  if (isAddress(host)) return isPrivateAddress(host) ? "allowed" : "forbidden";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(host)) return { resolve: host, require: "private" };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/.test(host))
    return { resolve: host, require: "loopback" };
  return "forbidden";
}

function isAddress(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/** Loopback, RFC 1918, carrier-grade NAT (Tailscale), IPv6 loopback and unique-local. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4 != null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Link-local (fe80::/10) and IPv4-mapped addresses are refused.
  const v6 = address.toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(v6);
}

/** `127.0.0.0/8` and `::1`: this machine only. */
export function isLoopbackAddress(address: string): boolean {
  return /^127\.\d+\.\d+\.\d+$/.test(address) || address.toLowerCase() === "::1";
}

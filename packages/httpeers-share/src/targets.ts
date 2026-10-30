/**
 * Where the Bridge may relay: the Sharer's own machine, LAN and tailnet,
 * nothing else.
 *
 * Literal addresses are checked as they are. A DNS name is decided by whoever
 * controls its zone at request time (DNS rebinding), so names are refused,
 * with two exceptions: `localhost`, and mDNS `.local` names, which are
 * resolved FIRST and allowed only if every address they resolve to is
 * private. (Some company networks serve `.local` from ordinary DNS, so the
 * name alone proves nothing.)
 */

export type TargetVerdict = "allowed" | "forbidden" | { resolve: string };

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
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(host)) return { resolve: host };
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

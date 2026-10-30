/**
 * What can be shared in v1, and how.
 *
 * - **Bridged**: a service on the Sharer's machine or LAN, through the CORS
 *   proxy on localhost (the Bridge). Its own target rules decide (rung 02).
 * - **Direct**: a remote resource with a domain name, a certificate and its
 *   own CORS headers. So: `https`, and a host NAME, never an address, and not
 *   the Sharer's own machine or LAN (those go through the Bridge).
 */

import { checkTarget } from "./targets.js";

export type ServiceKind = "bridged" | "direct";

export type TargetRefusal =
  | "not-a-url"
  | "not-http"
  | "needs-https"
  | "needs-domain-name"
  | "local-needs-bridge"
  | "remote-is-direct"
  | "not-local";

export type TargetCheck = { ok: true } | { ok: false; reason: TargetRefusal };

export function checkServiceTarget(kind: ServiceKind, target: string): TargetCheck {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return refused("not-a-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refused("not-http");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isAddress = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  const isLocalName = host === "localhost" || host.endsWith(".local");

  if (kind === "bridged") {
    if (checkTarget(target) !== "forbidden") return { ok: true };
    // A public https name is a remote resource: it is shared Direct.
    return refused(url.protocol === "https:" && !isAddress ? "remote-is-direct" : "not-local");
  }

  if (isLocalName) return refused("local-needs-bridge");
  if (isAddress) return refused("needs-domain-name");
  if (url.protocol !== "https:") return refused("needs-https");
  return { ok: true };
}

function refused(reason: TargetRefusal): TargetCheck {
  return { ok: false, reason };
}

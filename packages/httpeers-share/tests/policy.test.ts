/**
 * 04 — the v1 rule for what can be shared, and how.
 *
 * Bridged: a service on the Sharer's machine or LAN, through the CORS proxy
 * on localhost. Direct: a remote resource with a domain name, a certificate
 * and its own CORS headers.
 */

import { describe, expect, it } from "vitest";
import { checkServiceTarget } from "../src/policy.js";

describe("04 — what can be shared in v1", () => {
  it.each([
    ["bridged", "http://localhost:5173"],
    ["bridged", "http://127.0.0.1:8080"],
    ["bridged", "http://192.168.1.20:8000"],
    ["bridged", "http://nas.local:5000"],
    ["direct", "https://api.example.com"],
    ["direct", "https://wiki.example.com:8443/base"],
  ] as const)("%s %s: allowed", (kind, target) => {
    expect(checkServiceTarget(kind, target)).toEqual({ ok: true });
  });

  it.each([
    ["direct", "http://api.example.com", "needs-https"],
    ["direct", "https://192.168.1.20", "needs-domain-name"],
    ["direct", "https://[2001:db8::1]", "needs-domain-name"],
    ["direct", "https://localhost:5173", "local-needs-bridge"],
    ["direct", "https://nas.local", "local-needs-bridge"],
    ["bridged", "https://api.example.com", "remote-is-direct"],
    ["bridged", "http://8.8.8.8", "not-local"],
    ["bridged", "ftp://localhost", "not-http"],
    ["direct", "not a url", "not-a-url"],
  ] as const)("%s %s: refused (%s)", (kind, target, reason) => {
    expect(checkServiceTarget(kind, target)).toEqual({ ok: false, reason });
  });
});

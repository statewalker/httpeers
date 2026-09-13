/**
 * Containment — the decision, and the trap inside it.
 *
 * A root-absolute URL from inside a rendered host page resolves against the
 * VIEWER's origin, silently, and `<base href>` does not fix it because it
 * governs relative URLs only. Rung 16 measured all three candidate remedies in
 * a real Chromium and the owner ratified the path-scoped CSP.
 *
 * The browser column lives in that rung. What these tests pin is the POLICY —
 * which is where the trap is, and where a later "simplification" would undo
 * the decision without any browser noticing until it mattered.
 */

import { describe, expect, it } from "vitest";
import { contain, frameSandbox, policyFor } from "../src/contain.js";

const BASE = "http://viewer.example/ghost/";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((d) => {
      const [name, ...sources] = d.split(" ");
      return [name ?? "", sources];
    }),
  );
}

describe("the CSP", () => {
  it("names the MOUNT, never `'self'`, in every fetch directive", () => {
    // THE TRAP. `'self'` is the reflex, and it does nothing here: the viewer's
    // origin IS self, so it permits precisely the escape being closed. What
    // contains is the PATH in the source expression, which CSP matches by
    // prefix.
    const found = directives(policyFor({ baseUrl: BASE, mode: "csp" }));

    for (const name of ["default-src", "connect-src", "img-src", "style-src", "script-src"]) {
      expect(found.get(name), name).not.toContain("'self'");
      expect(found.get(name)?.[0], name).toBe(BASE);
    }
  });

  it("uses `'self'` for `frame-ancestors`, which governs the other direction", () => {
    // Who may EMBED the ghost, rather than what the ghost may reach. This one
    // should say `'self'`, and a reader who has just internalised the rule
    // above would otherwise 'fix' it.
    expect(directives(policyFor({ baseUrl: BASE, mode: "csp" })).get("frame-ancestors")).toEqual([
      "'self'",
    ]);
  });

  it("is applied to HTML responses", async () => {
    const html = async () =>
      new Response("<!doctype html><p>hi", { headers: { "content-type": "text/html" } });
    const guarded = contain(html, { baseUrl: BASE, mode: "csp" });

    const policy = (await guarded(new Request(BASE))).headers.get("content-security-policy");

    expect(policy).toContain(`default-src ${BASE}`);
  });

  it("leaves a non-HTML response alone", async () => {
    // A CSP governs a DOCUMENT. Putting one on an asset changes nothing and
    // suggests to a reader that it does.
    const asset = async () =>
      new Response("body", { headers: { "content-type": "text/plain" } });
    const guarded = contain(asset, { baseUrl: BASE, mode: "csp" });

    const response = await guarded(new Request(`${BASE}asset.txt`));

    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(await response.text()).toBe("body");
  });

  it("mode `none` changes nothing, so the control in rung 16 is honest", async () => {
    const html = async () => new Response("<p>", { headers: { "content-type": "text/html" } });
    const response = await contain(html, { baseUrl: BASE, mode: "none" })(new Request(BASE));

    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("the sandbox mode, kept as a recorded dead end", () => {
  it("asks for no `allow-same-origin`, which is what disqualified it", () => {
    // Rung 16 measured this: the opaque origin that would contain the page is
    // the same thing that removes it from the ServiceWorker's control, so the
    // ghost cannot serve it at all. Kept so the measurement stays runnable and
    // nobody re-proposes it from the description.
    expect(frameSandbox("sandbox")).toBe("allow-scripts");
    expect(frameSandbox("sandbox")).not.toContain("allow-same-origin");
    expect(frameSandbox("csp")).toBeUndefined();
  });
});

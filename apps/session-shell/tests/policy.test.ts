import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAME_ANCESTORS,
  frameAncestorsFor,
  isAllowedParentOrigin,
  isSessionName,
  isShellPath,
  navigationAllowed,
  RELAY_PATH,
  randomSessionName,
  SESSION_ZONE,
  sessionOrigin,
  withFrameAncestors,
} from "../src/policy.js";

const SESSION = "https://abc123.p.httpeers.net";

describe("isAllowedParentOrigin — who may hand a session its port", () => {
  it.each([
    "https://httpeers.net",
    "https://app.httpeers.net",
    "https://hub.httpeers.net",
    "https://llm-chat.httpeers.net",
  ])("accepts the ghost-app origin %s", (origin) => {
    expect(isAllowedParentOrigin(origin, "abc123.p.httpeers.net")).toBe(true);
  });

  it.each([
    // ANOTHER SESSION. Every session is a subdomain of httpeers.net too, so a
    // plain suffix test would let a hostile app in session A drive session B.
    ["another session", "https://other.p.httpeers.net"],
    ["the session zone itself", "https://p.httpeers.net"],
    ["a deeper name", "https://a.b.httpeers.net"],
    ["plain http", "http://app.httpeers.net"],
    ["a non-default port", "https://app.httpeers.net:8443"],
    ["a look-alike suffix", "https://evilhttpeers.net"],
    ["a look-alike registrable domain", "https://app.httpeers.net.evil.example"],
    ["an opaque origin", "null"],
    ["localhost, from a production session", "http://localhost:5173"],
    ["garbage", "not a url"],
  ])("refuses %s (%s)", (_why, origin) => {
    expect(isAllowedParentOrigin(origin, "abc123.p.httpeers.net")).toBe(false);
  });

  it("accepts localhost parents only when the shell itself is served from localhost", () => {
    expect(isAllowedParentOrigin("http://localhost:5173", "localhost")).toBe(true);
    expect(isAllowedParentOrigin("http://127.0.0.1:4000", "127.0.0.1")).toBe(true);
    expect(isAllowedParentOrigin("https://evil.example", "localhost")).toBe(false);
  });
});

describe("navigationAllowed — which navigations a session's worker serves", () => {
  it("serves a navigation the ghost app started (its iframe src)", () => {
    expect(navigationAllowed("https://app.httpeers.net/", SESSION)).toBe(true);
  });

  it("serves a navigation the session started itself (a link inside the app)", () => {
    expect(navigationAllowed(`${SESSION}/page/2`, SESSION)).toBe(true);
  });

  it.each([
    // A referrer cannot be forged, only withheld -- so withholding it must not
    // be a way around the check.
    ["no referrer at all", ""],
    ["another session", "https://other.p.httpeers.net/"],
    ["a foreign site", "https://evil.example/"],
  ])("refuses %s", (_why, referrer) => {
    expect(navigationAllowed(referrer, SESSION)).toBe(false);
  });
});

describe("isShellPath — what the worker leaves to the network", () => {
  it.each([RELAY_PATH, "/relay-sw.js", "/_shell/relay-abc.js", "/_shell/"])(
    "%s is the shell's own",
    (path) => expect(isShellPath(path)).toBe(true),
  );

  it.each(["/", "/index.html", "/relay.html.map", "/_shellfish", "/app/relay.html"])(
    "%s belongs to the app",
    (path) => expect(isShellPath(path)).toBe(false),
  );
});

describe("session names", () => {
  it("are one lowercase DNS label with at least 128 bits", () => {
    const name = randomSessionName();
    expect(name).toMatch(/^[a-z2-7]{26}$/);
    expect(isSessionName(name)).toBe(true);
  });

  it("do not repeat", () => {
    const names = new Set(Array.from({ length: 1000 }, () => randomSessionName()));
    expect(names.size).toBe(1000);
  });

  it.each(["123123", "foobar", "a", "a-b"])("accepts the label %s", (name) => {
    expect(isSessionName(name)).toBe(true);
  });

  it.each(["", "-a", "a-", "Ab", "a.b", "a_b", "x".repeat(64)])("refuses %j", (name) => {
    expect(isSessionName(name)).toBe(false);
  });

  it("map to an origin under the session zone", () => {
    expect(sessionOrigin("foobar")).toBe(`https://foobar.${SESSION_ZONE}`);
    expect(() => sessionOrigin("a.b")).toThrow();
  });
});

describe("frame-ancestors", () => {
  it("is stamped as an ADDITIONAL policy, so an app's own CSP still applies", async () => {
    const own = new Response("<p>hi</p>", {
      headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'" },
    });
    const out = withFrameAncestors(own, FRAME_ANCESTORS);
    expect(out.headers.get("content-security-policy")).toBe(
      `script-src 'self', frame-ancestors ${FRAME_ANCESTORS}`,
    );
    expect(await out.text()).toBe("<p>hi</p>");
  });

  it("keeps status and body-less responses intact", () => {
    const out = withFrameAncestors(new Response(null, { status: 304 }), FRAME_ANCESTORS);
    expect(out.status).toBe(304);
  });

  it("includes localhost only for a localhost shell", () => {
    expect(frameAncestorsFor("abc.p.httpeers.net")).toBe(FRAME_ANCESTORS);
    expect(frameAncestorsFor("localhost")).toContain("http://localhost:*");
  });

  // THE DRIFT CHECK. The same policy is written twice: here, for responses the
  // worker makes, and in deploy/Caddyfile, for the shell's own files. Two
  // copies of a security header drift silently unless something compares them.
  it("matches the header the Caddyfile sets on the shell's own files", () => {
    const caddyfile = readFileSync(join(__dirname, "../../../deploy/Caddyfile"), "utf8");
    expect(caddyfile).toContain(`frame-ancestors ${FRAME_ANCESTORS}`);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_SERVICE_KEY,
  canRegisterService,
  DEFAULT_SERVICE_KEY,
  FRAME_ANCESTORS,
  frameAncestorsFor,
  isAllowedParentOrigin,
  isSessionName,
  isShellPath,
  MESH_PREFIX,
  MESH_SERVICE_KEY,
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

describe("the session's reserved namespace", () => {
  // The member edge's own shape, so an app written for a member origin runs
  // unchanged in a session. An app cannot own this prefix.
  it("reserves /peers/ for the mesh", () => {
    expect(MESH_PREFIX).toBe("/peers/");
  });

  it("keeps a default service key for a session that registers only an app", () => {
    expect(DEFAULT_SERVICE_KEY).toBe("session");
  });

  // isShellPath decides what `exclude` hands back to the network. A root mount
  // claims everything else, so anything missing here becomes unreachable.
  it.each(["/relay.html", "/relay-sw.js", "/_shell/x.js"])("keeps %s the shell's", (path) => {
    expect(isShellPath(path)).toBe(true);
  });

  it("does not reserve the app's own paths", () => {
    for (const path of ["/", "/index.html", "/app.js", "/peers/12D3Koo/llm"]) {
      expect(isShellPath(path)).toBe(false);
    }
  });
});

describe("canRegisterService — which services a session may serve", () => {
  const relay = `${SESSION}${RELAY_PATH}`;

  it("names the two services a session serves", () => {
    expect(APP_SERVICE_KEY).toBe("app");
    expect(MESH_SERVICE_KEY).toBe("mesh");
  });

  it.each([APP_SERVICE_KEY, MESH_SERVICE_KEY, DEFAULT_SERVICE_KEY])(
    "lets the relay page register %s",
    (key) => {
      expect(canRegisterService(relay, key)).toBe(true);
    },
  );

  // AN ALLOWLIST, NOT A FREE KEY SPACE. `takeover: "first-wins"` defends a key
  // that is already held; it says nothing about a key nobody asked for. A
  // second ghost -- any *.httpeers.net page may frame this relay, and the name
  // is not a secret -- would otherwise register "evil" at "/index.html" and
  // win the longest-prefix match against the app's own root mount.
  it.each(["evil", "", "session ", "APP", "peers"])("refuses the key %j", (key) => {
    expect(canRegisterService(relay, key)).toBe(false);
  });

  // The other half of the rule, unchanged: the page must be the relay page.
  it.each(["/", "/index.html", "/_shell/x.js", "/relay.html/x"])(
    "refuses a registration from %s",
    (path) => {
      expect(canRegisterService(`${SESSION}${path}`, APP_SERVICE_KEY)).toBe(false);
    },
  );

  it("ignores a query string and a fragment on the relay page's own URL", () => {
    expect(canRegisterService(`${relay}?x=1#y`, APP_SERVICE_KEY)).toBe(true);
  });
});

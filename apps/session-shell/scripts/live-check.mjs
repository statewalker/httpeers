/**
 * The deployed shell, on the real wildcard domain. The post-publish check.
 *
 *   node scripts/live-check.mjs [--browsers chromium,firefox]
 *
 * Every name below is fresh and random, so each check is about a name nothing
 * has ever used -- which is the only kind of name that tests a WILDCARD. A
 * name with its own DNS record, site block or certificate would pass while the
 * wildcard itself was broken.
 *
 * What it proves, in order:
 *   1. DNS  -- two fresh names resolve.
 *   2. TLS  -- a fresh name is served a certificate whose SAN is
 *              `*.p.httpeers.net`, issued by Let's Encrypt (not the silent
 *              ZeroSSL fallback -- see deploy/Caddyfile).
 *   3. HTTP -- two names serve byte-identical shell files, with the
 *              frame-ancestors header, and `.site/` is not served.
 *   4. In real browsers -- a page on ANOTHER session cannot drive this one
 *              (the relay refuses the port), and a foreign site cannot frame
 *              it at all.
 *
 * The app-in-a-session path, which needs a mesh, is `apps/demos`'s
 * `scripts/session-smoke.mjs`.
 */

import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { connect } from "node:tls";
import { chromium, firefox } from "playwright";

const ZONE = "p.httpeers.net";
const FRAME_ANCESTORS = "frame-ancestors 'self' https://httpeers.net https://*.httpeers.net";
const FILES = ["/relay.html", "/relay-sw.js", "/index.html"];

const args = process.argv.slice(2);
const i = args.indexOf("--browsers");
const wanted = (i >= 0 ? args[i + 1] : "chromium,firefox").split(",");

const fresh = () => `check-${Math.random().toString(36).slice(2, 10)}`;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

// 1. DNS
const [a, b] = [fresh(), fresh()];
for (const name of [a, b]) {
  const addrs = await resolve4(`${name}.${ZONE}`).catch((e) => [String(e.code ?? e)]);
  check(`DNS resolves ${name}.${ZONE}`, /^\d+\.\d+\.\d+\.\d+$/.test(addrs[0]), addrs.join(","));
}

// 2. TLS
const cert = await new Promise((resolveCert, reject) => {
  const socket = connect({ host: `${a}.${ZONE}`, port: 443, servername: `${a}.${ZONE}` }, () => {
    const c = socket.getPeerCertificate();
    socket.end();
    resolveCert(c);
  });
  socket.on("error", reject);
});
check(
  "TLS certificate for a never-used name lists *.p.httpeers.net",
  cert.subjectaltname === `DNS:*.${ZONE}`,
  cert.subjectaltname,
);
check("TLS issuer is Let's Encrypt", /Let's Encrypt/.test(cert.issuer?.O ?? ""), cert.issuer?.O);
check("TLS certificate is in date", new Date(cert.valid_to) > new Date(), cert.valid_to);

// 3. HTTP
const md5 = (buf) => createHash("md5").update(buf).digest("hex");
for (const path of FILES) {
  const [ra, rb] = await Promise.all([a, b].map((name) => fetch(`https://${name}.${ZONE}${path}`)));
  const [ba, bb] = await Promise.all([ra, rb].map((r) => r.arrayBuffer()));
  check(
    `${path} is byte-identical on two names`,
    ra.status === 200 && rb.status === 200 && md5(Buffer.from(ba)) === md5(Buffer.from(bb)),
    `${ra.status}/${rb.status} ${md5(Buffer.from(ba)).slice(0, 12)}`,
  );
  if (path.endsWith(".html")) {
    check(
      `${path} carries frame-ancestors`,
      ra.headers.get("content-security-policy") === FRAME_ANCESTORS,
      ra.headers.get("content-security-policy") ?? "(none)",
    );
  }
}
const config = await fetch(`https://${a}.${ZONE}/.site/config.json`);
const configBody = await config.text();
// The fallback page answers instead (with 404) -- never the JSON itself.
check(
  ".site/ is never served",
  config.status === 404 && !configBody.trim().startsWith("{"),
  `${config.status} ${configBody.trim().slice(0, 15)}`,
);

// 4. Browsers
for (const browserName of wanted) {
  const browser = await { chromium, firefox }[browserName].launch();
  try {
    const context = await browser.newContext();

    // A page on session A frames session B's relay and offers it a port. B's
    // relay must refuse it: every session is under httpeers.net, so framing is
    // allowed, and the origin check is the only thing standing in the way.
    const [sa, sb] = [fresh(), fresh()];
    const tab = await context.newPage();
    await tab.goto(`https://${sa}.${ZONE}/relay.html`);
    await tab.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      frame.onload = () => {
        const channel = new MessageChannel();
        frame.contentWindow.postMessage({ type: "CONNECT" }, "*", [channel.port1]);
      };
      document.body.append(frame);
    }, `https://${sb}.${ZONE}/relay.html`);
    await tab.waitForTimeout(3_000);
    const innerFrame = tab.frames().find((f) => f.url().includes(sb));
    const state = await innerFrame
      ?.evaluate(() => document.documentElement.dataset.relay)
      .catch((e) => `error: ${e.message}`);
    check(
      `[${browserName}] another session cannot hand a relay its port`,
      state === "refused",
      state,
    );

    // A foreign site cannot frame a session at all.
    const evil = await context.newPage();
    await evil.route("https://evil.example/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>evil</title>" }),
    );
    await evil.goto("https://evil.example/");
    await evil.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      document.body.append(frame);
    }, `https://${fresh()}.${ZONE}/relay.html`);
    await evil.waitForTimeout(3_000);
    const framed = evil.frames().find((f) => f !== evil.mainFrame());
    // A blocked frame may never answer an evaluate (Firefox), so bound it.
    const framedState = await Promise.race([
      framed
        ?.evaluate(() => document.documentElement.dataset.relay ?? "no relay")
        .catch((e) => `blocked (${e.message.split("\n")[0].slice(0, 60)})`),
      new Promise((r) => setTimeout(() => r("blocked (frame never answered)"), 5_000)),
    ]);
    check(
      `[${browserName}] a foreign site cannot frame a session`,
      framedState == null || !["waiting", "connecting", "connected"].includes(framedState),
      `${framed?.url() ?? "(no frame)"} ${framedState ?? ""}`,
    );
  } finally {
    await browser.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * The shell in real browsers, on localhost: the built worker, the built relay
 * page and the client, speaking the relay protocol with no mesh behind it.
 *
 *   pnpm run build && node scripts/browser-test.mjs [--browsers chromium,firefox]
 *
 * TWO LOCAL ORIGINS, ONE PER PARTY: the shell on one port, a test ghost app on
 * another. Every session name maps to the SAME local shell origin, so this
 * proves the protocol, the routing and the refusals -- not the per-name
 * isolation, which needs the real wildcard domain (`scripts/live-check.mjs`).
 *
 * The local shell accepts localhost parents only because it is itself served
 * from localhost (`isAllowedParentOrigin`); the deployed rule is unchanged.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const site = join(root, "dist", "site");
if (!existsSync(join(site, "relay-sw.js"))) throw new Error("run `pnpm run build` first");

const args = process.argv.slice(2);
const wanted = (args[args.indexOf("--browsers") + 1] ?? "chromium,firefox").split(",");

// The test ghost app, bundled like any ghost app would be.
const ghostOut = join(root, "dist", "test-ghost");
await build({
  configFile: false,
  logLevel: "warn",
  root: join(root, "tests", "browser"),
  build: { outDir: ghostOut, emptyOutDir: true, rollupOptions: { input: "ghost.html" } },
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
};

/** A static server; `csp` mimics the Caddy header on the shell. */
function serve(dir, { csp, notFound } = {}) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    let file = join(dir, path === "/" ? "index.html" : path);
    let status = 200;
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
      if (notFound == null) {
        res.writeHead(404).end("not found");
        return;
      }
      file = join(dir, notFound);
      status = 404;
    }
    const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
    if (csp) headers["content-security-policy"] = csp;
    res.writeHead(status, headers);
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const shell = await serve(site, {
  csp: "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
  notFound: "index.html",
});
const ghost = await serve(ghostOut);
const SHELL = `http://localhost:${shell.address().port}`;
const GHOST = `http://127.0.0.1:${ghost.address().port}`;

const results = [];
function check(browserName, name, ok, detail = "") {
  results.push({ browserName, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} [${browserName}] ${name}${detail ? ` -- ${detail}` : ""}`);
}

for (const browserName of wanted) {
  const type = { chromium, firefox }[browserName];
  const browser = await type.launch();
  const context = await browser.newContext();
  try {
    const tab = await context.newPage();
    tab.on("pageerror", (e) => console.log(`  [${browserName}] pageerror: ${e.message}`));
    await tab.goto(`${GHOST}/ghost.html`);

    const origin = await tab.evaluate((s) => window.openTestSession(s, "alpha"), SHELL);
    check(browserName, "openSession resolves with the session origin", origin === SHELL, origin);

    const frame = tab.frameLocator("#session");
    const hello = await frame.locator("#hello").textContent({ timeout: 15_000 }).catch(String);
    check(
      browserName,
      "index.html is served by the app over the port",
      hello === "hello from the app",
      hello,
    );

    const where = await frame.locator("#where").textContent({ timeout: 15_000 }).catch(String);
    check(browserName, "a root-absolute script runs in the session origin", where === SHELL, where);

    const api = await frame.locator("#api").textContent({ timeout: 15_000 }).catch(String);
    check(
      browserName,
      "a POST with a body and a query reaches the app",
      api === "echo POST ?x=1 ping",
      api,
    );

    // A BROWSER STOPS AN IDLE WORKER, and the next fetch starts a fresh one
    // with empty memory. The registration must survive that (it is kept in
    // IndexedDB). Only Chromium lets a test stop a worker on demand.
    if (browserName === "chromium") {
      const cdp = await context.newCDPSession(tab);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      const inner = tab.frames().find((f) => f.url() === `${SHELL}/`);
      const afterStop = await inner.evaluate(() =>
        fetch("/api/echo?after=stop", { method: "POST", body: "pong" }).then((r) => r.text()),
      );
      check(
        browserName,
        "a stopped worker restarts and still reaches the app",
        afterStop === "echo POST ?after=stop pong",
        afterStop,
      );
    }

    // The shell's own files bypass the worker.
    const frameHandle = tab
      .frames()
      .find((f) => f.url().startsWith(`${SHELL}/`) && !f.url().includes("relay"));
    const relayHtml = await frameHandle.evaluate(() => fetch("/relay.html").then((r) => r.text()));
    check(
      browserName,
      "relay.html comes from the network, not the app",
      relayHtml.includes("httpeers session relay"),
    );

    const missing = await frameHandle.evaluate(() =>
      fetch("/no/such/thing").then(
        (r) => `${r.status} ${r.headers.get("x-httpeers-session") ?? "app"}`,
      ),
    );
    check(
      browserName,
      "an unknown path is the app's 404, not the shell's",
      missing === "404 app",
      missing,
    );

    // A SECOND ghost on the same name is refused while the first is live.
    const second = await context.newPage();
    await second.goto(`${GHOST}/ghost.html`);
    const hijack = await second
      .evaluate(
        (s) =>
          window.openTestSession(s, "alpha").then(
            () => "opened",
            (e) => String(e),
          ),
        SHELL,
      )
      .catch(String);
    check(
      browserName,
      "a second app cannot take over a live session",
      hijack.includes("already connected"),
      hijack,
    );

    // A top-level visit carries no referrer; the worker refuses to serve it.
    const top = await context.newPage();
    const response = await top.goto(`${SHELL}/`);
    const topText = await top.textContent("h1").catch(String);
    check(
      browserName,
      "a top-level visit with no referrer is refused",
      response.status() === 403 && topText === "Open this session from its app",
      `${response.status()} ${topText}`,
    );
    await top.close();

    // Once the first ghost is gone, the session is free again.
    await tab.close();
    const reopened = await second
      .evaluate(
        (s) =>
          window.openTestSession(s, "alpha").then(
            () => "opened",
            (e) => String(e),
          ),
        SHELL,
      )
      .catch(String);
    check(
      browserName,
      "the session is free again once its app is gone",
      reopened === "opened",
      reopened,
    );
    const again = await second
      .frameLocator("#session")
      .locator("#hello")
      .textContent({ timeout: 15_000 })
      .catch(String);
    check(browserName, "and the new app serves it", again === "hello from the app", again);
  } finally {
    await browser.close();
  }
}

shell.close();
ghost.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

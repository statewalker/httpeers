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

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const site = join(root, "dist", "site");
if (!existsSync(join(site, "relay-sw.js"))) throw new Error("run `pnpm run build` first");

// AND A STALE BUILD IS WORSE THAN A MISSING ONE. Everything below runs against
// `dist/site`, never against `src`, so an edited worker that was not rebuilt
// gives a full green run about the previous version of the shell -- which is
// how a mutation check quietly "proves" that a mutation is harmless.
const builtAt = statSync(join(site, "relay-sw.js")).mtimeMs;
const src = join(root, "src");
const newest = readdirSync(src, { recursive: true })
  .map((name) => statSync(join(src, name)).mtimeMs)
  .reduce((newest, at) => Math.max(newest, at), 0);
if (newest > builtAt) {
  throw new Error("`src` is newer than `dist/site`: run `pnpm run build` first");
}

// THE CONSTANTS, NOT LITERALS. The mount paths and service keys asserted below
// are the shell's own, read from the built library -- a harness that spelled
// "/peers/" itself would keep passing after the shell moved the mesh, which is
// the one thing these checks exist to catch. Imported after the guard above so
// a missing build still gets its own message.
const { APP_SERVICE_KEY, MESH_PREFIX } = await import(
  pathToFileURL(join(root, "dist", "lib", "policy.js")).href
);

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

/**
 * The frame showing the session itself -- never the hidden relay iframe, which
 * lives at `RELAY_PATH` in the same origin.
 */
function sessionFrame(page, origin) {
  return page.frames().find((frame) => frame.url() === `${origin}/`);
}

/**
 * `fetch(path)` from inside the session, as its body text.
 *
 * ASSERTED ON THE BODY, NOT THE STATUS, throughout: the app is mounted at `/`
 * and therefore matches every path in the origin, so both services answer 200
 * and only what they say tells them apart.
 */
function bodyOf(frame, path, init) {
  return frame.evaluate(
    ([p, i]) => fetch(p, i ?? undefined).then((r) => r.text()),
    [path, init ?? null],
  );
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

    // ---- TWO MOUNTS ON ONE CONNECTION ----------------------------------
    // The app owns the origin root, so it matches every path here; the mesh's
    // prefix is longer, so it wins under it and nowhere else. This is the whole
    // of the routing the shell handed to the library in 0.6.0, and a browser is
    // the only place where the ServiceWorker doing it is real.
    const inner = sessionFrame(tab, SHELL);

    const rootBody = await bodyOf(inner, "/");
    check(
      browserName,
      `fetch("/") is answered by ${APP_SERVICE_KEY}`,
      rootBody.includes("hello from the app"),
      rootBody.slice(0, 48),
    );

    const indexBody = await bodyOf(inner, "/index.html");
    check(
      browserName,
      `fetch("/index.html") is answered by ${APP_SERVICE_KEY}`,
      indexBody.includes("hello from the app"),
      indexBody.slice(0, 48),
    );

    const deepMesh = await bodyOf(inner, `${MESH_PREFIX}12D3Koo/llm`);
    check(
      browserName,
      `a path under ${MESH_PREFIX} goes to the mesh, not the root mount`,
      deepMesh === `mesh:${MESH_PREFIX}12D3Koo/llm`,
      deepMesh,
    );

    const meshRoot = await bodyOf(inner, MESH_PREFIX);
    check(
      browserName,
      `${MESH_PREFIX} itself goes to the mesh`,
      meshRoot === `mesh:${MESH_PREFIX}`,
      meshRoot,
    );

    // THE FIREFOX CASE. A request body crosses the port as a stream, and this
    // asserts what the handler RECEIVED, not merely that something answered:
    // an engine that dropped the body would otherwise give a cheerful 200.
    const posted = await bodyOf(inner, `${MESH_PREFIX}12D3Koo/llm`, {
      method: "POST",
      body: "prompt=hello mesh",
    });
    check(
      browserName,
      `a POST under ${MESH_PREFIX} reaches the mesh WITH its body`,
      posted === `mesh:${MESH_PREFIX}12D3Koo/llm POST prompt=hello mesh`,
      posted,
    );

    // The root mount claims every path, so the shell's own worker is only
    // reachable because `exclude` reserves it. Without that a session cannot
    // even bootstrap, and the failure mode is the app's 404 in its place.
    const worker = await inner.evaluate(() =>
      fetch("/relay-sw.js").then(async (r) => ({
        status: r.status,
        type: r.headers.get("content-type"),
        text: await r.text(),
      })),
    );
    check(
      browserName,
      "relay-sw.js comes from the network, not the root mount",
      worker.status === 200 &&
        (worker.type ?? "").includes("javascript") &&
        worker.text.length > 1000 &&
        !worker.text.includes("no such page"),
      `${worker.status} ${worker.type} ${worker.text.length}b`,
    );

    // A BROWSER STOPS AN IDLE WORKER, and the next fetch starts a fresh one
    // with empty memory. The registration must survive that (it is kept in
    // IndexedDB). Only Chromium lets a test stop a worker on demand.
    if (browserName === "chromium") {
      const cdp = await context.newCDPSession(tab);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      const afterStop = await inner.evaluate(() =>
        fetch("/api/echo?after=stop", { method: "POST", body: "pong" }).then((r) => r.text()),
      );
      check(
        browserName,
        "a stopped worker restarts and still reaches the app",
        afterStop === "echo POST ?after=stop pong",
        afterStop,
      );

      // STOPPED AGAIN, so this fetch is itself the first a fresh worker sees:
      // the mount it is routed by was rebuilt from the registry (IndexedDB),
      // not left in memory by this test's own REGISTER. A mount that did not
      // survive would fall through to the app -- its 404, not the mesh.
      await cdp.send("ServiceWorker.stopAllWorkers");
      const meshAfterStop = await inner.evaluate(
        (path) => fetch(path).then((r) => r.text()),
        `${MESH_PREFIX}12D3Koo/llm`,
      );
      check(
        browserName,
        `the ${MESH_PREFIX} mount survives a worker restart`,
        meshAfterStop === `mesh:${MESH_PREFIX}12D3Koo/llm`,
        meshAfterStop,
      );
    }
    // NO FIREFOX EQUIVALENT: only Chromium can stop a worker on demand (CDP).
    // Left as a Chromium-only check rather than replaced by something weaker.

    // The shell's own files bypass the worker.
    const relayHtml = await inner.evaluate(() => fetch("/relay.html").then((r) => r.text()));
    check(
      browserName,
      "relay.html comes from the network, not the app",
      relayHtml.includes("httpeers session relay"),
    );

    const missing = await inner.evaluate(() =>
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
      hijack.includes(`"${APP_SERVICE_KEY}" is already served by another client`),
      hijack,
    );

    // A KEY THE APP NEVER CLAIMED is the other half of the refusal, and the
    // half `takeover: "first-wins"` does not cover -- see `tryTestService`.
    // `/index.html` normalises to a longer prefix than the app's `/`, so an
    // accepted registration here would serve the session's own index page.
    const rogue = await context.newPage();
    await rogue.goto(`${GHOST}/ghost.html`);
    const offAllowlist = await rogue
      .evaluate((s) => window.tryTestService(s, "alpha", "evil", "/index.html"), SHELL)
      .catch(String);
    check(
      browserName,
      "a second app cannot register a key outside the session's allowlist",
      offAllowlist.includes('may not register "evil"'),
      offAllowlist,
    );

    const indexAfterRogue = await bodyOf(inner, "/index.html");
    check(
      browserName,
      "and /index.html is still the app's",
      indexAfterRogue.includes("hello from the app"),
      indexAfterRogue.slice(0, 48),
    );
    await rogue.close();

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

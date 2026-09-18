/**
 * `mountEdge` across the ways a page gets (re)loaded -- in real Chromium and Firefox.
 *
 *   pnpm --filter @statewalker/httpeers-member build   # this reads its dist/
 *   node scripts/edge-reload.mjs                       # or: pnpm run test:reload
 *
 * WHY A SCRIPT AND NOT A VITEST BROWSER TEST. What is under test is what a
 * RELOAD does, and a vitest browser test runs inside the page it would have to
 * reload. So this drives Playwright directly against a tiny page that mounts a
 * `dispatch` answering "pong" on the edge, and asserts after every load that
 * `mountEdge` resolved and a `fetch()` through the edge came back "pong".
 *
 * THE REGRESSION. A hard reload loads the page bypassing its ServiceWorker, by
 * spec: the page is uncontrolled while the worker is already active (and
 * claimed long ago), so no `controllerchange` ever comes, and `mountEdge`
 * waited forever inside `SwHttpAdapter.start()`. llm-chat's mesh.html shipped
 * with that ("Joining… (mounting-edge)" for good). See
 * `httpeers-member/src/edge-control.ts`.
 *
 * WHAT A HARD RELOAD IS HERE. Chromium: CDP `Page.reload({ ignoreCache: true })`,
 * which is what Ctrl+Shift+R sends. Firefox: `location.reload(true)` -- Firefox
 * still honours the non-standard `forceGet` argument and treats it as a
 * cache- and ServiceWorker-bypassing reload. Playwright's keyboard cannot
 * press the browser's own Ctrl+Shift+R (it types into the page; measured: no
 * reload happens), and Playwright's Firefox has no ignore-cache reload.
 *
 * Scenarios, per browser: first visit, normal reload, hard reload, a second
 * tab, and a hard reload with the reload guard already spent -- which must
 * FAIL LOUDLY with the "close the tab and reopen it" error, not hang.
 *
 * Nothing is bundled: the page imports `httpeers-member`'s `dist/edge.js`
 * through an import map, and that file's only bare import,
 * `@statewalker/webrun-http-browser/sw`, is a self-contained bundle.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";

const resolveFile = (specifier) => fileURLToPath(import.meta.resolve(specifier));
const MEMBER_DIST = dirname(resolveFile("@statewalker/httpeers-member/browser"));
const EDGE_SW_MODULE = resolveFile("@statewalker/webrun-http-browser/sw");
const SW_WORKER = resolveFile("@statewalker/webrun-http-browser/sw-worker");

/** Generous: a hang is what is being tested for, and a hang does not finish early. */
const SETTLE_MS = 20_000;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>edge reload</title>
<script type="importmap">
{ "imports": { "@statewalker/webrun-http-browser/sw": "/lib/webrun-sw.js" } }
</script>
<script type="module">
  window.__loads = Number(sessionStorage.getItem("loads") ?? 0) + 1;
  sessionStorage.setItem("loads", String(window.__loads));
  window.__edge = { state: "mounting" };
  window.__controlledAtLoad = navigator.serviceWorker.controller != null;
  try {
    const { mountEdge } = await import("/member/edge.js");
    const edge = await mountEdge({
      key: "reload-test",
      dispatch: async () => new Response("pong"),
    });
    const res = await fetch(new URL("ping", edge.baseUrl));
    window.__edge = { state: "ok", body: await res.text() };
  } catch (err) {
    window.__edge = { state: "error", message: String(err?.message ?? err) };
  }
</script>
<p>edge reload test</p>`;

async function serve() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    try {
      let body;
      let type = "text/javascript";
      if (path === "/" || path === "/index.html") {
        body = PAGE;
        type = "text/html";
      } else if (path === "/sw.js") body = await readFile(SW_WORKER);
      else if (path === "/lib/webrun-sw.js") body = await readFile(EDGE_SW_MODULE);
      else if (/^\/member\/[\w-]+\.js$/.test(path)) {
        body = await readFile(join(MEMBER_DIST, path.slice("/member/".length)));
      } else throw new Error("not found");
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

/**
 * Wait for the page's verdict; a page still "mounting" after SETTLE_MS is the
 * hang. `minLoads` makes it ignore the page that was there before a reload
 * that has not happened yet (the per-tab load counter lives in sessionStorage).
 */
async function verdict(page, minLoads = 1) {
  const started = Date.now();
  for (;;) {
    const v = await page
      .evaluate(() => ({
        edge: window.__edge,
        loads: window.__loads,
        controlledAtLoad: window.__controlledAtLoad,
        controlled: navigator.serviceWorker.controller != null,
      }))
      .catch(() => null); // mid-navigation
    if (v?.edge != null && v.edge.state !== "mounting" && v.loads >= minLoads) return v;
    if (Date.now() - started > SETTLE_MS) return v ?? { edge: { state: "no page" } };
    await page.waitForTimeout(250);
  }
}

async function hardReload(name, context, page) {
  if (name === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.reload", { ignoreCache: true });
    await cdp.detach();
  } else {
    // Returns before the navigation starts; `verdict(page, minLoads)` waits it out.
    await page.evaluate(() => location.reload(true));
  }
}

const site = await serve();
const failures = [];
const report = (browser, scenario, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${browser.padEnd(8)} ${scenario.padEnd(34)} ${detail}`);
  if (!ok) failures.push(`${browser}: ${scenario}: ${detail}`);
};
const describe = (v) =>
  `edge=${v.edge.state}${v.edge.body ? `(${v.edge.body})` : ""}${
    v.edge.message ? ` "${v.edge.message.slice(0, 90)}…"` : ""
  } controlledAtLoad=${v.controlledAtLoad} controlled=${v.controlled} loads=${v.loads}`;
const pong = (v) => v.edge.state === "ok" && v.edge.body === "pong" && v.controlled;

try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["firefox", firefox],
  ]) {
    const browser = await type.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(site.url);
      let v = await verdict(page);
      report(name, "first visit", pong(v) && v.loads === 1, describe(v));

      await page.reload();
      v = await verdict(page, 2);
      report(name, "normal reload", pong(v) && v.controlledAtLoad, describe(v));

      // THE REGRESSION: uncontrolled at load, so the edge must reload once itself --
      // two loads for one hard reload, the second controlled and answering.
      const before = v.loads;
      await hardReload(name, context, page);
      v = await verdict(page, before + 1);
      report(
        name,
        "hard reload",
        pong(v) && v.controlledAtLoad && v.loads === before + 2,
        describe(v),
      );

      const second = await context.newPage();
      await second.goto(site.url);
      v = await verdict(second);
      report(name, "second tab", pong(v), describe(v));
      const first = await verdict(page);
      report(name, "first tab, after the second opened", pong(first), describe(first));
      await second.close();

      // The guard already spent (as if the edge's own reload came back uncontrolled
      // too): the page must say what to do, and neither hang nor reload again.
      await page.evaluate(() =>
        sessionStorage.setItem("httpeers:edge:control-reload", String(Date.now())),
      );
      const beforeSpent = (await verdict(page)).loads;
      await hardReload(name, context, page);
      v = await verdict(page, beforeSpent + 1);
      report(
        name,
        "hard reload, guard already spent",
        v.edge.state === "error" &&
          /close the tab and reopen it/.test(v.edge.message) &&
          v.loads === beforeSpent + 1,
        describe(v),
      );

      // And the next reload recovers normally.
      await page.reload();
      v = await verdict(page, beforeSpent + 2);
      report(name, "normal reload after that", pong(v), describe(v));
    } finally {
      await browser.close();
    }
  }
} finally {
  site.close();
}

if (failures.length > 0) {
  console.error(`\nedge-reload: ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log("\nedge-reload: all scenarios passed");
}

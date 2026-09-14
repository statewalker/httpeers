/**
 * Two pages, two origins, one real mesh — the whole point of the demos.
 *
 * The hub page comes up, mints an invitation, and the images page joins with
 * it. Both are the BUILT sites, served from different ports so each gets its
 * own origin and therefore its own ServiceWorker scope, exactly as
 * `hub.httpeers.net` and `images.httpeers.net` will.
 *
 * It dials the LIVE relay, so this is a smoke test rather than a unit test: it
 * depends on the network and on `relay.httpeers.net` being up. What it answers
 * is the question nothing else can — does a member actually join a hub that is
 * itself a browser tab, over a real WebRTC circuit.
 *
 *   node scripts/join-smoke.mjs
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/** Serve one built page on its own port — its own origin, its own worker scope. */
async function serve(page) {
  const root = join(here, "..", "dist", page);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const path = join(root, url.pathname === "/" ? "index.html" : url.pathname);
      const body = await readFile(path);
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, url: `http://localhost:${server.address().port}/` };
}

const hub = await serve("hub");
const images = await serve("images");
const app = await serve("app");
const proxy = await serve("proxy");
const browser = await chromium.launch();
const problems = [];

/** Mint one invitation and return its blob, waiting until it differs from `previous`. */
async function mint(tab, previous) {
  await tab.click("#mint");
  await tab.waitForSelector("#invitation:not([hidden])", { timeout: 30_000 });
  await tab.waitForFunction(
    (before) => {
      const rows = [...document.querySelectorAll("#invitation-rows dt")];
      const dt = rows.find((el) => el.textContent === "blob");
      const value = dt?.nextElementSibling?.querySelector("span")?.textContent ?? "";
      return value !== "" && value !== before;
    },
    previous,
    { timeout: 30_000 },
  );
  return tab.evaluate(() => {
    const rows = [...document.querySelectorAll("#invitation-rows dt")];
    const dt = rows.find((el) => el.textContent === "blob");
    return dt?.nextElementSibling?.querySelector("span")?.textContent ?? "";
  });
}

function watch(tab, name) {
  tab.on("pageerror", (e) => problems.push(`${name} PAGEERROR ${e.message}`));
  tab.on("console", (m) => {
    if (m.type() === "error") problems.push(`${name} CONSOLE ${m.text()}`);
  });
}

try {
  // --- the hub comes up and mints -----------------------------------------
  const hubTab = await browser.newPage();
  watch(hubTab, "hub");
  await hubTab.goto(hub.url);
  await hubTab.waitForFunction(() => document.querySelector("#state")?.textContent === "ready", {
    timeout: 90_000,
  });
  const meshId = (await hubTab.textContent("#mesh-id"))?.trim();
  console.log(`hub      : ready — ${meshId}`);

  const blob = await mint(hubTab, "");
  if (blob === "") throw new Error("the hub minted no blob");
  console.log(`invite   : ${blob.slice(0, 48)}… (${blob.length} chars)`);

  // --- the member joins with it -------------------------------------------
  const imagesTab = await browser.newPage();
  watch(imagesTab, "images");
  await imagesTab.goto(images.url);
  await imagesTab.waitForFunction(
    () => document.querySelector("#state")?.textContent === "needs-invitation",
    { timeout: 60_000 },
  );
  console.log("images   : needs-invitation (correct: no hubPeerId is published)");

  await imagesTab.fill("#invite", blob);
  await imagesTab.click("#join");
  await imagesTab.waitForFunction(
    () => {
      const s = document.querySelector("#state")?.textContent ?? "";
      return s === "live" || s === "failed" || s === "blocked";
    },
    { timeout: 120_000 },
  );

  const state = (await imagesTab.textContent("#state"))?.trim();
  const peerId = (await imagesTab.textContent("#peer-id"))?.trim();
  const status = (await imagesTab.textContent("#live-status"))?.trim();
  console.log(`images   : ${state} — ${peerId}`);
  if (status) console.log(`status   : ${status.slice(0, 200)}`);

  // --- and the hub sees it ------------------------------------------------
  if (state === "live") {
    await hubTab
      .waitForFunction(
        (id) => document.querySelector("#members")?.textContent?.includes(id) === true,
        peerId,
        { timeout: 30_000 },
      )
      .catch(() => {});
    const members = (await hubTab.textContent("#members"))?.trim() ?? "";
    console.log(`hub sees : ${members.includes(peerId) ? "the member" : "NOBODY"}`);
  }

  // --- the consumer joins, discovers the provider, and CALLS it -----------
  const appTab = await browser.newPage();
  watch(appTab, "app");
  await appTab.goto(app.url);
  await appTab.waitForFunction(
    () => document.querySelector("#state")?.textContent === "needs-invitation",
    { timeout: 60_000 },
  );

  // A FRESH invitation. They are single-use, and reading the blob straight
  // after the click races `invitations.create` -- which on the first run handed
  // the app the one `images` had already redeemed, so its join was refused and
  // the page sat in `needs-invitation` until the wait timed out.
  const blob2 = await mint(hubTab, blob);
  await appTab.fill("#invite", blob2);
  await appTab.click("#join");
  await appTab
    .waitForFunction(
      () => {
        const s = document.querySelector("#state")?.textContent ?? "";
        return s === "live" || s === "failed" || s === "blocked";
      },
      { timeout: 120_000 },
    )
    .catch(() => {});
  const appState = (await appTab.textContent("#state"))?.trim();
  console.log(`app      : ${appState} — ${(await appTab.textContent("#peer-id"))?.trim()}`);

  // The provider has to appear in the app's mesh view first: it arrives on
  // this page's own heartbeat, not instantly.
  await appTab
    .waitForFunction(
      () => (document.querySelector("#images-provider")?.textContent ?? "").includes("—"),
      { timeout: 60_000 },
    )
    .catch(() => {});
  console.log(`discovers: ${(await appTab.textContent("#images-provider"))?.trim()}`);

  await appTab.click("#load-images");
  await appTab
    .waitForFunction(
      () => {
        const t = document.querySelector("#images-status")?.textContent ?? "";
        return t !== "" && t !== "loading…";
      },
      { timeout: 90_000 },
    )
    .catch(() => {});
  const imagesStatus = (await appTab.textContent("#images-status"))?.trim();
  const rendered = await appTab.evaluate(() => document.querySelectorAll("#gallery img").length);
  console.log(`app calls: ${imagesStatus} (${rendered} <img> rendered)`);

  // COUNTING <img> ELEMENTS IS NOT PROOF. A broken src still renders an element,
  // so a provider serving HTML error pages as image/jpeg would read as success.
  // `naturalWidth` is non-zero only once the browser has actually DECODED the
  // bytes -- and these bytes came over the mesh, so it is the whole path.
  await appTab
    .waitForFunction(
      () => [...document.querySelectorAll("#gallery img")].some((i) => i.naturalWidth > 0),
      { timeout: 30_000 },
    )
    .catch(() => {});
  const decoded = await appTab.evaluate(() =>
    [...document.querySelectorAll("#gallery img")].map(
      (i) => `${i.naturalWidth}x${i.naturalHeight}`,
    ),
  );
  const good = decoded.filter((d) => !d.startsWith("0x")).length;
  console.log(`decoded  : ${good}/${decoded.length} — ${decoded.join(" ") || "none"}`);

  await appTab.fill("#query", "relay");
  await appTab.click("#do-search");
  await appTab
    .waitForFunction(
      () => {
        const t = document.querySelector("#search-status")?.textContent ?? "";
        return t !== "" && t !== "searching…";
      },
      { timeout: 90_000 },
    )
    .catch(() => {});
  console.log(`app search: ${(await appTab.textContent("#search-status"))?.trim()}`);

  // --- the proxy joins, takes a route, and forwards to a real origin -------
  const proxyTab = await browser.newPage();
  watch(proxyTab, "proxy");
  await proxyTab.goto(proxy.url);
  await proxyTab.waitForFunction(
    () => document.querySelector("#state")?.textContent === "needs-invitation",
    { timeout: 60_000 },
  );
  const blob3 = await mint(hubTab, blob2);
  await proxyTab.fill("#invite", blob3);
  await proxyTab.click("#join");
  await proxyTab
    .waitForFunction(
      () => {
        const s = document.querySelector("#state")?.textContent ?? "";
        return s === "live" || s === "failed" || s === "blocked";
      },
      { timeout: 120_000 },
    )
    .catch(() => {});
  const proxyState = (await proxyTab.textContent("#state"))?.trim();
  console.log(`proxy    : ${proxyState}`);

  // The relay's own well-known document is a real, CORS-open origin that is
  // definitely up -- we already read it to get here.
  await proxyTab.fill("#route-prefix", "/relay");
  await proxyTab.fill("#route-upstream", "https://relay.httpeers.net/.well-known");
  await proxyTab.click("#add-route");
  await proxyTab.waitForFunction(
    () => (document.querySelector("#route-status")?.textContent ?? "").startsWith("added"),
    { timeout: 20_000 },
  );
  console.log(`route    : ${(await proxyTab.textContent("#route-status"))?.trim()}`);

  await proxyTab.fill("#console-path", "/relay/httpeers-relay.json");
  await proxyTab.click("#console-send");
  await proxyTab
    .waitForFunction(() => (document.querySelector("#console-output")?.textContent ?? "") !== "", {
      timeout: 60_000,
    })
    .catch(() => {});
  const out = ((await proxyTab.textContent("#console-output")) ?? "").trim();
  console.log(
    `proxied  : ${out.split("\n")[0]} — ${out.includes("relayAddrs") ? "got the upstream body" : "NO BODY"}`,
  );

  if (problems.length > 0)
    console.log(`problems : ${problems.slice(0, 6).join(" | ").slice(0, 900)}`);
  process.exitCode = state === "live" && appState === "live" && proxyState === "live" ? 0 : 1;
} finally {
  await browser.close();
  hub.server.close();
  images.server.close();
  app.server.close();
  proxy.server.close();
}

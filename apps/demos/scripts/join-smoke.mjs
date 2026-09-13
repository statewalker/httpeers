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

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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
const browser = await chromium.launch();
const problems = [];

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
  await hubTab.waitForFunction(
    () => document.querySelector("#state")?.textContent === "ready",
    { timeout: 90_000 },
  );
  const meshId = (await hubTab.textContent("#mesh-id"))?.trim();
  console.log(`hub      : ready — ${meshId}`);

  await hubTab.click("#mint");
  // The blob row is rendered once the invitation exists.
  await hubTab.waitForSelector("#invitation:not([hidden])", { timeout: 30_000 });
  const blob = await hubTab.evaluate(() => {
    const rows = [...document.querySelectorAll("#invitation-rows dt")];
    const dt = rows.find((el) => el.textContent === "blob");
    return dt?.nextElementSibling?.querySelector("span")?.textContent ?? "";
  });
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

  if (problems.length > 0) console.log(`problems : ${problems.slice(0, 6).join(" | ").slice(0, 900)}`);
  process.exitCode = state === "live" ? 0 : 1;
} finally {
  await browser.close();
  hub.server.close();
  images.server.close();
}

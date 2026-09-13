/**
 * Drive a BUILT demo page in a real browser and report what it reached.
 *
 * Not a unit test, deliberately: it serves `dist/<page>` over a local HTTP
 * server and dials the LIVE relay, so it depends on the network and on
 * `relay.httpeers.net` being up. Wiring that into `pnpm test` would make the
 * suite fail for reasons that have nothing to do with the code.
 *
 * What it is for is the question no unit test answers: does the thing we are
 * about to publish actually come up? It caught a zero-byte ServiceWorker and a
 * rule set that parsed before the wasm was armed, both of which type-checked
 * and unit-tested perfectly.
 *
 *   node scripts/smoke.mjs hub
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const page = process.argv[2] ?? "hub";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", page);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

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
const { port } = server.address();

const browser = await chromium.launch();
const tab = await browser.newPage();
const problems = [];
tab.on("pageerror", (error) => problems.push(`PAGEERROR ${error.message}`));
tab.on("console", (m) => {
  if (m.type() === "error") problems.push(`CONSOLE ${m.text()}`);
});

await tab.goto(`http://localhost:${port}/`);
// `ready` or `error` — both are answers. A timeout means it is still trying,
// which is itself the report.
await tab
  .waitForFunction(
    () => {
      const state = document.querySelector("#state")?.textContent ?? "";
      return state === "ready" || state === "error";
    },
    { timeout: 90_000 },
  )
  .catch(() => {});

const read = async (id) => (await tab.textContent(id).catch(() => null))?.trim() ?? "";
const state = await read("#state");
console.log(`page     : ${page}`);
console.log(`state    : ${state}`);
for (const id of ["#mesh-id", "#peer-id", "#circuit", "#base-url", "#error"]) {
  const value = await read(id);
  if (value !== "" && value !== "…") console.log(`${id.slice(1).padEnd(9)}: ${value.slice(0, 160)}`);
}
if (problems.length > 0) console.log(`problems : ${problems.slice(0, 5).join(" | ").slice(0, 800)}`);

await browser.close();
server.close();
process.exit(state === "ready" && problems.length === 0 ? 0 : 1);

// Runs every live example of the built site in Chromium, as a visitor would: opens
// /examples/<slug>/, presses Run, and reads the status line. Fails when an example fails (an
// example throws when what it demonstrates did not happen), when the page logs an error, or when
// one does not finish in time.
//
//   pnpm build && pnpm check:examples            (serves dist/ on a port of its own)
//   pnpm check:examples access-tokens            (some examples only)
//
// PW_CHROMIUM=/path/to/chrome picks the browser binary.

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../dist/", import.meta.url).pathname;
// The example pages the build wrote: one directory per example.
const all = (await import("node:fs"))
  .readdirSync(join(DIST, "examples"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const only = process.argv.slice(2);
const list = all.filter((name) => !only.length || only.includes(name));
if (!list.length) {
  console.error(`no example pages in ${DIST}examples/ (run the build first)`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  let file = join(DIST, normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const failures = [];
try {
  for (const name of list) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    let status;
    try {
      await page.goto(`${base}/examples/${name}/`);
      await page.click("[data-run-button]");
      await page.waitForFunction(
        () =>
          /^(Finished|Failed)/.test(document.querySelector("[data-run-status]")?.textContent ?? ""),
        null,
        { timeout: 60_000 },
      );
      status = (await page.textContent("[data-run-status]"))?.trim();
    } catch (err) {
      status = `Failed: ${err.message.split("\n")[0]}`;
    }
    const ok = status?.startsWith("Finished") && !errors.length;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${status}`);
    for (const e of errors) console.log(`     page error: ${e}`);
    if (!ok) {
      console.log((await page.textContent("[data-run-output]").catch(() => ""))?.trim());
      failures.push(name);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} example(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nall ${list.length} examples ran as expected`);

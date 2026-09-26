/**
 * The built standalone page (`dist/index.html`), in a real Chromium, against a fake
 * OpenAI-compatible endpoint -- the acceptance spec for the TODO's "check that the chat
 * application works properly without a mesh".
 *
 *   pnpm run build && node tests/e2e/standalone.spec.mjs
 *
 * jsdom (the rest of this suite) proves behaviour but nothing about a real browser: no real
 * ServiceWorker registry, no real network stack, no real CSS. This spec drives dist/index.html
 * exactly as a browser would, served statically with no server-side logic (`webrun-modules serves
 * statically` applies to the app's own assets the same way it does to a member's).
 *
 * "Works without a mesh" is NOT "the page renders" -- it is that the page reaches for nothing:
 * assertion 6 checks no ServiceWorker is ever registered and that the only two origins the whole
 * run ever talks to are the static file server (the page's own origin) and the fake endpoint. If
 * that assertion fails, something really is reaching out; the fix is to find and remove the
 * reach-out, never to relax the assertion.
 *
 * Promotes `scripts/smoke.mjs`'s dist-serving harness (the `serveDist` helper below is that one,
 * verbatim) rather than writing a second, divergent one. `smoke.mjs` itself targets the dead
 * two-dialog flow (a separate "Choose a model" dialog, a "Change connection" button, a dialog
 * titled "Connection settings") that Task 5 replaced with one slot-filled, tabbed Settings dialog;
 * it has been updated in the same commit as this file to match the app as built, so both harnesses
 * target real, current selectors.
 *
 * Exits non-zero on the first failed assertion and prints which one, plus every page error/request
 * seen so far, so a failure here is diagnosable without rerunning under a debugger.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startFakeLlm } from "../../scripts/fake-llm.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

/** Verbatim from `scripts/smoke.mjs`: serves `dist/` on a random localhost port. */
async function serveDist() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = path === "/" ? "/index.html" : path;
    try {
      const body = await readFile(join(DIST, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

/** Holds the *first* SSE event this long -- long enough that assertion 3's elapsed counter can
 * legitimately be seen to reach 1s before the reply starts. */
const FIRST_TOKEN_DELAY_MS = 2000;

const llm = await startFakeLlm({ firstTokenDelayMs: FIRST_TOKEN_DELAY_MS });
const site = await serveDist();
const browser = await chromium.launch();
// A fresh context, never a shared one: assertion 1 needs genuinely empty storage.
const context = await browser.newContext();
const page = await context.newPage();

/** Assertion 7: zero page errors and zero unhandled rejections for the whole run. */
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
});
// Chromium's Runtime.exceptionThrown (what Playwright's "pageerror" is built on) does cover
// unhandled promise rejections, but a page-level listener is cheap insurance against relying on
// that alone, and it names the failure mode assertion 7 actually asks about.
await page.exposeFunction("__reportUnhandledRejection__", (message) => {
  errors.push(`unhandledrejection: ${message}`);
});
await page.addInitScript(() => {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    window.__reportUnhandledRejection__(message);
  });
});

/** Assertion 6: every request the whole run makes, host included. */
const requests = [];
page.on("request", (request) => requests.push(request.url()));

let step = "start";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  step = "assertion 1: cold load lands on a non-dismissible settings screen";
  await page.goto(site.url);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  check(
    (await settings.getByRole("button", { name: "Cancel" }).count()) === 0,
    "the settings dialog has a Cancel button on first run",
  );
  check(
    (await page.getByRole("button", { name: "New chat" }).count()) === 0,
    "the chat behind the first-run dialog is reachable",
  );
  // Every way a Radix dialog can normally be dismissed: Escape, the overlay, its own Close button.
  // `ChatApp`'s `onOpenChange` ignores all three while `dismissible` is false -- none should work.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  await settings.waitFor();
  await page.mouse.click(5, 5); // the overlay, far from the centered dialog card
  await page.waitForTimeout(100);
  await settings.waitFor();
  await settings.getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(100);
  await settings.waitFor();
  check(
    (await page.getByRole("button", { name: "New chat" }).count()) === 0,
    "Escape/overlay/Close dismissed the supposedly non-dismissible settings dialog",
  );

  step = "assertion 2: the fake endpoint's base URL moves to model selection listing its models";
  await page.getByLabel("Base URL").fill(llm.baseUrl);
  await page.getByLabel("API key").fill("test-key");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("tab", { name: "Models", selected: true }).waitFor();
  await settings.getByLabel("alpha").waitFor();
  await settings.getByLabel("beta").waitFor();
  check(
    (await settings.locator('input[type="radio"][name="model"]').count()) === 2,
    "expected exactly the fake's two models (alpha, beta) listed",
  );
  await settings.getByLabel("beta").check();
  await settings.getByRole("button", { name: "Use model" }).click();
  await settings.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "New chat" }).waitFor();

  step = "assertion 3: a 2s first-token delay shows waiting (elapsed >= 1s), then the reply";
  await page.getByLabel("Message").fill("hello");
  await page.getByRole("button", { name: "Send" }).click();
  const waiting = page.getByTestId("waiting-indicator");
  await waiting.waitFor();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="waiting-indicator"]');
      const match = el && /(\d+)s/.exec(el.textContent ?? "");
      return match != null && Number(match[1]) >= 1;
    },
    { timeout: FIRST_TOKEN_DELAY_MS + 3_000 },
  );
  const expectedReply = "reply to: hello (model beta)";
  await page
    .locator('[data-role="assistant"]')
    .last()
    .locator(`text=${expectedReply}`)
    .waitFor({ timeout: FIRST_TOKEN_DELAY_MS + 5_000 });
  await waiting.waitFor({ state: "detached" });
  // The composer's Send button is always rendered (merely disabled while running), so it is not a
  // usable idle signal on its own -- Stop's presence/absence is what actually tracks `isRunning`.
  await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  check(llm.stats.completions >= 1, "the fake never reported a finished completion");

  step = "assertion 4: Stop during the wait returns to idle, leaving the partial session intact";
  await page.getByLabel("Message").fill("second");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  check(
    (await page.getByRole("button", { name: "Stop" }).count()) === 0,
    "Stop did not return the composer to idle",
  );
  check(
    (await waiting.count()) === 0,
    "the waiting indicator is still showing after Stop returned to idle",
  );
  const userTexts = await page.locator('[data-role="user"]').allInnerTexts();
  const assistantTexts = await page.locator('[data-role="assistant"]').allInnerTexts();
  check(
    userTexts.length === 2 && userTexts[0].includes("hello") && userTexts[1].includes("second"),
    `expected both turns' user messages intact, saw: ${JSON.stringify(userTexts)}`,
  );
  check(
    assistantTexts.length === 1 && assistantTexts[0].includes(expectedReply),
    `expected only the first reply, no reply to the stopped turn, saw: ${JSON.stringify(assistantTexts)}`,
  );

  step = "assertion 5: the settings dialog has exactly two tabs -- Connection and Models";
  await page.getByRole("button", { name: "Settings" }).click();
  const reopened = page.getByRole("dialog", { name: "Settings" });
  await reopened.waitFor();
  const tabs = await reopened.getByRole("tab").allInnerTexts();
  check(
    tabs.length === 2 && tabs.includes("Connection") && tabs.includes("Models"),
    `expected exactly [Connection, Models], saw: ${JSON.stringify(tabs)}`,
  );
  check(
    (await reopened.getByRole("tab", { name: "Sharing" }).count()) === 0,
    "a Sharing tab is present on the standalone page",
  );
  check(
    (await reopened.getByRole("tab", { name: "Keys" }).count()) === 0,
    "a Keys tab is present on the standalone page",
  );
  await reopened.getByRole("button", { name: "Close" }).click();
  await reopened.waitFor({ state: "detached" });

  step = "assertion 6: no ServiceWorker, no request to any host but the fake endpoint";
  const swRegistrations = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length;
  });
  check(swRegistrations === 0, `expected no ServiceWorker registrations, saw ${swRegistrations}`);
  check(
    requests.every((url) => !url.endsWith("/sw.js")),
    `dist/sw.js was requested even though nothing on the standalone page should register it: ${JSON.stringify(requests.filter((u) => u.endsWith("/sw.js")))}`,
  );
  const origins = [...new Set(requests.map((url) => new URL(url).origin))].sort();
  const expectedOrigins = [new URL(site.url).origin, new URL(llm.baseUrl).origin].sort();
  check(
    origins.length === expectedOrigins.length && origins.every((o, i) => o === expectedOrigins[i]),
    `expected requests only to the app's own origin and the fake endpoint's; saw: ${JSON.stringify(origins)} (expected ${JSON.stringify(expectedOrigins)})`,
  );

  step = "assertion 7: zero page errors and zero unhandled rejections for the whole run";
  check(errors.length === 0, `page problems recorded during the run:\n${errors.join("\n")}`);

  console.log("standalone.spec: all seven assertions passed");
  console.log(`  requests reached exactly these origins: ${JSON.stringify(origins)}`);
  console.log(`  ServiceWorker registrations: ${swRegistrations}`);
  console.log(`  fake LLM completions observed: ${llm.stats.completions}`);
} catch (error) {
  console.error(`standalone.spec FAILED at "${step}": ${error.message}`);
  if (errors.length > 0) console.error(`page problems:\n${errors.join("\n")}`);
  console.error(`requests seen (${requests.length}):\n${requests.join("\n")}`);
  await page.screenshot({ path: join(DIST, "..", "standalone-spec-failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
  await llm.close();
}

/**
 * The built standalone page (`dist/index.html`), in a real Chromium, at two REAL viewports --
 * `AppShell`'s only acceptance spec for its sidebar/Sheet breakpoint. jsdom (the rest of this
 * suite) has no layout engine: it can tell you a `<div>` carries the class `md:hidden`, never
 * whether anything is actually hidden on screen. Task 6 built the shell and deferred exactly this
 * question here; nothing in jsdom may be repeated in this file, and nothing here may fall back to
 * asserting a class name in its place -- see each check below, every one of them reads
 * `boundingBox()`/`isVisible()`, never `className`.
 *
 *   pnpm run build && node tests/e2e/responsive.spec.mjs
 *
 * Same static-server-plus-fake-endpoint harness as `standalone.spec.mjs` (the `serveDist` helper is
 * copied verbatim from there, which copied it verbatim from `scripts/smoke.mjs` -- three copies of
 * four lines beats a fourth shared module for something this small and this stable).
 *
 * Ten assertions, numbered below as they run:
 *   at 1280x800 (desktop): thread list visible (1), no menu button (2), composer visible without
 *     scrolling (3);
 *   at 390x844 (a phone): thread list not visible (4), menu button visible / opens the thread list /
 *     Escape closes it (5), composer visible without scrolling (6), no horizontal scroll -- the
 *     `scrollWidth <= innerWidth` check that a desktop window narrowed by hand cannot fake (7),
 *     the composer stays on screen after being focused (8);
 *   then, at BOTH viewports: the settings dialog is fully on screen and every tab is reachable
 *     (9 at 1280x800, 10 at 390x844).
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

/** Verbatim from `scripts/smoke.mjs` / `standalone.spec.mjs`: serves `dist/` on a random port. */
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

const llm = await startFakeLlm();
const site = await serveDist();
const browser = await chromium.launch();

let step = "start";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Whether `locator` resolves to exactly one element that is on screen. Never a class-name check. */
async function visible(locator) {
  const count = await locator.count();
  if (count === 0) return false;
  return locator.first().isVisible();
}

/** `box.y2 <= viewportHeight` etc: the element's whole bounding box sits inside the viewport. */
function within(box, width, height) {
  return (
    box != null &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= width + 0.5 &&
    box.y + box.height <= height + 0.5
  );
}

/** Cold-loads the standalone page and drives it to the "chat" step: an endpoint and a model set. */
async function reachChat(page) {
  await page.goto(site.url);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  await page.getByLabel("Base URL").fill(llm.baseUrl);
  await page.getByLabel("API key").fill("test-key");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("tab", { name: "Models", selected: true }).waitFor();
  await settings.getByLabel("alpha").waitFor();
  await settings.getByLabel("alpha").check();
  await settings.getByRole("button", { name: "Use model" }).click();
  await settings.waitFor({ state: "detached" });
  // Not "New chat": that button lives in the thread list, which is legitimately not visible at a
  // phone viewport (assertion 4) -- the composer is the one thing always on screen once chat is
  // reached, at either viewport.
  await page.getByLabel("Message").waitFor();
}

/** Assertions 9/10: the settings dialog stays fully on screen and every tab can be reached. */
async function checkSettingsDialogOnScreen(page, width, height, label) {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  const dialogBox = await dialog.boundingBox();
  check(
    within(dialogBox, width, height),
    `[${label}] the settings dialog is not fully on screen: ${JSON.stringify(dialogBox)} vs ${width}x${height}`,
  );
  const tabs = dialog.getByRole("tab");
  const tabCount = await tabs.count();
  check(tabCount > 0, `[${label}] the settings dialog shows no tabs`);
  for (let i = 0; i < tabCount; i++) {
    const tab = tabs.nth(i);
    const tabBox = await tab.boundingBox();
    const name = await tab.innerText();
    check(
      within(tabBox, width, height),
      `[${label}] tab "${name}" is not fully on screen: ${JSON.stringify(tabBox)}`,
    );
    check(await tab.isVisible(), `[${label}] tab "${name}" is not visible`);
    // "Reachable" means actually clickable, not merely present -- click it and confirm it selects.
    await tab.click();
    await tab.waitFor({ state: "visible" });
    check(
      (await tab.getAttribute("data-state")) === "active",
      `[${label}] clicking tab "${name}" did not select it`,
    );
  }
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
}

/** Whichever viewport's page is active, for a screenshot if the `catch` below fires. */
let currentPage = null;

try {
  // ---------------------------------------------------------------------------------------------
  step = "desktop (1280x800) setup";
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const desktop = await desktopContext.newPage();
  currentPage = desktop;
  await reachChat(desktop);

  step = "assertion 1: the thread list is visible at 1280x800";
  const desktopThreadList = desktop.getByRole("navigation", { name: "Conversations" });
  check(await visible(desktopThreadList), "the thread list is not visible at 1280x800");

  step = "assertion 2: there is no menu button at 1280x800";
  const desktopMenuButton = desktop.getByRole("button", { name: "Conversations" });
  check(
    !(await visible(desktopMenuButton)),
    "a menu button is visible at 1280x800, where the thread list is already a permanent column",
  );

  step = "assertion 3: the composer is visible without scrolling at 1280x800";
  const desktopComposer = desktop.getByLabel("Message");
  check(await desktopComposer.isVisible(), "the composer is not visible at 1280x800");
  const desktopComposerBox = await desktopComposer.boundingBox();
  check(
    within(desktopComposerBox, 1280, 800),
    `the composer needs scrolling at 1280x800: ${JSON.stringify(desktopComposerBox)}`,
  );

  step = "assertion 9: the settings dialog is fully on screen at 1280x800, tabs reachable";
  await checkSettingsDialogOnScreen(desktop, 1280, 800, "1280x800");

  await desktopContext.close();

  // ---------------------------------------------------------------------------------------------
  step = "phone (390x844) setup";
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage();
  currentPage = phone;
  await reachChat(phone);

  step = "assertion 4: the thread list is not visible at 390x844";
  const phoneThreadList = phone.getByRole("navigation", { name: "Conversations" });
  check(!(await visible(phoneThreadList)), "the thread list is visible at 390x844");

  // A 55-char message -- under `titleFrom`'s 60-char cap, so the session's title is the message
  // verbatim, not an ellipsis-truncated prefix the test would have to reconstruct. Realistic, not a
  // contrived edge case: it's what any user typing more than a few words produces. Sent here,
  // before assertion 5, so the thread list the Sheet reveals below has a real row to check, not an
  // empty one.
  step =
    "(setup) a message long enough to give the session a title that overflows a phone-width row";
  // Says nothing containing "message": `getByLabel("Message")` (the composer, used throughout this
  // file) matches by accessible-name substring, and this text becomes the session's title, i.e.
  // the delete button's own accessible name below -- a literal "message" in it would make that
  // query resolve to two elements.
  const longMessage = "this text is long enough to overflow the session row nicely";
  await phone.getByLabel("Message").fill(longMessage);
  await phone.getByRole("button", { name: "Send" }).click();
  await phone
    .locator('[data-role="assistant"]')
    .last()
    .locator(`text=reply to: ${longMessage}`)
    .waitFor({ timeout: 15_000 });

  step = "assertion 5: the menu button is visible; clicking it reveals the thread list";
  const phoneMenuButton = phone.getByRole("button", { name: "Conversations" });
  check(await visible(phoneMenuButton), "the menu button is not visible at 390x844");
  await phoneMenuButton.click();
  await phone.waitForTimeout(350); // the Sheet's own slide-in animation (Task 6: 300-500ms)
  check(await visible(phoneThreadList), "clicking the menu button did not reveal the thread list");

  step = "assertion 5 (continued): the long-titled session's own delete button stays on screen";
  // Not just "the nav landmark is visible": a landmark can be on screen while ITS CONTENTS overflow
  // it (found by hand while building this spec -- `@radix-ui/react-scroll-area`'s Viewport wraps
  // children in an inline `display:table` div that ignores `truncate`/`min-w-0` below it, so a long
  // session title pushed its own delete button out of the drawer, clipped locally by the
  // ScrollArea, with no page-level horizontal scroll to show for it -- see `styles.css`'s
  // `[data-radix-scroll-area-viewport] > div` rule and `ThreadList.tsx`'s `min-w-0`, both fixed in
  // this same commit).
  const deleteButton = phoneThreadList.getByRole("button", { name: `Delete ${longMessage}` });
  await deleteButton.waitFor();
  const deleteButtonBox = await deleteButton.boundingBox();
  check(
    within(deleteButtonBox, 390, 844),
    `the session's delete button is clipped out of the drawer: ${JSON.stringify(deleteButtonBox)}`,
  );

  step = "assertion 5 (continued): Escape hides the thread list again";
  await phone.keyboard.press("Escape");
  await phone.waitForTimeout(350);
  check(!(await visible(phoneThreadList)), "Escape did not hide the thread list again");

  step = "assertion 6: the composer is visible without scrolling at 390x844";
  const phoneComposer = phone.getByLabel("Message");
  check(await phoneComposer.isVisible(), "the composer is not visible at 390x844");
  const phoneComposerBox = await phoneComposer.boundingBox();
  check(
    within(phoneComposerBox, 390, 844),
    `the composer needs scrolling at 390x844: ${JSON.stringify(phoneComposerBox)}`,
  );

  step = "assertion 7: no horizontal scroll at 390x844 (document.scrollWidth <= window.innerWidth)";
  const scrollWidths = await phone.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  check(
    scrollWidths.scrollWidth <= scrollWidths.innerWidth,
    `horizontal scroll at 390x844: document.documentElement.scrollWidth=${scrollWidths.scrollWidth} > window.innerWidth=${scrollWidths.innerWidth}`,
  );

  step = "assertion 8: the composer stays within the viewport after being focused";
  await phoneComposer.click();
  await phoneComposer.waitFor({ state: "visible" });
  check(
    (await phone.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Message",
    "focusing the composer did not actually focus it",
  );
  const focusedComposerBox = await phoneComposer.boundingBox();
  check(
    within(focusedComposerBox, 390, 844),
    `the focused composer left the viewport: ${JSON.stringify(focusedComposerBox)}`,
  );

  step = "assertion 10: the settings dialog is fully on screen at 390x844, tabs reachable";
  await checkSettingsDialogOnScreen(phone, 390, 844, "390x844");

  await phoneContext.close();

  console.log("responsive.spec: all ten assertions passed");
} catch (error) {
  console.error(`responsive.spec FAILED at "${step}": ${error.message}`);
  await currentPage
    ?.screenshot({ path: join(DIST, "..", "responsive-spec-failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
  await llm.close();
}

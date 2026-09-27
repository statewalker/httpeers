/**
 * The built standalone page, in a real browser, against the fake LLM.
 *
 *   pnpm run build && node scripts/smoke.mjs
 *
 * Exits non-zero on the first failed step and prints what the page showed.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startFakeLlm } from "./fake-llm.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

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
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

let step = "start";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const assistantTexts = () => page.locator('[data-role="assistant"]').allInnerTexts();
const userTexts = () => page.locator('[data-role="user"]').allInnerTexts();
/** Wait until the fake LLM has finished `count` completions and the composer is idle again. */
async function completions(count) {
  for (let i = 0; i < 500 && llm.stats.completions < count; i++) await page.waitForTimeout(20);
  check(
    llm.stats.completions >= count,
    `expected ${count} completions, saw ${llm.stats.completions}`,
  );
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 15_000 });
}

try {
  step = "first run shows settings that cannot be dismissed";
  await page.goto(site.url);
  // One slot-filled, tabbed dialog now (Task 5) -- "Settings", not "Connection settings"; there is
  // no separate "Choose a model" dialog any more, so `settings` is reused for both tabs below.
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  check(
    (await settings.getByRole("button", { name: "Cancel" }).count()) === 0,
    "settings has Cancel on first run",
  );
  check(
    (await page.getByRole("button", { name: "New chat" }).count()) === 0,
    "the chat behind the first-run dialog is reachable",
  );

  step = "Test reports the models";
  await page.getByLabel("Base URL").fill(llm.baseUrl);
  await page.getByLabel("API key").fill("test-key");
  await page.getByRole("button", { name: "Test" }).click();
  await page.getByRole("status").filter({ hasText: "2 model(s)" }).waitFor();

  step = "saving switches the same dialog to the Models tab with the fetched list";
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("tab", { name: "Models", selected: true }).waitFor();
  await settings.getByLabel("beta").waitFor();
  await settings.getByLabel("beta").check();
  await settings.getByRole("button", { name: "Use model" }).click();
  await settings.waitFor({ state: "detached" });

  step = "send streams a reply progressively";
  await page.getByLabel("Message").fill("hello");
  await page.getByRole("button", { name: "Send" }).click();
  const expected = "reply to: hello (model beta)";
  let sawPartial = false;
  for (let i = 0; i < 100; i++) {
    const text = (await assistantTexts()).at(-1) ?? "";
    if (text !== "" && !text.includes("(model beta)")) sawPartial = true;
    if (text.includes(expected)) break;
    await page.waitForTimeout(20);
  }
  await completions(1);
  check((await assistantTexts()).at(-1)?.includes(expected), "the full reply never arrived");
  check(sawPartial, "the reply appeared all at once, not streamed");

  step = "regenerate replaces the reply";
  await page.locator('[data-role="assistant"]').last().hover();
  await page.getByRole("button", { name: "Regenerate" }).click();
  await completions(2);
  check((await assistantTexts()).length === 1, "regenerate added a second reply");

  step = "a follow-up, then editing the first message drops what followed";
  await page.getByLabel("Message").fill("second");
  await page.getByRole("button", { name: "Send" }).click();
  await completions(3);
  check((await userTexts()).length === 2, "follow-up not shown");
  await page.locator('[data-role="user"]').first().hover();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByLabel("Edit message").fill("edited");
  await page.getByRole("button", { name: "Save" }).click();
  await completions(4);
  await page.waitForFunction(() => document.querySelectorAll('[data-role="user"]').length === 1);
  check((await userTexts())[0]?.includes("edited"), "the edited text is not shown");
  check((await assistantTexts()).at(-1)?.includes("reply to: edited"), "no reply to the edit");

  step = "regenerate on an earlier reply replies to THAT message, not the latest one";
  await page.getByLabel("Message").fill("another");
  await page.getByRole("button", { name: "Send" }).click();
  await completions(5);
  await page.locator('[data-role="assistant"]').first().hover();
  await page
    .locator('[data-role="assistant"]')
    .first()
    .getByRole("button", { name: "Regenerate" })
    .click();
  await completions(6);
  await page.waitForFunction(() => document.querySelectorAll('[data-role="user"]').length === 1);
  check((await userTexts()).length === 1, "regenerating an earlier reply should leave one turn");
  check(
    (await assistantTexts()).length === 1,
    "regenerating an earlier reply should leave one reply",
  );
  check(
    (await assistantTexts()).at(-1)?.includes("reply to: edited"),
    "regenerate replied to the wrong message",
  );

  step = "Stop keeps a partial reply";
  await page.getByLabel("Message").fill("slow please");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="assistant"]')].at(-1)?.textContent?.includes("w3"),
  );
  await page.getByRole("button", { name: "Stop" }).click();
  await completions(7);
  const partial = (await assistantTexts()).at(-1) ?? "";
  check(partial.includes("w3") && !partial.includes("w59"), `not a partial reply: ${partial}`);

  step = "reload restores the session and the model";
  await page.reload();
  await page.getByRole("button", { name: "New chat" }).waitFor();
  check((await page.getByRole("dialog").count()) === 0, "a dialog opened after reload");
  await page
    .getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: "hello", exact: true })
    .click();
  await page.waitForFunction(() => document.querySelectorAll('[data-role="user"]').length === 2);
  check(
    (await page.getByLabel("Model", { exact: true }).inputValue()) === "beta",
    "model not restored",
  );

  step = "a wrong key shows the API key hint";
  await page.getByRole("button", { name: "Settings" }).click();
  const reopened = page.getByRole("dialog", { name: "Settings" });
  await reopened.waitFor();
  await page.getByLabel("API key").fill("wrong");
  await page.getByRole("button", { name: "Save" }).click();
  // Saving does not close the dialog by itself (there is no per-tab "done" action any more) --
  // the dialog is dismissible now (step is "chat"), so close it explicitly to reach the header.
  await reopened.getByRole("button", { name: "Close" }).click();
  await reopened.waitFor({ state: "detached" });
  await page.getByLabel("Message").fill("anyone?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("alert").filter({ hasText: "Check the API key." }).waitFor();

  step = "a failed model refresh shows an inline error";
  await page.getByRole("button", { name: "Refresh models" }).click();
  await page.getByRole("alert").filter({ hasText: "Could not refresh models" }).waitFor();

  step = "changing the base URL asks for a model again";
  await page.getByRole("button", { name: "Settings" }).click();
  await settings.waitFor();
  await page.getByLabel("Base URL").fill(llm.baseUrl.replace("127.0.0.1", "localhost"));
  await page.getByLabel("API key").fill("test-key");
  await page.getByRole("button", { name: "Save" }).click();
  // The base URL changed, so `applyEndpoint` cleared the model list -- the dialog is forced open
  // again (no dismiss button reachable) and switches itself to the Models tab.
  await page.getByRole("tab", { name: "Models", selected: true }).waitFor();

  step = "a wrong base URL leaves a way back to settings";
  // No "Change connection" button any more -- the way back is the Connection tab itself, in the
  // same dialog.
  await settings.getByRole("tab", { name: "Connection" }).click();
  await page.getByLabel("Base URL").waitFor();
  await page.getByLabel("Base URL").fill("http://127.0.0.1:9/v1");
  await page.getByRole("button", { name: "Save" }).click();
  // `SettingsDialog` remembers a tab the user picked explicitly (its own doc comment: "once
  // they have, their choice sticks") -- clicking Connection above means the dialog no longer
  // auto-follows `startupStep` back to Models, unlike the first time through this flow.
  await settings.getByRole("tab", { name: "Models" }).click();
  await settings.getByRole("alert").filter({ hasText: "Could not list models" }).waitFor();
  await settings.getByRole("tab", { name: "Connection" }).click();
  await page.getByLabel("Base URL").waitFor();

  check(problems.length === 0, problems.join("\n"));
  console.log("smoke: all steps passed");
} catch (error) {
  console.error(`smoke FAILED at "${step}": ${error.message}`);
  for (const problem of problems) console.error(problem);
  await page.screenshot({ path: join(DIST, "..", "smoke-failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
  await llm.close();
}

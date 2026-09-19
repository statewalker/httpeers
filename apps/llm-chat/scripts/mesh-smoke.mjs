/**
 * The built mesh page, in a real browser, against a running LLM appliance and its relay.
 *
 *   pnpm run build && HUB_ADMIN_USER=… HUB_ADMIN_PASSWORD=… node scripts/mesh-smoke.mjs
 *
 * Environment:
 *   HUB_DOOR_URL        the appliance's Traefik door (default http://127.0.0.1:8080)
 *   HUB_ADMIN_USER      basic-auth user for the door (required)
 *   HUB_ADMIN_PASSWORD  basic-auth password for the door (required)
 *   MESH_PAGE_URL       a deployed mesh.html; absent: dist/ is served on localhost (a secure context)
 *   LLM_MODEL           the model to chat with (default "fake")
 *   FORCE_RELAY=1       launch Chromium with UDP disabled for WebRTC, so the hub link must fall back
 *                       to the relay circuit; the smoke then requires "Connected (relay)"
 *
 * Steps: an ADMIN joins from `?join=`, sees the link mode and the dashboard link, requests a key,
 * picks the model and streams a reply over the mesh, then creates a key for a member ("Key for a
 * member"). A MEMBER joins in a separate browser context, is refused a key with the 403 message,
 * pastes the key the admin created for it and chats too.
 *
 * Prints no secret: not the door credentials, not the invitation, not the minted key.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const DOOR = (process.env.HUB_DOOR_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const USER = process.env.HUB_ADMIN_USER;
const PASSWORD = process.env.HUB_ADMIN_PASSWORD;
const MODEL = process.env.LLM_MODEL ?? "fake";
const JOIN_TIMEOUT = 60_000;
const FORCE_RELAY = process.env.FORCE_RELAY === "1";

if (!USER || !PASSWORD) {
  console.error("mesh-smoke: set HUB_ADMIN_USER and HUB_ADMIN_PASSWORD (the door's basic auth).");
  process.exit(2);
}

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
  return {
    url: `http://localhost:${server.address().port}/mesh.html`,
    close: () => server.close(),
  };
}

async function invitation(roles) {
  const res = await fetch(`${DOOR}/hub/api/invitations`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ roles }),
  });
  if (!res.ok) throw new Error(`minting a ${roles} invitation: HTTP ${res.status}`);
  const { blob } = await res.json();
  return blob;
}

const site = process.env.MESH_PAGE_URL
  ? { url: process.env.MESH_PAGE_URL, close: () => {} }
  : await serveDist();
const browser = await chromium.launch({
  args: FORCE_RELAY ? ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] : [],
});
const problems = [];
let step = "start";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const pages = [];

async function openPage(label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`${label} pageerror: ${error.message}`));
  pages.push({ label, page });
  return page;
}

/** Join from `?join=`, then wait for the link status. Returns "direct" or "relay". */
async function joinAs(page, roles) {
  const blob = await invitation(roles);
  const started = Date.now();
  await page.goto(`${site.url}?join=${encodeURIComponent(blob)}`);
  const status = page.getByRole("status").filter({ hasText: /Connected \((direct|relay)\)/ });
  await status.first().waitFor({ timeout: JOIN_TIMEOUT });
  const text = await status.first().innerText();
  console.log(`  ${roles} joined in ${Date.now() - started} ms: ${text}`);
  check(!page.url().includes("join="), "the spent ?join= is still in the address bar");
  if (FORCE_RELAY) check(text.includes("relay"), `FORCE_RELAY is set but the link is: ${text}`);
  return text.includes("relay") ? "relay" : "direct";
}

async function chooseModelAndChat(page, message) {
  const models = page.getByRole("dialog", { name: "Choose a model" });
  await models.getByLabel(MODEL, { exact: true }).waitFor({ timeout: 30_000 });
  await models.getByLabel(MODEL, { exact: true }).check();
  await models.getByRole("button", { name: "Use model" }).click();
  await models.waitFor({ state: "detached" });

  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  // The WHOLE reply, closing parenthesis included: the fake upstream's last word is the model, and
  // the chat reveals streamed text gradually, so a prefix match would pass on a cut-off stream.
  const started = Date.now();
  await page.waitForFunction(
    (text) =>
      new RegExp(`reply to: ${text} \\(model [^)]+\\)`).test(
        [...document.querySelectorAll('[data-role="assistant"]')].at(-1)?.textContent ?? "",
      ),
    message,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 30_000 });
  const reply = (await page.locator('[data-role="assistant"] .markdown').last().innerText()).trim();
  console.log(`  reply in ${Date.now() - started} ms: ${JSON.stringify(reply)}`);
}

let adminKey = "";
let memberKey = "";
try {
  step = "an admin joins from ?join=";
  const admin = await openPage("admin");
  const adminLink = await joinAs(admin, ["admin"]);

  step = "the admin gets the key step with Request a key";
  await admin.getByLabel("Key", { exact: true }).waitFor({ timeout: 30_000 });
  check(
    (await admin.getByRole("button", { name: "Request a key" }).count()) === 1,
    "no Request a key button",
  );

  step = "the admin sees the LiteLLM dashboard link, under the hub's llm mount";
  const dashboard = admin.getByRole("link", { name: "LiteLLM dashboard" });
  await dashboard.waitFor({ timeout: 10_000 });
  const href = await dashboard.getAttribute("href");
  check(/\/peers\/[^/]+\/llm\/ui\/login\/$/.test(href ?? ""), `dashboard href ${href}`);

  step = "Request a key mints one and opens the chat";
  await admin.getByRole("button", { name: "Request a key" }).click();
  await admin.getByRole("dialog", { name: "Choose a model" }).waitFor({ timeout: 30_000 });
  adminKey = await admin.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("llm-chat");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const config = await new Promise((resolve, reject) => {
      const request = db.transaction("config").objectStore("config").get("mesh");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return config?.apiKeyHeader === "x-litellm-api-key" ? (config.apiKey ?? "") : "";
  });
  check(adminKey !== "", "the stored mesh config has no key, or not the x-litellm-api-key header");

  step = `the admin picks ${MODEL} and a reply streams over the mesh`;
  await chooseModelAndChat(admin, "hello from the admin");
  check(
    (await admin
      .getByRole("status")
      .filter({ hasText: `Connected (${adminLink})` })
      .count()) === 1,
    "the chat header lost the link status",
  );

  step = "reload resumes straight into the chat with the stored key";
  await admin.reload();
  await admin.getByRole("button", { name: "New chat" }).waitFor({ timeout: JOIN_TIMEOUT });
  check((await admin.getByRole("dialog").count()) === 0, "a dialog opened after reload");

  step = "the dashboard link opens LiteLLM's UI over the mesh in a new tab";
  const [tab] = await Promise.all([
    admin.context().waitForEvent("page"),
    admin.getByRole("link", { name: "LiteLLM dashboard" }).click(),
  ]);
  // This origin serves no such page: a LiteLLM title can only have come through the edge.
  await tab.waitForFunction(() => /LiteLLM/.test(document.title), null, { timeout: 30_000 });
  console.log(
    `  dashboard tab: ${new URL(tab.url()).pathname} titled ${JSON.stringify(await tab.title())}`,
  );
  await tab.close();

  step = "the admin creates a key for a member";
  await admin.getByRole("button", { name: "Key for a member" }).click();
  const keyDialog = admin.getByRole("dialog", { name: "Key for a member" });
  await keyDialog.getByLabel("Who is it for").fill("mesh-smoke member");
  await keyDialog.getByRole("button", { name: "Create key" }).click();
  const created = keyDialog.getByLabel("The new key");
  await created.waitFor({ timeout: 30_000 });
  memberKey = await created.inputValue();
  check(memberKey !== "" && memberKey !== adminKey, "no new key, or the admin's own key again");
  await keyDialog.getByRole("button", { name: "Done" }).click();
  await keyDialog.waitFor({ state: "detached" });

  step = "a member joins in its own browser context";
  const member = await openPage("member");
  await joinAs(member, ["member"]);
  await member.getByLabel("Key", { exact: true }).waitFor({ timeout: 30_000 });
  check(
    (await member.getByRole("link", { name: "LiteLLM dashboard" }).count()) === 0,
    "a plain member sees the dashboard link",
  );
  check(
    (await member.getByRole("button", { name: "Key for a member" }).count()) === 0,
    "a plain member sees Key for a member",
  );

  step = "the member's Request a key shows the 403 message";
  await member.getByRole("button", { name: "Request a key" }).click();
  await member.getByRole("alert").filter({ hasText: "403" }).waitFor({ timeout: 30_000 });

  step = "the member pastes the key the admin created for it and chats";
  await member.getByLabel("Key", { exact: true }).fill(memberKey);
  await member.getByRole("button", { name: "Use key" }).click();
  await chooseModelAndChat(member, "hello from a member");

  check(problems.length === 0, problems.join("\n"));
  console.log("mesh-smoke: all steps passed");
} catch (error) {
  console.error(`mesh-smoke FAILED at "${step}": ${error.message}`);
  for (const problem of problems) console.error(problem);
  for (const { label, page } of pages) {
    await page
      .screenshot({ path: join(DIST, "..", `mesh-smoke-failure-${label}.png`) })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
}

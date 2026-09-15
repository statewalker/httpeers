/**
 * End-to-end test of the LLM appliance on the real domains, through the public relay.
 *
 *   node deploy/llm-appliance/e2e/e2e.mjs
 *
 * See README.md next to this file for the prerequisites. In short: the appliance is running from
 * `deploy/llm-appliance` (its `.env` holds the door and dashboard credentials), the llm-chat build
 * is published to the page URL, Docker can run the Playwright image, and `apps/llm-chat` has its
 * dependencies installed (Playwright is resolved from there; `deploy/` is not a workspace package).
 *
 * Steps (each prints PASS or FAIL with its duration; any FAIL or SKIP exits non-zero):
 *   1. Hub is up: `GET /hub/api/mesh` through the Traefik door gives `hubPeerId`.
 *   2. Admin joins over the relay: browser A runs inside an isolated Docker network (a Playwright
 *      `run-server` container on its own user-defined network, driven from here with
 *      `chromium.connect`), so it cannot reach the appliance's bridge network. A control check
 *      proves that from inside the container. A joins from `?join=`, requests a key, picks `fake`,
 *      and a streamed reply to "hello" appears and completes.
 *   3. Dashboard: in A's context, LiteLLM's UI over the mesh; log in; the dashboard renders; every
 *      non-2xx response under the llm mount is listed.
 *   4. Member is refused admin paths: browser B (fresh context, isolated network) joins as a
 *      member; `POST …/llm/keys` and `GET …/llm/ui/login/` answer 403; B chats with A's key.
 *   5. Revocation: `DELETE /hub/api/members/<B>`; B's chat calls are polled until they fail
 *      (up to 90 s) and the latency is recorded.
 *   6. Host browser: browser C launched on the host joins as a member; its link mode is recorded.
 *
 * Environment (all optional):
 *   APPLIANCE_ENV      path of the appliance `.env` (default: ../.env next to this directory)
 *   HUB_DOOR_URL       the Traefik door (default http://127.0.0.1:8080)
 *   MESH_PAGE_URL      the published mesh page (default https://llm-chat.httpeers.net/mesh.html)
 *   HUB_CONTAINER      the hub container, for the isolation control (default llm-appliance-hub-1)
 *   E2E_NETWORK        isolated network name (default llm-e2e-isolated)
 *   E2E_PW_CONTAINER   run-server container name (default llm-e2e-playwright)
 *   E2E_PW_PORT        host port for run-server, bound to 127.0.0.1 (default 3100)
 *   E2E_PW_IMAGE       default mcr.microsoft.com/playwright:v1.63.0-noble
 *   E2E_KEEP_ISOLATED  1: leave the container and network up afterwards
 *   E2E_ARTIFACTS      directory for screenshots and results.json (default: a new temp dir)
 *   LLM_MODEL          default "fake"
 *
 * Prints no secret: not the door or dashboard credentials, not invitations, not minted keys.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const { chromium } = createRequire(join(REPO, "apps", "llm-chat", "package.json"))("playwright");

const ENV_FILE = process.env.APPLIANCE_ENV ?? join(HERE, "..", ".env");
const DOOR = (process.env.HUB_DOOR_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const PAGE_URL = process.env.MESH_PAGE_URL ?? "https://llm-chat.httpeers.net/mesh.html";
const ORIGIN = new URL(PAGE_URL).origin;
const HUB_CONTAINER = process.env.HUB_CONTAINER ?? "llm-appliance-hub-1";
const NETWORK = process.env.E2E_NETWORK ?? "llm-e2e-isolated";
const PW_CONTAINER = process.env.E2E_PW_CONTAINER ?? "llm-e2e-playwright";
const PW_PORT = Number(process.env.E2E_PW_PORT ?? 3100);
const PW_IMAGE = process.env.E2E_PW_IMAGE ?? "mcr.microsoft.com/playwright:v1.63.0-noble";
const PW_VERSION = PW_IMAGE.match(/:v([\d.]+)/)?.[1] ?? "1.63.0";
const KEEP_ISOLATED = process.env.E2E_KEEP_ISOLATED === "1";
const MODEL = process.env.LLM_MODEL ?? "fake";
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "llm-e2e-"));
mkdirSync(ARTIFACTS, { recursive: true });

const JOIN_TIMEOUT = 90_000;
const REVOCATION_WINDOW = 90_000;

/** `.env` as compose reads it: KEY=value, a single-quoted value taken literally. */
function readEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^'.*'$/.test(value) || /^".*"$/.test(value)) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

const env = readEnv(ENV_FILE);
for (const name of ["ADMIN_USER", "ADMIN_PASSWORD", "UI_USERNAME", "UI_PASSWORD"]) {
  if (!env[name]) {
    console.error(`e2e: ${name} is missing from ${ENV_FILE}`);
    process.exit(2);
  }
}
const DOOR_AUTH = `Basic ${Buffer.from(`${env.ADMIN_USER}:${env.ADMIN_PASSWORD}`).toString("base64")}`;

// ---------------------------------------------------------------------------------------------
// Reporting

const results = [];
const facts = { page: PAGE_URL, door: DOOR, keyAliases: [], pageErrors: [], started: new Date() };
let chainBroken = false;

/** Runs one step; a failure in a chained step skips the chained steps after it. */
async function step(id, name, fn, { chained = true } = {}) {
  if (chained && chainBroken) {
    results.push({ id, name, outcome: "SKIP", ms: 0, detail: "an earlier step failed" });
    console.log(`SKIP  ${id}. ${name} (an earlier step failed)`);
    return;
  }
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ id, name, outcome: "PASS", ms, detail });
    console.log(`PASS  ${id}. ${name} (${ms} ms)${detail ? `\n      ${detail}` : ""}`);
  } catch (error) {
    const ms = Date.now() - started;
    results.push({ id, name, outcome: "FAIL", ms, detail: error.message });
    console.log(`FAIL  ${id}. ${name} (${ms} ms)\n      ${error.message}`);
    if (chained) chainBroken = true;
    await screenshots(`step${id}`);
  }
}

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const note = (line) => console.log(`      ${line}`);

const openPages = [];
async function screenshots(prefix) {
  for (const { label, page } of openPages) {
    if (page.isClosed()) continue;
    const path = join(ARTIFACTS, `${prefix}-${label}.png`);
    await page.screenshot({ path }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// The door

async function door(method, path, body) {
  const res = await fetch(`${DOOR}${path}`, {
    method,
    headers: { authorization: DOOR_AUTH, "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return json;
}

/** A join URL on the published page. The hub's own `link` is used when it names that page. */
async function joinLink(roles) {
  const { blob, link } = await door("POST", "/hub/api/invitations", { roles });
  const linkPage = link ? new URL(link) : null;
  if (linkPage && `${linkPage.origin}${linkPage.pathname}` === PAGE_URL) return link;
  return `${PAGE_URL}?join=${encodeURIComponent(blob)}`;
}

const members = async () => door("GET", "/hub/api/members");

// ---------------------------------------------------------------------------------------------
// The isolated browser

async function docker(...args) {
  return run("docker", args, { maxBuffer: 16 * 1024 * 1024 });
}

async function startIsolatedBrowserServer() {
  await docker("network", "inspect", NETWORK).catch(() => docker("network", "create", NETWORK));
  await docker("rm", "-f", PW_CONTAINER).catch(() => {});
  await docker(
    "run",
    "-d",
    "--name",
    PW_CONTAINER,
    "--network",
    NETWORK,
    "-p",
    `127.0.0.1:${PW_PORT}:3000`,
    "--ipc=host",
    "--init",
    PW_IMAGE,
    "npx",
    "-y",
    `playwright@${PW_VERSION}`,
    "run-server",
    "--port",
    "3000",
    "--host",
    "0.0.0.0",
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { stdout, stderr } = await docker("logs", PW_CONTAINER);
    if (/Listening on/.test(stdout + stderr)) return;
    check(Date.now() < deadline, "run-server did not report Listening within 120 s");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function stopIsolatedBrowserServer() {
  if (KEEP_ISOLATED) return;
  await docker("rm", "-f", PW_CONTAINER).catch(() => {});
  await docker("network", "rm", NETWORK).catch(() => {});
}

/** From inside the isolated container: the hub must be unreachable, the internet reachable. */
async function isolationControl() {
  const { stdout } = await docker(
    "inspect",
    "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
    HUB_CONTAINER,
  );
  const hubIps = stdout.trim().split(/\s+/).filter(Boolean);
  check(hubIps.length > 0, `no IP address for ${HUB_CONTAINER}`);
  const outcomes = [];
  for (const ip of hubIps) {
    const reached = await docker(
      "exec",
      PW_CONTAINER,
      "curl",
      "-sS",
      "-m",
      "5",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `http://${ip}:8787/hub/api/mesh`,
    ).then(
      ({ stdout }) => `reached (HTTP ${stdout})`,
      (error) => `failed (curl exit ${error.code})`,
    );
    outcomes.push(`${ip}:8787 ${reached}`);
    check(!reached.startsWith("reached"), `the isolated container reached the hub at ${ip}`);
  }
  const internet = await docker(
    "exec",
    PW_CONTAINER,
    "curl",
    "-sS",
    "-m",
    "15",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    PAGE_URL,
  ).then(
    ({ stdout }) => stdout,
    (error) => `curl exit ${error.code}`,
  );
  check(internet === "200", `the isolated container cannot load ${PAGE_URL}: ${internet}`);
  return `control: hub ${outcomes.join(", ")}; ${PAGE_URL} from inside: HTTP ${internet}`;
}

// ---------------------------------------------------------------------------------------------
// The mesh page

async function openPage(browser, label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => facts.pageErrors.push(`${label}: ${error.message}`));
  openPages.push({ label, page });
  return page;
}

/** Joins from `?join=`; returns the link mode shown ("direct" or "relay") and the join time. */
async function joinMesh(page, roles) {
  const link = await joinLink(roles);
  const started = Date.now();
  await page.goto(link);
  const status = page.getByRole("status").filter({ hasText: /Connected \((direct|relay)\)/ });
  await status.first().waitFor({ timeout: JOIN_TIMEOUT });
  const text = await status.first().innerText();
  const ms = Date.now() - started;
  check(!page.url().includes("join="), "the spent ?join= is still in the address bar");
  return { mode: text.includes("relay") ? "relay" : "direct", ms };
}

/** The member the hub added since `before`, waiting for the membership to be visible. */
async function newMember(before, role) {
  const known = new Set(before.map((m) => m.peerId));
  const deadline = Date.now() + 15_000;
  for (;;) {
    const fresh = (await members()).filter((m) => !known.has(m.peerId) && m.roles.includes(role));
    if (fresh.length === 1) return fresh[0];
    check(Date.now() < deadline, `expected one new ${role} member, found ${fresh.length}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** What the hub's member list says about a member's addresses (its adverts, not the hub link). */
const addrsOf = (member) =>
  `${member.addrs.length} listed addr(s)${member.addrs.some((a) => a.includes("/p2p-circuit")) ? ", circuit among them" : ""}`;

async function chooseModel(page) {
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByLabel(MODEL, { exact: true }).waitFor({ timeout: 30_000 });
  await dialog.getByLabel(MODEL, { exact: true }).check();
  await dialog.getByRole("button", { name: "Use model" }).click();
  await dialog.waitFor({ state: "detached" });
}

/**
 * Sends `message` and waits for the WHOLE reply (the fake upstream's last word is the model, so a
 * cut-off stream cannot match). Samples the last assistant bubble while it grows.
 */
async function chat(page, message) {
  await page.getByLabel("Message").fill(message);
  const started = Date.now();
  await page.getByRole("button", { name: "Send" }).click();
  const samples = await page.evaluate(
    async ({ text, timeout }) => {
      const complete = new RegExp(`reply to: ${text} \\(model [^)]+\\)`);
      const seen = [];
      const deadline = performance.now() + timeout;
      for (;;) {
        const bubbles = document.querySelectorAll('[data-role="assistant"]');
        const current = bubbles[bubbles.length - 1]?.textContent ?? "";
        if (current !== "" && seen.at(-1)?.text !== current) {
          seen.push({ text: current, at: Math.round(performance.now()) });
        }
        if (complete.test(current)) return { seen, complete: true };
        if (performance.now() > deadline) return { seen, complete: false };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    { text: message, timeout: 60_000 },
  );
  check(
    samples.complete,
    `no complete reply within 60 s; last: ${JSON.stringify(samples.seen.at(-1)?.text ?? "")}`,
  );
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 30_000 });
  const ms = Date.now() - started;
  const reply = (await page.locator('[data-role="assistant"] .markdown').last().innerText()).trim();
  const partials = samples.seen.length - 1;
  return { ms, reply, partials };
}

/**
 * One streamed chat completion from inside the page, through the ServiceWorker and the mesh. It
 * streams because the test upstream (`test/fake-llm.mjs`) only answers with SSE, which LiteLLM
 * refuses for a non-streaming request. Success is a 200 whose body reaches `[DONE]`.
 */
async function inPageChatCall(page, hubPeerId, key) {
  return page.evaluate(
    async ({ hub, key, model }) => {
      try {
        const res = await fetch(`/peers/${hub}/llm/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-litellm-api-key": `Bearer ${key}` },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await res.text();
        return { status: res.status, done: body.includes("[DONE]"), body: body.slice(0, 120) };
      } catch (error) {
        return { error: `${error.name}: ${error.message}` };
      }
    },
    { hub: hubPeerId, key, model: MODEL },
  );
}

// ---------------------------------------------------------------------------------------------
// The run

let hubPeerId = "";
let isolated;
let host;
let adminPage;
let adminKey = "";
let memberPage;
let memberPeerId = "";

try {
  await step(1, "Hub is up", async () => {
    const mesh = await door("GET", "/hub/api/mesh");
    hubPeerId = mesh.hubPeerId;
    check(/^12D3KooW[1-9A-HJ-NP-Za-km-z]+$/.test(hubPeerId ?? ""), `hubPeerId ${hubPeerId}`);
    check(mesh.services?.includes("llm"), `services ${JSON.stringify(mesh.services)}`);
    facts.hubPeerId = hubPeerId;
    facts.relayAddrs = mesh.relayAddrs;
    return `hubPeerId ${hubPeerId}; relay ${mesh.relayAddrs.join(", ")}`;
  });

  await step(
    2,
    "Admin joins over the relay (isolated browser A), requests a key, chats",
    async () => {
      await startIsolatedBrowserServer();
      const control = await isolationControl();
      note(control);
      facts.isolationControl = control;
      isolated = await chromium.connect(`ws://127.0.0.1:${PW_PORT}/`);
      facts.isolatedBrowser = `${PW_IMAGE} run-server, chromium ${isolated.version()}`;

      adminPage = await openPage(isolated, "A-admin");
      const before = await members();
      const { mode, ms } = await joinMesh(adminPage, ["admin"]);
      const admin = await newMember(before, "admin");
      facts.modes = { A: mode };
      facts.joins = { A: ms };
      note(`A joined in ${ms} ms: Connected (${mode}); hub member list: ${addrsOf(admin)}`);

      await adminPage.getByLabel("Key", { exact: true }).waitFor({ timeout: 30_000 });
      const minted = adminPage.waitForResponse(
        (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/llm/keys"),
        { timeout: 30_000 },
      );
      await adminPage.getByRole("button", { name: "Request a key" }).click();
      const response = await minted;
      check(response.status() === 200, `POST …/llm/keys answered ${response.status()}`);
      const body = await response.json();
      check(typeof body.key === "string" && body.key !== "", "the minted key is missing");
      adminKey = body.key;
      facts.keyAliases.push(body.key_alias);
      note(`key minted, alias ${body.key_alias}`);

      const dialog = adminPage.getByRole("dialog", { name: "Choose a model" });
      await dialog.waitFor({ timeout: 30_000 });
      await dialog.getByLabel(MODEL, { exact: true }).waitFor({ timeout: 30_000 });
      const models = (await dialog.locator("label").allInnerTexts()).map((t) => t.trim());
      note(`model picker lists: ${JSON.stringify(models)}`);
      await chooseModel(adminPage);

      const { ms: replyMs, reply, partials } = await chat(adminPage, "hello");
      check(partials >= 1, `the reply appeared in one piece (no partial state observed)`);
      facts.chatA = { replyMs, partials, reply };
      return `A: ${mode}; reply in ${replyMs} ms after ${partials} partial states: ${JSON.stringify(reply)}`;
    },
  );

  await step(
    3,
    "Dashboard over the mesh (A's context): log in, renders, non-2xx listed",
    async () => {
      const dash = await adminPage.context().newPage();
      openPages.push({ label: "A-dashboard", page: dash });
      const mount = `/peers/${hubPeerId}/llm`;
      const seen = [];
      dash.on("response", (r) => {
        const url = new URL(r.url());
        if (url.origin !== ORIGIN || !url.pathname.startsWith(mount)) return;
        seen.push({
          method: r.request().method(),
          path: url.pathname.slice(mount.length) || "/",
          status: r.status(),
        });
      });
      await dash.goto(`${ORIGIN}${mount}/ui/login/`);
      await dash.getByLabel("Username").waitFor({ timeout: 60_000 });
      await dash.getByLabel("Username").fill(env.UI_USERNAME);
      await dash.getByLabel("Password").fill(env.UI_PASSWORD);
      await dash.getByRole("button", { name: "Login", exact: true }).click();
      await dash.getByText("Virtual Keys", { exact: true }).first().waitFor({ timeout: 60_000 });
      await dash.getByText("Create New Key").first().waitFor({ timeout: 60_000 });
      // Let the dashboard's first burst of API calls settle before counting.
      await dash.waitForTimeout(8_000);
      await dash.screenshot({ path: join(ARTIFACTS, "step3-dashboard.png") });
      check(
        new URL(dash.url()).pathname === `${mount}/ui/`,
        `landed on ${new URL(dash.url()).pathname}`,
      );
      const keyList = seen.find((r) => r.path === "/key/list");
      check(keyList?.status === 200, `key/list answered ${keyList?.status ?? "nothing"}`);

      const non2xx = seen
        .filter((r) => r.status < 200 || r.status > 299)
        .map((r) => ({
          ...r,
          laterOk: seen
            .slice(seen.indexOf(r) + 1)
            .some(
              (s) =>
                s.method === r.method && s.path === r.path && s.status >= 200 && s.status < 300,
            ),
        }));
      facts.dashboard = { responses: seen.length, non2xx };
      for (const r of non2xx) {
        note(
          `non-2xx: ${r.status} ${r.method} ${r.path}${r.laterOk ? " (a later identical call got 2xx)" : ""}`,
        );
      }
      const refused = non2xx.filter((r) => r.status === 403 || r.status >= 500);
      check(refused.length === 0, `403/5xx under the llm mount: ${JSON.stringify(refused)}`);
      await dash.close();
      return `logged in; ${seen.length} responses under the mount, ${non2xx.length} non-2xx (no 403, no 5xx)`;
    },
  );

  await step(4, "Member B (isolated) is refused admin paths and chats with A's key", async () => {
    memberPage = await openPage(isolated, "B-member");
    const before = await members();
    const { mode, ms } = await joinMesh(memberPage, ["member"]);
    const member = await newMember(before, "member");
    memberPeerId = member.peerId;
    facts.modes.B = mode;
    facts.joins.B = ms;
    facts.memberB = memberPeerId;
    note(
      `B joined in ${ms} ms: Connected (${mode}); peer ${memberPeerId}; hub member list: ${addrsOf(member)}`,
    );
    await memberPage.getByLabel("Key", { exact: true }).waitFor({ timeout: 30_000 });

    const probes = await memberPage.evaluate(async (hub) => {
      const status = async (method, path, body) => {
        const res = await fetch(`/peers/${hub}/llm${path}`, {
          method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        return res.status;
      };
      return {
        keys: await status("POST", "/keys", { key_alias: "e2e-member-must-be-refused" }),
        ui: await status("GET", "/ui/login/"),
      };
    }, hubPeerId);
    note(`B: POST …/llm/keys -> ${probes.keys}; GET …/llm/ui/login/ -> ${probes.ui}`);
    check(probes.keys === 403, `POST …/llm/keys answered ${probes.keys}, expected 403`);
    check(probes.ui === 403, `GET …/llm/ui/login/ answered ${probes.ui}, expected 403`);

    await memberPage.getByLabel("Key", { exact: true }).fill(adminKey);
    await memberPage.getByRole("button", { name: "Use key" }).click();
    await chooseModel(memberPage);
    const { ms: replyMs, reply } = await chat(memberPage, "hello from B");
    return `B: ${mode}; 403 on keys and ui; reply in ${replyMs} ms: ${JSON.stringify(reply)}`;
  });

  await step(5, "Revocation: B's chat calls fail after DELETE /hub/api/members/<B>", async () => {
    const baseline = await inPageChatCall(memberPage, hubPeerId, adminKey);
    check(
      baseline.status === 200 && baseline.done,
      `baseline call before revocation: ${JSON.stringify(baseline)}`,
    );
    await door("DELETE", `/hub/api/members/${encodeURIComponent(memberPeerId)}`);
    const revokedAt = Date.now();
    note(`revoked ${memberPeerId}`);
    const attempts = [];
    for (;;) {
      const outcome = await inPageChatCall(memberPage, hubPeerId, adminKey);
      const at = Date.now() - revokedAt;
      attempts.push({ at, ...outcome });
      if (outcome.error || outcome.status !== 200 || !outcome.done) {
        facts.revocation = { latencyMs: at, attempts: attempts.length, outcome };
        await memberPage.waitForTimeout(3_000);
        const statusText = await memberPage
          .getByRole("status")
          .or(memberPage.getByRole("alert"))
          .allInnerTexts()
          .catch(() => []);
        facts.revocation.pageShows = statusText;
        await memberPage.screenshot({ path: join(ARTIFACTS, "step5-B-after-revocation.png") });
        return `first failing call ${at} ms after the DELETE answered (attempt ${attempts.length}): ${JSON.stringify(outcome)}; page shows ${JSON.stringify(statusText)}`;
      }
      check(
        at < REVOCATION_WINDOW,
        `B's calls still succeed ${at} ms after revocation (${attempts.length} attempts)`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  await step(
    6,
    "Host browser C joins as a member; link mode recorded",
    async () => {
      check(hubPeerId !== "", "step 1 did not find the hub");
      host = await chromium.launch();
      const page = await openPage(host, "C-host");
      const before = await members();
      const { mode, ms } = await joinMesh(page, ["member"]);
      const member = await newMember(before, "member");
      facts.modes = { ...facts.modes, C: mode };
      facts.joins = { ...facts.joins, C: ms };
      await page.getByLabel("Key", { exact: true }).waitFor({ timeout: 30_000 });
      return `C joined in ${ms} ms: Connected (${mode}); hub member list: ${addrsOf(member)}`;
    },
    { chained: false },
  );
} finally {
  await isolated?.close().catch(() => {});
  await host?.close().catch(() => {});
  await stopIsolatedBrowserServer();
}

facts.finished = new Date();
facts.results = results;
writeFileSync(join(ARTIFACTS, "results.json"), `${JSON.stringify(facts, null, 2)}\n`);

console.log("");
if (facts.pageErrors.length > 0) {
  console.log(`page errors (${facts.pageErrors.length}):`);
  for (const line of facts.pageErrors) console.log(`  ${line}`);
}
console.log(`link modes: ${JSON.stringify(facts.modes ?? {})}`);
console.log(`key aliases minted: ${JSON.stringify(facts.keyAliases)}`);
console.log(`artifacts: ${ARTIFACTS}`);
const failed = results.filter((r) => r.outcome !== "PASS");
console.log(
  failed.length === 0 ? "e2e: all steps passed" : `e2e: ${failed.length} step(s) not passed`,
);
process.exitCode = failed.length === 0 ? 0 : 1;

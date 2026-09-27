/**
 * The built mesh page (`dist/mesh.html`), in a real Chromium, against a REAL httpeers appliance
 * and its relay -- promoted from `scripts/mesh-smoke.mjs` (see that file: it now just forwards
 * here, so the two can never drift apart the way `mesh-smoke.mjs` drifted from the app while this
 * task was building). Nothing here is asserted in jsdom or in `responsive.spec.mjs`: joining,
 * discovery, key minting and a streamed reply all need a real mesh, not a layout engine.
 *
 *   pnpm run build && node tests/e2e/mesh.spec.mjs
 *
 * WHAT IT DOES (spec's four requirements, in order): joins the mesh by PASTING A BLOB into the
 * join form -- never `?join=` on the URL, which is a different code path (`startMeshSession` reads
 * `?join=` itself at start; this spec instead drives `JoinWidgetView`'s own form, the same one a
 * human uses) -- confirms the settings dialog shows exactly four tabs (Connection, Models,
 * Sharing, Keys -- `registerMeshPanels` always contributes the last two, `ChatApp` the first two),
 * mints a key for a member from the Keys panel's "Key for a member" (not the pre-chat "Request a
 * key", which is a different, earlier step this spec also uses to reach chat in the first place —
 * see "why an admin" below), sends a message and waits for a genuinely streamed reply (partial
 * text observed before the final one, not just "some text eventually appeared").
 *
 * WHY AN ADMIN, NOT A MEMBER (the brief's own example invite command is `--roles member`; this
 * spec mints `--roles admin` instead, deliberately). `KeysPanel.tsx` renders "Admin only." for
 * anyone else, and a member's own "Request a key" is refused with a 403 (`discover.ts`'s
 * `mintKey`) -- a member could join and chat once handed a key, but could not reach the Keys panel
 * requirement above at all. Only an admin invitation exercises everything this spec is chartered
 * to prove.
 *
 * STARTING AN APPLIANCE (skip this if one is already running -- see "Finding one" below):
 *   cd deploy/llm-appliance             # in an httpeers checkout, NOT this worktree (`apps/` here
 *                                        # has none; see APPLIANCE_DIR below)
 *   cp .env.example .env && chmod 600 .env   # fill in the generated secrets (README "Secrets")
 *   ./bin/prepare.sh                    # probes the host, downloads local models
 *   docker compose -f compose.yml -f compose.local.yml -f compose.models.yml up -d --wait
 *   docker compose ps                   # six services, all "healthy" (traefik has no healthcheck)
 *
 * FINDING ONE. `APPLIANCE_DIR` (env var) names that `deploy/llm-appliance` directory; unset, this
 * file guesses `<the worktrees/ root this file lives under>/llm-appliance-local/workspaces/
 * httpeers/deploy/llm-appliance` -- the sibling worktree this task was actually run against, one
 * `docker compose ps` away from six healthy services and a door on `127.0.0.1:8081` (verified
 * while writing this spec: hub, litellm, two llamacpp backends, postgres, traefik). Neither the
 * guess nor an explicit `APPLIANCE_DIR` is trusted blindly: this spec mints its invitation with
 * that directory's OWN `./bin/invite.sh` (never a direct `POST /hub/api/invitations` with a
 * hardcoded door URL and basic-auth env vars, unlike the pre-promotion `mesh-smoke.mjs` -- that
 * script's HUB_DOOR_URL defaulted to `127.0.0.1:8080`, which on the box this was built on is
 * SOMEONE ELSE'S SSH TUNNEL TO PRODUCTION, not this appliance; `invite.sh` reads the door port and
 * credentials from the appliance's OWN `.env`, so this spec never has to know or guess either).
 * `invite.sh` failing (wrong directory, `docker compose` not up, a stale invitation cache, no
 * `.env`) is read as "no appliance reachable" and this spec SKIPS with that message rather than
 * failing -- a missing appliance is not this code's bug.
 *
 * DO NOT, against the live appliance this was built against: `docker compose down` it, re-run
 * `bin/prepare.sh` (re-probes and can re-pick a different model tier), or touch port 8080 or PID
 * 440045 on that host (a human's own SSH tunnel to the production httpeers.net server -- entirely
 * unrelated to this spec, which only ever talks to the appliance's OWN door, on 8081 by that
 * appliance's own `.env`, discovered through `invite.sh`, never hardcoded here).
 *
 * Prints no secret: not `.env`'s door credentials (never read by this file at all -- `invite.sh`
 * keeps them to itself), not the invitation blob, not the member key minted for the Keys panel
 * check.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const MODEL = process.env.LLM_MODEL ?? "qwen2.5-1.5b-instruct";
const JOIN_TIMEOUT = 60_000;
const REPLY_TIMEOUT = 120_000; // a small local model, cold, can legitimately take a while

function skip(reason) {
  console.log(`mesh.spec: SKIPPED -- ${reason}`);
  process.exit(0);
}

/** `<...>/worktrees/<this-worktree>/...` -> `<...>/worktrees/llm-appliance-local/workspaces/httpeers/deploy/llm-appliance`. */
function defaultApplianceDir() {
  const here = fileURLToPath(import.meta.url);
  const marker = `${"/worktrees/"}`;
  const i = here.indexOf(marker);
  if (i === -1) return null;
  const worktreesRoot = here.slice(0, i + marker.length);
  return join(
    worktreesRoot,
    "llm-appliance-local",
    "workspaces",
    "httpeers",
    "deploy",
    "llm-appliance",
  );
}

const APPLIANCE_DIR = process.env.APPLIANCE_DIR ?? defaultApplianceDir();

if (APPLIANCE_DIR == null || !existsSync(join(APPLIANCE_DIR, "bin", "invite.sh"))) {
  skip(
    `no deploy/llm-appliance found at ${APPLIANCE_DIR ?? "(could not even guess a path)"} -- ` +
      "set APPLIANCE_DIR to one, or start one there (see the comment at the top of this file).",
  );
}

/** Mints an invitation via the appliance's own `bin/invite.sh` and returns the blob text (never the link). */
async function mintBlob(roles, ttlDays) {
  const { stdout } = await execFileAsync(
    join(APPLIANCE_DIR, "bin", "invite.sh"),
    ["--roles", roles, "--ttl-days", String(ttlDays)],
    { cwd: APPLIANCE_DIR, timeout: 90_000 },
  );
  const match = /wrote (invites\/\S+\/blob\.txt)/.exec(stdout);
  if (match == null) throw new Error(`invite.sh printed no blob.txt path:\n${stdout}`);
  return (await readFile(join(APPLIANCE_DIR, match[1]), "utf8")).trim();
}

let blob;
try {
  // Admin, not member -- see the file docblock's "why an admin". A short TTL: this blob is spent
  // (or discarded) within this one run.
  blob = await mintBlob("admin", 1);
} catch (error) {
  skip(
    `could not mint an invitation from ${APPLIANCE_DIR} (is the appliance up? "docker compose ps" ` +
      `there should show six healthy services) -- ${error instanceof Error ? error.message : String(error)}`,
  );
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

const site = process.env.MESH_PAGE_URL
  ? { url: process.env.MESH_PAGE_URL, close: () => {} }
  : await serveDist();
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

let step = "start";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  step = "join the mesh by pasting the blob into the join form (never ?join=)";
  await page.goto(site.url);
  await page.getByLabel("Paste an invitation").fill(blob);
  await page.getByRole("button", { name: "Join" }).click();
  const status = page.getByRole("status").filter({ hasText: /Connected \((direct|relay)\)/ });
  await status.first().waitFor({ timeout: JOIN_TIMEOUT });
  const linkText = await status.first().innerText();
  console.log(`  joined: ${linkText}`);
  check(
    !page.url().includes("join="),
    "the address bar carries ?join= -- this spec pastes the blob, it never uses the link",
  );

  step = "the pre-chat key step offers Request a key (this invitation is an admin's)";
  const requestKey = page.getByRole("button", { name: "Request a key" });
  await requestKey.waitFor({ timeout: 30_000 });
  await requestKey.click();

  step = "reaching chat force-opens Settings on Models (no model chosen yet)";
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Models", selected: true }).waitFor({ timeout: 15_000 });

  step = "the settings dialog has exactly four tabs: Connection, Models, Sharing, Keys";
  const tabs = await settings.getByRole("tab").allInnerTexts();
  check(
    tabs.length === 4 &&
      ["Connection", "Models", "Sharing", "Keys"].every((name) => tabs.includes(name)),
    `expected exactly [Connection, Models, Sharing, Keys], saw: ${JSON.stringify(tabs)}`,
  );

  step = "mint a key for a member from the Keys panel";
  await settings.getByRole("tab", { name: "Keys" }).click();
  await settings.getByRole("button", { name: "Key for a member" }).click();
  const keyDialog = page.getByRole("dialog", { name: "Key for a member" });
  await keyDialog.getByLabel("Who is it for").fill("mesh-spec member");
  await keyDialog.getByRole("button", { name: "Create key" }).click();
  const mintedKey = keyDialog.getByLabel("The new key");
  await mintedKey.waitFor({ timeout: 30_000 });
  check((await mintedKey.inputValue()) !== "", "Key for a member minted an empty key");
  await keyDialog.getByRole("button", { name: "Done" }).click();
  await keyDialog.waitFor({ state: "detached" });

  step = `pick ${MODEL} on the Models tab`;
  await settings.getByRole("tab", { name: "Models" }).click();
  const modelRadio = settings.getByLabel(MODEL, { exact: true });
  await modelRadio.waitFor({ timeout: 30_000 });
  await modelRadio.check();
  await settings.getByRole("button", { name: "Use model" }).click();
  await settings.waitFor({ state: "detached" });

  step = "send a message and receive a streamed reply";
  const message = "In exactly two short sentences, describe the color blue.";
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  const assistant = page.locator('[data-role="assistant"]').last();
  const waiting = page.getByTestId("waiting-indicator");
  await waiting.waitFor({ timeout: 30_000 });
  await waiting.waitFor({ state: "detached", timeout: REPLY_TIMEOUT }); // the first token arrived
  const midText = (await assistant.innerText().catch(() => "")).trim();
  await page
    .getByRole("button", { name: "Stop" })
    .waitFor({ state: "detached", timeout: REPLY_TIMEOUT });
  const finalText = (await assistant.innerText()).trim();
  check(finalText !== "", "no assistant reply text arrived");
  // "Streamed", not "eventually appeared": the text right after the first token must differ from
  // the finished reply, UNLESS the model answered so tersely there was nothing left to stream --
  // a real model's wording is not pinned down the way the fake endpoint's echo is.
  check(
    midText !== finalText || finalText.split(/\s+/).length <= 3,
    `no progressive change observed between the first token and the finished reply: ${JSON.stringify({ midText, finalText })}`,
  );
  console.log(
    `  reply (${finalText.length} chars): ${JSON.stringify(finalText.slice(0, 80))}${finalText.length > 80 ? "…" : ""}`,
  );

  check(problems.length === 0, problems.join("\n"));
  console.log("mesh.spec: all steps passed");
} catch (error) {
  console.error(`mesh.spec FAILED at "${step}": ${error.message}`);
  for (const problem of problems) console.error(problem);
  await page.screenshot({ path: join(DIST, "..", "mesh-spec-failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
}

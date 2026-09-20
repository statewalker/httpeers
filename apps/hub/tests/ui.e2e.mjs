/**
 * The local admin UI (spec §5.5), in a real browser, against a real daemon.
 *
 *   pnpm run test:ui     (builds `dist/` and `dist-ui/` first, see package.json)
 *
 * NOTHING HERE TOUCHES THE PUBLIC INTERNET. Same shape as `tests/daemon.test.ts`:
 * an in-process relay on loopback, and a relay document served from a local
 * HTTP server. This is a plain script, not a vitest file, and it imports the
 * BUILT `dist/` (like `apps/llm-chat/scripts/smoke.mjs` imports its `dist/`)
 * because a real browser needs a real static build (`dist-ui/`) to open —
 * there is no point running this against transpiled-on-the-fly source.
 *
 * THE DOOR ONLY ANSWERS ITS PROXY. The browser plays Traefik's part: every
 * request carries `x-hub-door-secret` (Playwright `extraHTTPHeaders`), and the
 * door allows exactly the Host the browser uses, `127.0.0.1:<port>` -- which is
 * why the port is picked before the daemon starts instead of being 0.
 *
 * The `llm` upstream is never actually called here: only its PRESENCE among
 * the daemon's modules matters, for the dashboard link. A bogus URL is fine.
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { startRelay } from "@statewalker/httpeers-relay";
import { chromium } from "playwright";
import { startDaemon } from "../dist/daemon.js";
import { llmModule } from "../dist/services/llm/index.js";

let step = "start";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function startRelayDoc() {
  const relay = await startRelay({ privateKey: await generateKeyPair("Ed25519"), port: 0 });
  const relayAddrs = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .filter((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  check(relayAddrs.length > 0, "the loopback relay advertised no /ip4/127.0.0.1/ address");

  const doc = createServer((req, res) => {
    if (req.url !== "/.well-known/httpeers-relay.json") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ relayAddrs }));
  });
  doc.listen(0, "127.0.0.1");
  await once(doc, "listening");
  const { port } = doc.address();
  return {
    relayDocUrl: `http://127.0.0.1:${port}/.well-known/httpeers-relay.json`,
    close: async () => {
      doc.close();
      await relay.stop();
    },
  };
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const DOOR_SECRET = "ui-e2e-door-secret-0123456789";
const doorPort = await freePort();
const relayDoc = await startRelayDoc();
const dataDir = await mkdtemp(join(tmpdir(), "hub-ui-e2e-"));

const daemon = await startDaemon(
  {
    dataDir,
    relayDoc: relayDoc.relayDocUrl,
    services: ["llm"],
    joinPageUrl: "https://example.test/mesh.html",
    localDoorPort: doorPort,
    localDoorHost: "127.0.0.1",
    doorSecret: DOOR_SECRET,
    doorAllowedHosts: [`127.0.0.1:${doorPort}`],
  },
  // A fake upstream: never dialled by this test, only advertised.
  [llmModule({ upstream: "http://127.0.0.1:1", masterKey: "sk-test" })],
);

const doorUrl = `http://127.0.0.1:${daemon.localDoorPort}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ extraHTTPHeaders: { "x-hub-door-secret": DOOR_SECRET } });
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

try {
  step = "the door refuses the page without the secret";
  const bare = await fetch(doorUrl);
  check(bare.status === 401, `GET / without the secret answered ${bare.status}, expected 401`);

  step = "the page loads and shows the Hub heading";
  await page.goto(doorUrl);
  await page.getByRole("heading", { name: "Hub" }).waitFor();

  step = "the Roles select is populated, with member available";
  const rolesSelect = page.getByRole("combobox", { name: "Roles" });
  await rolesSelect.waitFor();
  await rolesSelect.selectOption("member");

  step = "the Members table is present";
  await page.getByRole("table", { name: "Members" }).waitFor();

  step = "the LiteLLM dashboard link has the right href";
  const dashboardLink = page.getByRole("link", { name: "LiteLLM dashboard" });
  await dashboardLink.waitFor();
  const href = await dashboardLink.getAttribute("href");
  // `ui/`, NEVER `ui/login/`: LiteLLM's client router escapes the mesh prefix
  // from the login page when a `token` cookie is already set.
  check(
    href === `/peers/${daemon.hubPeerId}/llm/ui/`,
    `dashboard link href was "${href}", expected "/peers/${daemon.hubPeerId}/llm/ui/"`,
  );

  step = "Mint invitation produces a link and a QR code";
  await page.getByRole("button", { name: "Mint invitation" }).click();
  const linkField = page.getByRole("textbox", { name: "Link" });
  await linkField.waitFor();
  const link = await page.waitForFunction(() => document.querySelector("#link")?.value || null);
  const linkValue = await link.jsonValue();
  check(linkValue?.includes("?join="), `unexpected invitation link: ${linkValue}`);
  await page.locator("#qr svg").waitFor();

  // Last: it navigates away from the admin page.
  step = "the door rescues /ui at the origin root into the hub's prefixed dashboard";
  {
    // No redirect following: what matters is the status and the Location, not
    // the dashboard itself -- the `llm` upstream here is a dead port.
    const res = await page.request.get(`http://127.0.0.1:${daemon.localDoorPort}/ui?x=1`, {
      maxRedirects: 0,
    });
    check(res.status() === 307, `GET /ui answered ${res.status()}, expected 307`);
    const location = res.headers().location;
    check(
      location === `/peers/${daemon.hubPeerId}/llm/ui/?x=1`,
      `GET /ui redirected to "${location}", expected "/peers/${daemon.hubPeerId}/llm/ui/?x=1"`,
    );
    // And a real navigation actually ends up there, whatever the dashboard then answers.
    await page.goto(`http://127.0.0.1:${daemon.localDoorPort}/ui`).catch(() => {});
    check(
      page
        .url()
        .startsWith(`http://127.0.0.1:${daemon.localDoorPort}/peers/${daemon.hubPeerId}/llm/ui/`),
      `a browser opening /ui ended at ${page.url()}`,
    );
  }

  check(problems.length === 0, problems.join("\n"));
  console.log("ui.e2e: all steps passed");
} catch (error) {
  console.error(`ui.e2e FAILED at "${step}": ${error.message}`);
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} finally {
  await browser.close();
  await daemon.stop().catch(() => {});
  await relayDoc.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

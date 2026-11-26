/**
 * A hub in a Chrome MV3 extension's OFFSCREEN DOCUMENT admits a member
 * (statewalker/httpeers#163).
 *
 *   pnpm --filter @statewalker/httpeers-browser-conformance test:offscreen-hub
 *
 * WHAT RUNS. Everything on loopback, nothing on the internet:
 *
 *   - a Circuit Relay v2 server (`@statewalker/httpeers-relay`);
 *   - a test extension: a service worker that opens an offscreen document
 *     (reason `WEB_RTC`) and forwards commands to it, and the document
 *     (`offscreen-hub/offscreen.ts`), a hub assembled with `startBrowserHub`
 *     from `@statewalker/httpeers-member/browser-hub`. It is bundled from the
 *     packages' sources with `@statewalker/webrun-http-browser` made
 *     unresolvable: the build itself checks that an offscreen bundle needs no
 *     ServiceWorker edge;
 *   - Playwright's Chromium with the extension loaded (new headless runs
 *     extensions; `channel: "chromium"`);
 *   - a Node member (`startMember` with `nodePlatform`) that redeems the hub's
 *     invitation, then calls the hub's `/ping` mount through the mesh.
 *
 * It passes when the member is admitted (the hub reports it a member) and the
 * call returns 200. OPT-IN, not part of `pnpm test`: it builds an extension and
 * drives a browser, like `test:forwarded-body`. CI runs it as ci.yml's
 * `offscreen-hub` job, with the full Chromium (the headless shell loads no
 * extension).
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` points the launch at another Chromium.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ruleSet } from "@statewalker/httpeers-access";
import { createMounts } from "@statewalker/httpeers-core";
import { generateKey } from "@statewalker/httpeers-libp2p";
import { startMember } from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";
import { startRelay } from "@statewalker/httpeers-relay";
import { chromium } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 120_000;
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

/** The member's own rules: the same vocabulary as the hub's. */
const MEMBER_RULES = ruleSet({
  version: 1,
  rules: ['capability("std:mesh.read") <- role("member")'],
  policies: ['allow if capability("std:mesh.read"), resource("/.well-known")'],
});

const MANIFEST = {
  manifest_version: 3,
  name: "httpeers offscreen hub test",
  version: "0.0.1",
  background: { service_worker: "sw.js" },
  permissions: ["offscreen"],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};

/** The broker: open the offscreen document, forward a command, return its answer. */
const SERVICE_WORKER = `
globalThis.toOffscreen = async (command) => {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WEB_RTC"],
      justification: "hosts an httpeers hub",
    });
  }
  return await chrome.runtime.sendMessage({ target: "offscreen", ...command });
};
`;

const OFFSCREEN_HTML = `<!doctype html><meta charset="utf-8"><script src="offscreen.js"></script>`;

/** Bundle the offscreen document from SOURCES, with the ServiceWorker adapter unresolvable. */
async function buildExtension(dir) {
  const packages = join(here, "..", "..");
  const alias = ["access", "core", "hub", "libp2p", "member"].flatMap((name) => {
    const src = join(packages, `httpeers-${name}`, "src");
    return [
      { find: new RegExp(`^@statewalker/httpeers-${name}/(.+)$`), replacement: `${src}/$1.ts` },
      { find: new RegExp(`^@statewalker/httpeers-${name}$`), replacement: `${src}/index.ts` },
    ];
  });
  await build({
    configFile: false,
    logLevel: "warn",
    resolve: { alias },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "no-webrun-http-browser",
        enforce: "pre",
        resolveId(source) {
          if (/^@statewalker\/webrun-http-browser(\/|$)/.test(source)) {
            throw new Error(`the offscreen bundle asked for ${source}`);
          }
          return null;
        },
      },
    ],
    build: {
      outDir: dir,
      emptyOutDir: false,
      minify: false,
      target: "es2022",
      lib: {
        entry: join(here, "offscreen-hub", "offscreen.ts"),
        formats: ["iife"],
        name: "offscreenHub",
        fileName: () => "offscreen.js",
      },
    },
  });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(MANIFEST, null, 1));
  await writeFile(join(dir, "sw.js"), SERVICE_WORKER);
  await writeFile(join(dir, "offscreen.html"), OFFSCREEN_HTML);
}

const withTimeout = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS),
    ),
  ]);

let extensionDir;
let userDataDir;
let relay;
let context;
let member;
let failed = false;

try {
  extensionDir = await mkdtemp(join(tmpdir(), "httpeers-offscreen-ext-"));
  userDataDir = await mkdtemp(join(tmpdir(), "httpeers-offscreen-profile-"));
  await buildExtension(extensionDir);
  log("extension built (no webrun-http-browser)");

  relay = await startRelay({ privateKey: await generateKey(), port: 0 });
  const relayAddr = relay.node
    .getMultiaddrs()
    .map(String)
    .find((addr) => addr.startsWith("/ip4/127.0.0.1/") && addr.includes("/ws/"));
  if (relayAddr == null) throw new Error("the relay advertised no loopback /ws address");
  log("relay", relayAddr);

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: process.env.HEADED !== "1",
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const toOffscreen = async (command) => {
    const answer = await worker.evaluate((c) => globalThis.toOffscreen(c), command);
    if (!answer?.ok) throw new Error(`offscreen ${command.cmd}: ${answer?.error ?? "no answer"}`);
    return answer.result;
  };

  const hub = await withTimeout(toOffscreen({ cmd: "start", relayAddr }), "hub start");
  log("offscreen hub", hub);
  if (hub.hasWebRTC !== "function")
    throw new Error("the offscreen document has no RTCPeerConnection");

  member = await withTimeout(
    startMember({
      key: "peers",
      mounts: createMounts(),
      rules: MEMBER_RULES,
      config: { relayAddrs: [relayAddr], hubPeerId: hub.peerId },
      platform: nodePlatform,
      invitationId: hub.invitationId,
    }),
    "member join",
  );
  log("member joined", member.peerId, "hub link:", member.hubLink());

  const admitted = await toOffscreen({ cmd: "isMember", peerId: member.peerId });
  if (admitted !== true) throw new Error(`the hub does not list ${member.peerId} as a member`);

  const response = await withTimeout(
    member.fetch(new Request(`http://local/peers/${hub.peerId}/ping`)),
    "ping",
  );
  const body = await response.text();
  log("ping", response.status, body);
  if (response.status !== 200 || !body.includes("pong")) {
    throw new Error(`ping through the mesh: ${response.status} ${body}`);
  }
  log("PASS: a hub in an offscreen document admitted a member, and served it");
} catch (error) {
  failed = true;
  console.error("FAIL:", error);
} finally {
  const quietly = async (step) => {
    try {
      await step?.();
    } catch {
      /* teardown */
    }
  };
  await quietly(() => member?.stop());
  await quietly(() => context?.close());
  await quietly(() => relay?.stop());
  await quietly(() => extensionDir && rm(extensionDir, { recursive: true, force: true }));
  await quietly(() => userDataDir && rm(userDataDir, { recursive: true, force: true }));
}
process.exit(failed ? 1 : 0);

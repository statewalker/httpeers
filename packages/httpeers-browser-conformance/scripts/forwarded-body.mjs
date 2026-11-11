/**
 * A POST, with its body, through the REAL forwarders -- in real Chromium and Firefox.
 *
 *   pnpm --filter @statewalker/httpeers-browser-conformance test:forwarded-body
 *   node scripts/forwarded-body.mjs [--browsers chromium,firefox] [--paths per-exchange,mux]
 *
 * WHY THIS EXISTS (issue #22). Firefox has no `Request.prototype.body`, so a
 * forwarder that rebuilt a request with `body: request.body`, or with
 * `new Request(url, request)` (which reads the same property), sent it on with
 * no body at all and said nothing. Five sites did. NO LOCAL SUITE CAUGHT ANY OF
 * THEM: the session shell's `browser-test.mjs` serves the mesh with a stand-in
 * handler, so its POST never crossed `createGateway` -> the member edge ->
 * libp2p, which is where the body went missing. It was found only by running
 * `apps/demos/scripts/session-smoke.mjs` against production
 * (`0 bytes of 76 sent`, Firefox only, a passing GET beside it).
 *
 * WHAT RUNS. Everything on loopback, nothing on the internet, no credentials:
 *
 *   - a Circuit Relay v2 server (`@statewalker/httpeers-relay`, the deployed one);
 *   - a hub, built the way `httpeers-conformance`'s mesh harness builds one,
 *     reserving on that relay, with one extra mount, `/echo`, that answers
 *     with the method, byte count and SHA-256 of whatever body ARRIVED;
 *   - a page (`scripts/forwarded-body/`, bundled here with Vite from the
 *     packages' sources) that joins as a real browser member over WebSockets
 *     and WebRTC (or the relayed fallback), mounts `createGateway` over the
 *     member's edge exactly as a session's `/peers/` mount does, and POSTs
 *     through `fetch()` -> ServiceWorker -> gateway -> edge -> router -> libp2p.
 *
 * The far side is a stub; the point is that every forwarder between the page
 * and it is the production one. See `docs/security-model.md`.
 *
 * BOTH EXCHANGE PATHS (#56). Each run is made once per `--paths` entry: with
 * one libp2p stream per exchange (the default transport), and with the
 * experimental one windowed mux per peer (`HTTPEERS_LIBP2P_MUX_PER_PEER` for
 * the hub, `?mux=1` for the page). After each browser's run the hub's
 * connections are checked for the protocol the path should have used, so a
 * switch that did nothing fails rather than passing twice.
 *
 * Browsers: Playwright's own. `PLAYWRIGHT_FIREFOX_PATH` / `PLAYWRIGHT_CHROMIUM_PATH`
 * point a launch at another executable when the default install is not there.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { ruleSet, selfCertifyingKeys, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, lookupPeer } from "@statewalker/httpeers-core";
import { createHub, memoryStorage, usesTransportIdentity } from "@statewalker/httpeers-hub";
import {
  createNode,
  dialRelay,
  generateKey,
  hubRelayService,
  MUX_PER_PEER_ENV,
  MUX_PROTOCOL,
  membershipGater,
  PROTOCOL,
  servePeer,
  signerOf,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { startRelay } from "@statewalker/httpeers-relay";
import { chromium, firefox } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const wanted = opt("--browsers", "chromium,firefox").split(",");
const paths = opt("--paths", "per-exchange,mux").split(",");
for (const path of paths) {
  if (path !== "per-exchange" && path !== "mux") throw new Error(`unknown path "${path}"`);
}

/** Joining includes a WebRTC upgrade attempt and, failing it, the relayed fallback. */
const VERDICT_TIMEOUT_MS = 120_000;

const MESH_RULES = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: ['allow if capability("app:read");'],
});

// --- the page --------------------------------------------------------------

/**
 * Bundle the page from SOURCES, never `dist/`: a check that ran the last build
 * would pass on a fix that was never built and fail on one that was.
 */
async function buildPage(outDir) {
  const packages = join(here, "..", "..");
  const alias = ["access", "core", "libp2p", "member"].flatMap((name) => {
    const src = join(packages, `httpeers-${name}`, "src");
    return [
      { find: new RegExp(`^@statewalker/httpeers-${name}/(.+)$`), replacement: `${src}/$1.ts` },
      { find: new RegExp(`^@statewalker/httpeers-${name}$`), replacement: `${src}/index.ts` },
    ];
  });
  await build({
    configFile: false,
    logLevel: "warn",
    root: join(here, "forwarded-body"),
    resolve: { alias },
    build: { outDir, emptyOutDir: true, minify: false, target: "es2022" },
  });
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function servePage(dir) {
  const swWorker = fileURLToPath(import.meta.resolve("@statewalker/webrun-http-browser/sw-worker"));
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://x").pathname;
      const file =
        path === "/sw.js"
          ? swWorker
          : join(dir, normalize(path === "/" ? "index.html" : path).replace(/^(\.\.[/\\])+/, ""));
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // localhost, not 127.0.0.1: either is a secure context, and this is the one
  // edge-reload.mjs uses.
  return { origin: `http://localhost:${server.address().port}`, close: () => server.close() };
}

// --- the mesh --------------------------------------------------------------

/** The stub peer: what arrived, measured on the far side of every forwarder. */
async function echo(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Response.json({
    method: request.method,
    bytes: bytes.byteLength,
    sha256: Buffer.from(digest).toString("hex"),
  });
}

async function startMesh() {
  const relay = await startRelay({ privateKey: await generateKey(), port: 0 });
  const relayAddr = relay.node
    .getMultiaddrs()
    .map(String)
    .find((addr) => addr.startsWith("/ip4/127.0.0.1/") && addr.includes("/ws/"));
  if (relayAddr == null) {
    throw new Error(`the relay advertised no loopback /ws address: ${relay.node.getMultiaddrs()}`);
  }

  const hubKey = await generateKey();
  let isMember = () => false;
  const node = await createNode({
    privateKey: hubKey,
    listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"],
    transports: [webSockets(), circuitRelayTransport(), webRTC(), tcp()],
    services: { relay: hubRelayService() },
    connectionGater: {
      denyDialMultiaddr: async () => false,
      ...membershipGater(() => isMember),
    },
  });
  const hubPeerId = node.peerId.toString();
  await dialRelay(node, relayAddr);
  await waitForCircuitReservation(node);

  const signer = signerOf(hubKey);
  const hub = await createHub({
    selfPeerId: hubPeerId,
    policies: MESH_RULES,
    storage: memoryStorage(),
    mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 10 * 60_000 }),
    extraMounts: { "/echo": echo },
  });
  isMember = (id) => hub.isMember(id);

  const hubPeer = await servePeer({
    node,
    mounts: hub.mounts,
    access: withAccess({
      issuer: hubPeerId,
      rules: MESH_RULES,
      selfPeer: hubPeerId,
      keys: selfCertifyingKeys(),
      provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
      bootstrap: usesTransportIdentity(),
    }),
    // A headless browser's WebRTC upgrade may not complete on every runner;
    // the member then calls the hub over the kept relayed circuit, which the
    // hub must be willing to serve. Either way the request crosses libp2p.
    serveOnLimitedConnection: true,
  });

  const quietly = async (step) => {
    try {
      await step();
    } catch {
      /* teardown */
    }
  };
  return {
    relayAddr,
    hubPeerId,
    /** Protocols of the streams the hub holds now, with how many of each. */
    streamProtocols: () =>
      node
        .getConnections()
        .flatMap((c) => c.streams.map((s) => s.protocol))
        .filter((p) => p != null),
    invite: async () => (await hub.invitations.create(["member"], 10 * 60_000)).id,
    async stop() {
      await quietly(() => hubPeer.stop());
      await quietly(() => hub.stop());
      await quietly(() => node.stop());
      await quietly(() => relay.stop());
    },
  };
}

// --- the run ---------------------------------------------------------------

const engines = {
  chromium: { type: chromium, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
  firefox: { type: firefox, executablePath: process.env.PLAYWRIGHT_FIREFOX_PATH },
};

const failures = [];
// Declared out here and filled inside the `try`, so a failure while building,
// serving or starting the mesh still removes whatever had been set up by then.
let outDir;
let site;
let mesh;

try {
  outDir = await mkdtemp(join(tmpdir(), "httpeers-forwarded-body-"));
  await buildPage(outDir);
  site = await servePage(outDir);

  for (const path of paths) {
    // The hub's links read this when they are built; the page gets `?mux=1`.
    process.env[MUX_PER_PEER_ENV] = path === "mux" ? "1" : "0";
    mesh = await startMesh();

    for (const name of wanted) {
      const engine = engines[name];
      if (engine == null) throw new Error(`unknown browser "${name}"`);
      const label = `${name}, ${path}`;
      console.log(`\n=== ${label}`);
      const browser = await engine.type.launch(
        engine.executablePath ? { executablePath: engine.executablePath } : {},
      );
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const problems = [];
        page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

        const url = new URL(site.origin);
        url.searchParams.set("relay", mesh.relayAddr);
        url.searchParams.set("hub", mesh.hubPeerId);
        url.searchParams.set("invitation", await mesh.invite());
        if (path === "mux") url.searchParams.set("mux", "1");
        await page.goto(url.href);

        await page
          .waitForFunction(() => ["done", "error"].includes(window.__forwardedBody?.state), null, {
            timeout: VERDICT_TIMEOUT_MS,
            polling: 250,
          })
          .catch(() => {});
        const verdict = await page.evaluate(() => window.__forwardedBody ?? null);

        if (verdict?.state !== "done") {
          const why =
            verdict?.state === "error"
              ? `failed while ${verdict.step}: ${verdict.message}`
              : `no verdict within ${VERDICT_TIMEOUT_MS} ms (last step: ${verdict?.step ?? "none"})`;
          console.log(`FAIL [${label}] the page did not finish -- ${why}`);
          for (const p of problems) console.log(`     ${p}`);
          failures.push(`${label}: ${why}`);
          continue;
        }

        console.log(`     hub link: ${verdict.hubLink}`);
        for (const r of verdict.results) {
          const tag = r.status === "pass" ? "ok  " : r.status === "skip" ? "skip" : "FAIL";
          console.log(`${tag} [${label}] ${r.name} -- ${r.detail}`);
          if (r.status === "fail") failures.push(`${label}: ${r.name}: ${r.detail}`);
        }

        // Which protocol the member's calls rode. The mux stream is long-lived,
        // so it is still there while the page is; per-exchange streams end with
        // their exchange, so on that path only the absence of a mux is checked.
        const protocols = mesh.streamProtocols();
        const muxStreams = protocols.filter((p) => p === MUX_PROTOCOL).length;
        const pathOk = path === "mux" ? muxStreams >= 1 : muxStreams === 0;
        console.log(
          `${pathOk ? "ok  " : "FAIL"} [${label}] exchange path -- ${muxStreams} ${MUX_PROTOCOL} stream(s) at the hub, ${
            protocols.filter((p) => p === PROTOCOL).length
          } ${PROTOCOL}`,
        );
        if (!pathOk) failures.push(`${label}: the calls did not ride the ${path} path`);
        await context.close();
      } finally {
        await browser.close();
      }
    }
    await mesh.stop();
    mesh = undefined;
  }
} finally {
  await mesh?.stop();
  site?.close();
  if (outDir != null) await rm(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nforwarded-body: ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log("\nforwarded-body: every body arrived whole");
}
// libp2p keeps timers alive after stop(); the verdict is in, so leave.
process.exit();

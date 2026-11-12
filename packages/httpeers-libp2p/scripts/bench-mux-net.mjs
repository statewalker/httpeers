// EMULATED-NETWORK benchmark (#56 step 2): one libp2p stream per exchange
// vs one windowed mux per peer, across a link with latency, a bandwidth limit,
// queueing and packet loss. Not run in CI. Linux, root, iproute2, python3.
//
//   pnpm --filter @statewalker/httpeers-libp2p build
//   sudo node packages/httpeers-libp2p/scripts/bench-mux-net.mjs \
//     [--profiles lan,broadband,mobile,bad] [--transport tcp|webrtc] [--runs 3] \
//     [--windows 262144,4194304] [--paths stream,mux] [--out results.json] \
//     [--keep-on-ping-failure | --libp2p-monitor] [--cases ping,small,blob,bulk] [--ks 1,10,100]
//
// `--cases` runs a subset (e.g. `small` for the exchange rates alone);
// `bulk` is the bulk download and everything measured beside it. `--ks`
// picks the concurrency levels of the small-exchange case.
//
// Profiles: lan, broadband, mobile, bad (the default set), and
// broadband-noloss, mobile-noloss, longfat (see PROFILES).
//
// THE LINK is `netem-tun.py` beside this file: two network namespaces joined
// by a userland emulator (the kernel here has no sch_netem). The caller runs
// in namespace nemA, the serving child in nemB; every packet between them
// crosses the emulated link. See that file for the model.
//
// PER PROFILE, per configuration (the per-exchange path once -- the mux
// window does not apply to it -- and the mux path once per `--windows`), the
// median of `--runs` runs, each with a fresh pair of processes and a fresh
// connection, of:
//
//   - ping p50/p99 (ms), idle: sequential 64 B GETs;
//   - 256 B POST exchanges/s with K = 1 / 10 / 100 concurrent callers;
//   - 64 KiB GET, idle: time to first byte and to the whole body (p50, ms);
//   - bulk Mbit/s alone: one endless response read as fast as it comes;
//   - while that bulk exchange keeps running: ping p50/p99, and 64 KiB GET
//     time to first byte / whole body (p50 and p99 over its samples).
//
// Durations and sample counts shrink on slow profiles so a full run stays
// under an hour or so. Results print as Markdown and, with `--out`, as JSON.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import {
  createNode,
  createRemote,
  DEFAULT_MUX_WINDOW,
  dialRelay,
  generateKey,
  serveTransport,
  waitForCircuitReservation,
} from "../dist/index.js";

const SCRIPT = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

/**
 * The links. `delay` is one way (RTT = 2 x delay), `jitter` +- per 20 ms
 * slot, `loss` per packet each way, `queue` the bottleneck buffer in ms of
 * wire time. `t` scales the measurement: warm-up and measure seconds for
 * bulk, seconds per small-exchange case, and sample counts.
 */
const PROFILES = {
  lan: {
    link: { rate: 1000, delay: 0.5, jitter: 0, loss: 0, queue: 5 },
    t: { warm: 1, bulk: 4, small: 3, pings: 200, blobs: 40 },
  },
  broadband: {
    link: { rate: 50, delay: 15, jitter: 0, loss: 0.001, queue: 100 },
    t: { warm: 3, bulk: 10, small: 4, pings: 100, blobs: 20 },
  },
  mobile: {
    link: { rate: 10, delay: 40, jitter: 10, loss: 0.01, queue: 200 },
    t: { warm: 3, bulk: 12, small: 5, pings: 60, blobs: 12 },
  },
  bad: {
    link: { rate: 2, delay: 100, jitter: 0, loss: 0.03, queue: 500 },
    t: { warm: 4, bulk: 15, small: 6, pings: 30, blobs: 8 },
  },
  // Not in the default set. The lossy profiles' throughput is set by TCP's
  // response to random loss (both paths alike); these two drop the loss to
  // show what the paths themselves do at those latencies and rates.
  "broadband-noloss": {
    link: { rate: 50, delay: 15, jitter: 0, loss: 0, queue: 100 },
    t: { warm: 3, bulk: 8, small: 4, pings: 100, blobs: 20 },
  },
  "mobile-noloss": {
    link: { rate: 10, delay: 40, jitter: 10, loss: 0, queue: 200 },
    t: { warm: 3, bulk: 10, small: 5, pings: 60, blobs: 12 },
  },
  // Not in the default set: a high bandwidth-delay product (1.25 MB), no loss,
  // to show where a fixed per-port window caps a bulk transfer.
  longfat: {
    link: { rate: 100, delay: 50, jitter: 0, loss: 0, queue: 50 },
    t: { warm: 4, bulk: 10, small: 4, pings: 60, blobs: 16 },
  },
};

/** `--cases`: which measurements a run makes; bulk includes everything under bulk. */
const ALL_CASES = ["ping", "small", "blob", "bulk"];
const BULK_CHUNK = 64 * 1024;
const BLOB = 64 * 1024;
const SMALL = 256;

const quantile = (xs, q) => {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const median = (xs) => quantile(xs, 0.5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nodeTransports(transport) {
  if (transport !== "webrtc") return [tcp()];
  // No ICE servers: the namespaces have no route to a STUN server, and the
  // host candidates (10.77.0.x, across the emulated link) are all it needs.
  return [tcp(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers: [] } })];
}

/**
 * How the nodes find dead connections (#56):
 *
 *   - "default": `createNode` as it is, i.e. `connectionLiveness`, which
 *     aborts a connection on a failed ping only when nothing arrived on it
 *     since the ping was sent;
 *   - "never" (`--keep-on-ping-failure`): the same monitor, never aborting;
 *   - "libp2p" (`--libp2p-monitor`): the node built by hand with libp2p's own
 *     connection monitor at its defaults, as `createNode` was before: it
 *     pings every 10 s with a timeout of at least 5 s and ABORTS THE WHOLE
 *     CONNECTION on a miss, so once a bulk transfer has queued more than ~5 s
 *     of data ahead of the ping (slow, lossy links), every exchange on the
 *     connection fails.
 */
const MONITORS = ["default", "never", "libp2p"];

async function makeNode(init, monitor) {
  if (monitor === "never")
    return createNode({ ...init, connectionMonitor: { abortOnPingFailure: "never" } });
  if (monitor !== "libp2p") return createNode(init);
  return createLibp2p({
    privateKey: init.privateKey,
    addresses: { listen: init.listen ?? [] },
    transports: init.transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ...(init.services ?? {}) },
  });
}

// --- the serving child, in namespace nemB -----------------------------------

if (args.includes("--serve")) {
  const transport = opt("--transport", "tcp");
  const window = opt("--window", undefined);
  const mux = args.includes("--mux") ? (window ? { window: Number(window) } : {}) : false;
  const node = await makeNode(
    {
      privateKey: await generateKey(),
      listen: transport === "webrtc" ? ["/p2p-circuit", "/webrtc"] : ["/ip4/10.77.0.2/tcp/0"],
      transports: nodeTransports(transport),
    },
    opt("--monitor", "default"),
  );
  let relay;
  let dialAddr = node.getMultiaddrs()[0]?.toString();
  if (transport === "webrtc") {
    // Signalling only: a relay in this namespace, which the caller reaches
    // across the link. The data channel then runs directly, 10.77.0.1 <->
    // 10.77.0.2, over UDP through the emulator.
    relay = await createNode({
      privateKey: await generateKey(),
      listen: ["/ip4/10.77.0.2/tcp/0"],
      transports: [tcp()],
      services: {
        relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }),
      },
    });
    await dialRelay(node, relay.getMultiaddrs()[0].toString());
    await waitForCircuitReservation(node);
    dialAddr = `${relay.getMultiaddrs()[0]}/p2p-circuit/webrtc/p2p/${node.peerId}`;
  }
  // The caller gone (crashed, killed) means nobody will send "stop".
  process.on("disconnect", () => process.exit(1));
  const chunk = new Uint8Array(BULK_CHUNK);
  const blob = new Uint8Array(BLOB);
  await serveTransport({
    node,
    muxPerPeer: mux,
    dispatch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/ping") return new Response(new Uint8Array(64));
      if (path === "/small") return new Response(new Uint8Array(await request.arrayBuffer()));
      if (path === "/blob") return new Response(blob);
      if (path === "/bulk")
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
        );
      return new Response(null, { status: 404 });
    },
  });
  process.send({
    addr: dialAddr,
    relayAddr: relay?.getMultiaddrs()[0].toString(),
    peer: node.peerId.toString(),
  });
  process.on("message", async () => {
    await Promise.race([Promise.all([node.stop(), relay?.stop()]), sleep(2000)]);
    process.exit(0);
  });
  await new Promise(() => {});
}

// --- the caller, in namespace nemA ------------------------------------------

/** The measurement under way, named in the report when a run fails. */
let phase = "connect";

async function pings(remote, target, n, untilMs = Number.POSITIVE_INFINITY) {
  const out = [];
  for (let i = 0; i < n && performance.now() < untilMs; i++) {
    const at = performance.now();
    const res = await remote(target, new Request("http://peer.local/ping"));
    await res.arrayBuffer();
    out.push(performance.now() - at);
  }
  return out;
}

/** 64 KiB GETs: [time to first body byte, time to whole body] per sample, ms. */
async function blobs(remote, target, n, untilMs = Number.POSITIVE_INFINITY) {
  const first = [];
  const whole = [];
  for (let i = 0; i < n && performance.now() < untilMs; i++) {
    const at = performance.now();
    const res = await remote(target, new Request("http://peer.local/blob"));
    const reader = res.body.getReader();
    let got = 0;
    let firstAt;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstAt == null) firstAt = performance.now();
      got += value.byteLength;
    }
    if (got !== BLOB) throw new Error(`blob: got ${got} bytes`);
    first.push(firstAt - at);
    whole.push(performance.now() - at);
  }
  return { first, whole };
}

/**
 * K workers doing exchanges back to back for about `seconds`: completed
 * exchanges per second of ACTUAL elapsed time, until the last worker's last
 * exchange is done. Exchanges in flight at the deadline still complete after
 * it, so dividing by the nominal `seconds` overstated the rate by up to one
 * round of K -- most where a round is long (slow links, K = 100) and where the
 * K exchanges complete together (the mux does, in lock-step rounds).
 */
async function forSeconds(seconds, worker, k) {
  let count = 0;
  const started = performance.now();
  const until = started + seconds * 1000;
  await Promise.all(
    Array.from({ length: k }, async () => {
      while (performance.now() < until) {
        const done = await worker();
        count += done;
      }
    }),
  );
  return count / ((performance.now() - started) / 1000);
}

async function oneRun({
  mux,
  window,
  transport,
  t,
  monitor,
  cases = ALL_CASES,
  ks = [1, 10, 100],
}) {
  const run = new Set(cases);
  const childArgs = [
    "--serve",
    "--transport",
    transport,
    ...(mux ? ["--mux"] : []),
    ...(window ? ["--window", String(window)] : []),
    "--monitor",
    monitor,
  ];
  const child = spawn("ip", ["netns", "exec", "nemB", process.execPath, SCRIPT, ...childArgs], {
    stdio: ["ignore", "inherit", "pipe", "ipc"],
  });
  // The serving side's log (e.g. exchanges reset at teardown), marked as such.
  createInterface({ input: child.stderr }).on("line", (line) => {
    process.stderr.write(`[serve] ${line}\n`);
  });
  const served = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`serving child exited ${code}`)));
  });
  let node;
  const result = {};
  try {
    node = await makeNode(
      { privateKey: await generateKey(), transports: nodeTransports(transport) },
      monitor,
    );
    if (transport === "webrtc") {
      await node.dial(multiaddr(served.relayAddr));
      const conn = await node.dial(multiaddr(served.addr));
      if (!conn.remoteAddr.toString().includes("/webrtc"))
        throw new Error("not a WebRTC connection");
      // Leave only the WebRTC connection to the serving peer.
      for (const c of node.getConnections()) {
        if (c.remotePeer.toString() === served.peer && c !== conn) await c.close();
      }
    } else {
      await node.dial(multiaddr(served.addr));
    }
    const target = served.peer;
    const muxOptions = mux ? (window ? { window } : {}) : false;
    const remote = createRemote({ node, muxPerPeer: muxOptions, maxConcurrentOutbound: 512 });

    phase = "idle pings";
    await pings(remote, target, 10); // warm up
    if (run.has("ping")) {
      const idle = await pings(remote, target, t.pings);
      result.pingIdleP50 = median(idle);
      result.pingIdleP99 = quantile(idle, 0.99);
      result.pingIdleN = idle.length;
    }

    const payload = new Uint8Array(SMALL);
    for (const k of run.has("small") ? ks : []) {
      phase = `small exchanges K=${k}`;
      result[`smallK${k}`] = await forSeconds(
        t.small,
        async () => {
          const res = await remote(
            target,
            new Request("http://peer.local/small", { method: "POST", body: payload }),
          );
          await res.arrayBuffer();
          return 1;
        },
        k,
      );
    }

    if (run.has("blob")) {
      phase = "64 KiB GETs, idle";
      const idleBlobs = await blobs(remote, target, Math.ceil(t.blobs / 2));
      result.blobIdleFirstP50 = median(idleBlobs.first);
      result.blobIdleWholeP50 = median(idleBlobs.whole);
    }

    if (!run.has("bulk")) return result;
    // Bulk last: an endless body may keep the link busy after it is cancelled.
    phase = "bulk alone";
    const bulk = await remote(target, new Request("http://peer.local/bulk"));
    const reader = bulk.body.getReader();
    let bytes = 0;
    let reading = true;
    let bulkError;
    const pump = (async () => {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    })().catch((error) => {
      bulkError = error;
    });
    await sleep(t.warm * 1000);
    const [bytesAt, startedAt] = [bytes, performance.now()];
    await sleep(t.bulk * 1000);
    result.bulkAloneMbit = ((bytes - bytesAt) * 8) / 1e6 / ((performance.now() - startedAt) / 1000);

    // Under load: each phase capped at roughly the bulk measuring time again.
    const cap = () => performance.now() + t.bulk * 2000;
    phase = "pings under bulk";
    const loaded = await pings(remote, target, t.pings, cap());
    result.pingBulkP50 = median(loaded);
    result.pingBulkP99 = quantile(loaded, 0.99);
    result.pingBulkN = loaded.length;
    phase = "64 KiB GETs under bulk";
    const loadedBlobs = await blobs(remote, target, t.blobs, cap());
    result.blobBulkFirstP50 = median(loadedBlobs.first);
    result.blobBulkFirstP99 = quantile(loadedBlobs.first, 0.99);
    result.blobBulkWholeP50 = median(loadedBlobs.whole);
    result.blobBulkWholeP99 = quantile(loadedBlobs.whole, 0.99);
    result.blobBulkN = loadedBlobs.first.length;
    reading = false;
    if (bulkError) throw bulkError;
    await Promise.race([reader.cancel().catch(() => {}), sleep(1000)]);
    await Promise.race([pump.catch(() => {}), sleep(500)]);
  } finally {
    if (node) await Promise.race([node.stop(), sleep(3000)]);
    child.send("stop");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(4000)]);
    child.kill("SIGKILL");
  }
  return result;
}

if (args.includes("--call")) {
  const config = JSON.parse(opt("--call", "{}"));
  try {
    const result = await oneRun(config);
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) {
    const cause = error?.cause ? ` (cause: ${error.cause.message ?? error.cause})` : "";
    process.stderr.write(`run failed in "${phase}": ${error?.message ?? error}${cause}\n`);
    process.exit(1);
  }
}

// --- the orchestrator, in the root namespace --------------------------------

function startLink(link) {
  const emu = spawn(
    "python3",
    [
      join(dirname(SCRIPT), "netem-tun.py"),
      "--rate-mbit",
      String(link.rate),
      "--delay-ms",
      String(link.delay),
      "--jitter-ms",
      String(link.jitter),
      "--loss",
      String(link.loss),
      "--queue-ms",
      String(link.queue),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    emu.stdout.on("data", (d) => {
      if (String(d).includes("READY")) resolve(emu);
    });
    emu.once("exit", (code) => reject(new Error(`netem-tun exited ${code}`)));
  });
}

async function stopLink(emu) {
  const exited = new Promise((r) => emu.once("exit", r));
  emu.stdin.end();
  await Promise.race([exited, sleep(5000)]);
}

function callOnce(config) {
  return new Promise((resolve) => {
    const child = spawn(
      "ip",
      ["netns", "exec", "nemA", process.execPath, SCRIPT, "--call", JSON.stringify(config)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      resolve(line ? JSON.parse(line.slice(7)) : undefined);
    });
  });
}

const RUNS = Number(opt("--runs", "3"));
const TRANSPORT = opt("--transport", "tcp");
const WINDOWS = opt("--windows", `${DEFAULT_MUX_WINDOW},${4 * 1024 * 1024}`)
  .split(",")
  .map(Number);
const PATHS = opt("--paths", "stream,mux").split(",");
const OUT = opt("--out", undefined);
const MONITOR = args.includes("--libp2p-monitor")
  ? "libp2p"
  : args.includes("--keep-on-ping-failure")
    ? "never"
    : "default";
if (!MONITORS.includes(MONITOR)) throw new Error(`unknown monitor ${MONITOR}`);
const CASES = opt("--cases", ALL_CASES.join(",")).split(",");
const KS = opt("--ks", "1,10,100").split(",").map(Number);
for (const c of CASES) if (!ALL_CASES.includes(c)) throw new Error(`unknown case ${c}`);
const PROFILE_NAMES = opt("--profiles", "lan,broadband,mobile,bad").split(",");
// All names checked before the first link comes up, not one hour in.
for (const name of PROFILE_NAMES)
  if (PROFILES[name] == null)
    throw new Error(`unknown profile ${name}; known: ${Object.keys(PROFILES).join(", ")}`);

const configs = [
  ...(PATHS.includes("stream") ? [{ label: "per-exchange", mux: false }] : []),
  ...(PATHS.includes("mux")
    ? WINDOWS.map((w) => ({ label: `mux ${Math.round(w / 1024)} KiB`, mux: true, window: w }))
    : []),
];

const all = {};
for (const name of PROFILE_NAMES) {
  const profile = PROFILES[name];
  const emu = await startLink(profile.link);
  const table = {};
  const raw = {};
  try {
    for (const c of configs) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        process.stderr.write(`${name} ${TRANSPORT} ${c.label}: run ${i + 1}/${RUNS}\n`);
        const r = await callOnce({
          mux: c.mux,
          window: c.window,
          transport: TRANSPORT,
          t: profile.t,
          monitor: MONITOR,
          cases: CASES,
          ks: KS,
        });
        if (r) runs.push(r);
        else process.stderr.write("  (run failed)\n");
      }
      table[c.label] = runs.length
        ? Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(runs.map((r) => r[k]))]))
        : {};
      table[c.label].runs = runs.length;
      raw[c.label] = runs;
    }
  } finally {
    await stopLink(emu);
  }
  all[name] = {
    link: profile.link,
    transport: TRANSPORT,
    monitor: MONITOR,
    cases: CASES,
    runsRequested: RUNS,
    table,
    raw,
  };

  const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "—");
  const int = (x) => (Number.isFinite(x) ? `${Math.round(x)}` : "—");
  const rows = [
    ["Bulk alone (Mbit/s)", (r) => fmt(r.bulkAloneMbit)],
    ["Ping p50 / p99 idle (ms)", (r) => `${fmt(r.pingIdleP50)} / ${fmt(r.pingIdleP99)}`],
    // p99 of n <= 100 samples is the slowest sample: n is printed beside it.
    [
      "Ping p50 / p99 under bulk (ms), samples",
      (r) => `${fmt(r.pingBulkP50)} / ${fmt(r.pingBulkP99)}, n=${int(r.pingBulkN)}`,
    ],
    [
      "256 B exchanges/s, K = 1 / 10 / 100",
      (r) => `${int(r.smallK1)} / ${int(r.smallK10)} / ${int(r.smallK100)}`,
    ],
    [
      "64 KiB GET idle, first byte / whole p50 (ms)",
      (r) => `${fmt(r.blobIdleFirstP50)} / ${fmt(r.blobIdleWholeP50)}`,
    ],
    [
      "64 KiB GET under bulk, first byte p50 / p99 (ms), samples",
      (r) => `${fmt(r.blobBulkFirstP50)} / ${fmt(r.blobBulkFirstP99)}, n=${int(r.blobBulkN)}`,
    ],
    [
      "64 KiB GET under bulk, whole p50 / p99 (ms)",
      (r) => `${fmt(r.blobBulkWholeP50)} / ${fmt(r.blobBulkWholeP99)}`,
    ],
    ["Runs (of requested)", (r) => `${r.runs}/${RUNS}`],
  ];
  const labels = Object.keys(table);
  const l = profile.link;
  console.log(
    `\n### ${name} (${TRANSPORT}${MONITOR === "default" ? "" : `, connection monitor: ${MONITOR}`}): ${l.rate} Mbit/s, RTT ${2 * l.delay} ms${l.jitter ? ` ±${l.jitter} ms` : ""}, loss ${l.loss * 100}%, queue ${l.queue} ms\n`,
  );
  console.log(`| | ${labels.join(" | ")} |`);
  console.log(`|---|${labels.map(() => "---").join("|")}|`);
  for (const [label, cell] of rows)
    console.log(`| ${label} | ${labels.map((k) => cell(table[k])).join(" | ")} |`);
  if (OUT) writeFileSync(OUT, JSON.stringify(all, null, 2));
}
process.exit(0);

// LOOPBACK micro-benchmark: one libp2p stream per exchange (the default) vs
// the experimental one windowed mux per peer (#56). Not run in CI.
//
//   pnpm --filter @statewalker/httpeers-libp2p build
//   node packages/httpeers-libp2p/scripts/bench-mux.mjs [--runs 3] [--seconds 3] [--window 262144] [--frame-size 31744]
//     [--path stream|mux] [--cases ping,small,echo,bulk] [--bulk-pings 300] [--bulk-seconds 10]
//
// `--path` and `--cases` run a part only, e.g. under `node --cpu-prof` (which
// the forked serving child inherits) to profile one path and one case.
//
// Two processes on 127.0.0.1 over TCP (Noise, yamux), as httpeers runs them:
// this one calls, a forked child serves. Each path gets a fresh pair of
// processes. Reported per path, as the median of `--runs` runs:
//
//   - ping p50/p99 (ms), idle: sequential 64 B GETs;
//   - bulk MB/s alone: one exchange streaming a response as fast as the
//     caller reads it, nothing else on the connection;
//   - ping p50/p99 (ms) while that bulk exchange runs, and its MB/s
//     meanwhile (the faster a path's pings come back, the more of the CPU
//     they take from the bulk: read it with the pings/s beside it);
//   - small exchanges/s: K concurrent callers doing 256 B POST -> 256 B
//     answer, one HTTP exchange each (K = 1, 10, 100);
//   - 256 B messages/s over K long-lived echo exchanges (a request body
//     streamed in 256 B chunks, echoed back chunk for chunk).
//
// LOOPBACK by default: no latency, loss or bandwidth limit, and both processes
// share one machine's CPUs. It says how the two paths compare in CPU and
// framing cost, not how they behave on a real network (#56 step 2).
//
// TWO HOSTS (a real network, #56 step 2): serve on one machine, call from
// another. The serving side serves both paths at once (a mux server also
// answers one stream per exchange), so one server measures both:
//
//   host B:  node packages/httpeers-libp2p/scripts/bench-mux.mjs --serve \
//              --listen /ip4/0.0.0.0/tcp/4011 [--window 262144] [--frame-size 31744]
//            (prints its multiaddrs; stop it with Ctrl-C)
//   host A:  node packages/httpeers-libp2p/scripts/bench-mux.mjs \
//              --peer /ip4/<B's address>/tcp/4011/p2p/<B's peer id> [--runs 3] [--cases ...]
//
// Each run dials B from a fresh node, so each run gets a fresh connection.
// The server answers anyone who reaches the port with endless bulk bodies and
// echoes: run it only for the measurement, behind a firewall rule that admits
// host A alone. `--window` and `--frame-size` must match on both hosts.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import {
  createNode,
  createRemote,
  DEFAULT_MUX_FRAME_SIZE,
  DEFAULT_MUX_WINDOW,
  generateKey,
  serveTransport,
} from "../dist/index.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(opt("--runs", "3"));
const SECONDS = Number(opt("--seconds", "3"));
const WINDOW = opt("--window", undefined);
const FRAME = opt("--frame-size", undefined);
/** `--path stream|mux` runs one path only; `--cases ping,small,echo,bulk` a subset (for profiling). */
const ONLY_PATH = opt("--path", undefined);
const CASES = new Set(opt("--cases", "ping,small,echo,bulk").split(","));
/**
 * Pings sent while the bulk exchange runs, which is how long it runs: `--bulk-pings` of them, or
 * as many as `--bulk-seconds` allows, whichever ends first. The time bound keeps a run's length
 * independent of the path: where a ping waits behind the bulk bytes (one stream per exchange on a
 * link with a deep queue: 0.7 s each at 70 Mbit/s with a 300 ms queue), 300 pings took minutes
 * and looked like a hang (#123). The samples taken are all reported; "Pings/s meanwhile" says how
 * many there were.
 */
const BULK_PINGS = Number(opt("--bulk-pings", "300"));
const BULK_SECONDS = Number(opt("--bulk-seconds", "10"));
/** `--peer <multiaddr>`: call a server already running on another host instead of forking one. */
const PEER = opt("--peer", undefined);
/** The mux's tuning from the command line; the defaults where not given. */
const muxOptions = {
  ...(WINDOW ? { window: Number(WINDOW) } : {}),
  ...(FRAME ? { frameSize: Number(FRAME) } : {}),
};
const BULK_CHUNK = 64 * 1024;
const SMALL = 256;

// --- the serving child -------------------------------------------------------

if (args.includes("--serve")) {
  // Started by hand on another host (no IPC channel to a parent): serve both
  // paths, on `--listen`, until stopped.
  const standalone = process.send == null;
  const mux = standalone || args.includes("--mux");
  const node = await createNode({
    privateKey: await generateKey(),
    listen: [opt("--listen", "/ip4/127.0.0.1/tcp/0")],
    transports: [tcp()],
  });
  const chunk = new Uint8Array(BULK_CHUNK);
  await serveTransport({
    node,
    muxPerPeer: mux ? muxOptions : false,
    dispatch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/ping") return new Response(new Uint8Array(64));
      if (path === "/small") return new Response(new Uint8Array(await request.arrayBuffer()));
      if (path === "/echo") return new Response(request.body);
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
  const stop = async () => {
    await node.stop();
    process.exit(0);
  };
  if (standalone) {
    console.log("Serving both paths; call it from the other host with --peer and one of:");
    for (const addr of node.getMultiaddrs()) console.log(`  ${addr}`);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    process.send({ addr: node.getMultiaddrs()[0].toString() });
    process.on("message", stop);
  }
  await new Promise(() => {});
}

// --- the caller --------------------------------------------------------------

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const median = (xs) => quantile(xs, 0.5);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function pings(remote, target, n, until = Number.POSITIVE_INFINITY) {
  const out = [];
  for (let i = 0; i < n && performance.now() < until; i++) {
    const at = performance.now();
    const res = await remote(target, new Request("http://peer.local/ping"));
    await res.arrayBuffer();
    out.push(performance.now() - at);
  }
  return out;
}

async function forSeconds(seconds, worker, k) {
  let count = 0;
  const until = performance.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: k }, async () => {
      while (performance.now() < until) {
        // Not `count += await worker()`: that reads `count` before the await
        // and drops every other worker's increments meanwhile.
        const done = await worker();
        count += done;
      }
    }),
  );
  return count / seconds;
}

async function oneRun(mux) {
  const child =
    PEER == null
      ? fork(fileURLToPath(import.meta.url), ["--serve", ...(mux ? ["--mux"] : []), ...args], {
          // The child's stderr is the serving side's log of exchanges reset at teardown.
          stdio: ["ignore", "inherit", "ignore", "ipc"],
        })
      : undefined;
  const { addr } = child
    ? await new Promise((resolve) => child.once("message", resolve))
    : { addr: PEER };
  const node = await createNode({ privateKey: await generateKey(), transports: [tcp()] });
  await node.dial(multiaddr(addr));
  const target = addr.split("/p2p/")[1];
  const remote = createRemote({
    node,
    muxPerPeer: mux ? muxOptions : false,
    maxConcurrentOutbound: 512,
  });
  const result = {};
  try {
    await pings(remote, target, 50); // warm up
    const idle = CASES.has("ping") ? await pings(remote, target, 300) : [Number.NaN];
    result.pingIdleP50 = median(idle);
    result.pingIdleP99 = quantile(idle, 0.99);

    const payload = new Uint8Array(SMALL);
    for (const k of CASES.has("small") ? [1, 10, 100] : []) {
      result[`exchangesPerSecK${k}`] = await forSeconds(
        SECONDS,
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

    for (const k of CASES.has("echo") ? [1, 10, 100] : []) {
      result[`messagesPerSecK${k}`] = await echoMessages(remote, target, k);
    }
    // Bulk LAST: a cancelled endless body may keep the connection busy for a
    // while after the caller lets go, and would slow whatever ran after it.
    // Bulk: read as fast as possible while pinging.
    if (!CASES.has("bulk")) return result;
    const bulk = await remote(target, new Request("http://peer.local/bulk"));
    const reader = bulk.body.getReader();
    let bytes = 0;
    let reading = true;
    const pump = (async () => {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    // Alone first: nothing else on the connection. Then while pinging, which
    // costs each path CPU in proportion to how fast its pings come back.
    let [bytesAt, startedAt] = [bytes, performance.now()];
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    result.bulkAloneMBps = (bytes - bytesAt) / 1e6 / ((performance.now() - startedAt) / 1000);
    [bytesAt, startedAt] = [bytes, performance.now()];
    const loaded = await pings(remote, target, BULK_PINGS, performance.now() + BULK_SECONDS * 1000);
    const elapsed = (performance.now() - startedAt) / 1000;
    reading = false;
    result.pingBulkP50 = median(loaded);
    result.pingBulkP99 = quantile(loaded, 0.99);
    result.bulkMBps = (bytes - bytesAt) / 1e6 / elapsed;
    result.pingsPerSecBulk = loaded.length / elapsed;
    await reader.cancel().catch(() => {});
    await Promise.race([pump.catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
  } finally {
    await node.stop();
    if (child) {
      child.send("stop");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  return result;
}

/** K long-lived echo exchanges, each sending 256 B chunks and reading each echo before the next. */
async function echoMessages(remote, target, k) {
  const until = performance.now() + SECONDS * 1000;
  let count = 0;
  await Promise.all(
    Array.from({ length: k }, async () => {
      let push;
      const body = new ReadableStream({
        start(controller) {
          push = controller;
        },
      });
      const chunk = new Uint8Array(SMALL);
      push.enqueue(chunk);
      const res = await remote(
        target,
        new Request("http://peer.local/echo", { method: "POST", body, duplex: "half" }),
      );
      const reader = res.body.getReader();
      let pending = SMALL;
      while (performance.now() < until) {
        const { value, done } = await reader.read();
        if (done) break;
        pending -= value.byteLength;
        if (pending <= 0) {
          count++;
          pending += SMALL;
          push.enqueue(chunk);
        }
      }
      push.close();
      await reader.cancel().catch(() => {});
    }),
  );
  return count / SECONDS;
}

const paths = Object.fromEntries(
  Object.entries({ "stream per exchange": false, "mux per peer": true }).filter(
    ([, mux]) => ONLY_PATH == null || (ONLY_PATH === "mux") === mux,
  ),
);
const table = {};
for (const [label, mux] of Object.entries(paths)) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`${label}: run ${i + 1}/${RUNS}\n`);
    runs.push(await oneRun(mux));
  }
  table[label] = Object.fromEntries(
    Object.keys(runs[0]).map((key) => [key, round(median(runs.map((r) => r[key])))]),
  );
}

/** A cell value, or "—" for a case `--cases` skipped. */
const f = (x) => (Number.isFinite(x) ? `${x}` : "—");
const n = (x) => (Number.isFinite(x) ? `${Math.round(x)}` : "—");
const rows = [
  ["Ping p50 / p99, idle (ms)", (r) => `${f(r.pingIdleP50)} / ${f(r.pingIdleP99)}`],
  [
    "Ping p50 / p99 while another exchange streams bulk (ms)",
    (r) => `${f(r.pingBulkP50)} / ${f(r.pingBulkP99)}`,
  ],
  ["Bulk throughput meanwhile (MB/s)", (r) => f(r.bulkMBps)],
  ["Pings/s meanwhile", (r) => n(r.pingsPerSecBulk)],
  ["Bulk throughput alone (MB/s)", (r) => f(r.bulkAloneMBps)],
  [
    "256 B exchanges/s, K = 1 / 10 / 100",
    (r) => `${n(r.exchangesPerSecK1)} / ${n(r.exchangesPerSecK10)} / ${n(r.exchangesPerSecK100)}`,
  ],
  [
    "256 B messages/s on K echo exchanges, K = 1 / 10 / 100",
    (r) => `${n(r.messagesPerSecK1)} / ${n(r.messagesPerSecK10)} / ${n(r.messagesPerSecK100)}`,
  ],
];
const labels = Object.keys(table);
console.log(
  `\n${PEER == null ? "LOOPBACK ONLY" : `TWO HOSTS, serving peer ${PEER}`}. Median of ${RUNS} runs, ${SECONDS} s per throughput case; mux window ${WINDOW ?? `${DEFAULT_MUX_WINDOW} (default)`} B, frame size ${FRAME ?? `${DEFAULT_MUX_FRAME_SIZE} (default)`} B.\n`,
);
console.log(`| | ${labels.join(" | ")} |`);
console.log(`|---|${labels.map(() => "---").join("|")}|`);
for (const [name, cell] of rows)
  console.log(`| ${name} | ${labels.map((l) => cell(table[l])).join(" | ")} |`);
process.exit(0);

// LOOPBACK micro-benchmark: one libp2p stream per exchange (the default) vs
// the experimental one windowed mux per peer (#56). Not run in CI.
//
//   pnpm --filter @statewalker/httpeers-libp2p build
//   node packages/httpeers-libp2p/scripts/bench-mux.mjs [--runs 3] [--seconds 3] [--window 262144] [--frame-size 16384]
//
// Two processes on 127.0.0.1 over TCP (Noise, yamux), as httpeers runs them:
// this one calls, a forked child serves. Each path gets a fresh pair of
// processes. Reported per path, as the median of `--runs` runs:
//
//   - ping p50/p99 (ms), idle: sequential 64 B GETs;
//   - ping p50/p99 (ms) while another exchange on the same peer streams a
//     response as fast as the caller reads it, and that bulk's MB/s;
//   - small exchanges/s: K concurrent callers doing 256 B POST -> 256 B
//     answer, one HTTP exchange each (K = 1, 10, 100);
//   - 256 B messages/s over K long-lived echo exchanges (a request body
//     streamed in 256 B chunks, echoed back chunk for chunk).
//
// LOOPBACK ONLY: no latency, loss or bandwidth limit, and both processes
// share one machine's CPUs. It says how the two paths compare in CPU and
// framing cost, not how they behave on a real network (#56 step 2).

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import { createNode, createRemote, generateKey, serveTransport } from "../dist/index.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(opt("--runs", "3"));
const SECONDS = Number(opt("--seconds", "3"));
const WINDOW = opt("--window", undefined);
const FRAME = opt("--frame-size", undefined);
/** The mux's tuning from the command line; the defaults where not given. */
const muxOptions = {
  ...(WINDOW ? { window: Number(WINDOW) } : {}),
  ...(FRAME ? { frameSize: Number(FRAME) } : {}),
};
const BULK_CHUNK = 64 * 1024;
const SMALL = 256;

// --- the serving child -------------------------------------------------------

if (args.includes("--serve")) {
  const mux = args.includes("--mux");
  const node = await createNode({
    privateKey: await generateKey(),
    listen: ["/ip4/127.0.0.1/tcp/0"],
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
  process.send({ addr: node.getMultiaddrs()[0].toString() });
  process.on("message", async () => {
    await node.stop();
    process.exit(0);
  });
  await new Promise(() => {});
}

// --- the caller --------------------------------------------------------------

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const median = (xs) => quantile(xs, 0.5);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function pings(remote, target, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
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
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--serve", ...(mux ? ["--mux"] : []), ...args],
    {
      // The child's stderr is the serving side's log of exchanges reset at teardown.
      stdio: ["ignore", "inherit", "ignore", "ipc"],
    },
  );
  const { addr } = await new Promise((resolve) => child.once("message", resolve));
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
    const idle = await pings(remote, target, 300);
    result.pingIdleP50 = median(idle);
    result.pingIdleP99 = quantile(idle, 0.99);

    const payload = new Uint8Array(SMALL);
    for (const k of [1, 10, 100]) {
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

    for (const k of [1, 10, 100]) {
      result[`messagesPerSecK${k}`] = await echoMessages(remote, target, k);
    }
    // Bulk LAST: a cancelled endless body may keep the connection busy for a
    // while after the caller lets go, and would slow whatever ran after it.
    // Bulk: read as fast as possible while pinging.
    const bulk = await remote(target, new Request("http://peer.local/bulk"));
    const reader = bulk.body.getReader();
    let bytes = 0;
    let reading = true;
    const startedAt = performance.now();
    const pump = (async () => {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    const loaded = await pings(remote, target, 300);
    const elapsed = (performance.now() - startedAt) / 1000;
    reading = false;
    result.pingBulkP50 = median(loaded);
    result.pingBulkP99 = quantile(loaded, 0.99);
    result.bulkMBps = bytes / 1e6 / elapsed;
    await reader.cancel().catch(() => {});
    await Promise.race([pump.catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
  } finally {
    await node.stop();
    child.send("stop");
    await new Promise((resolve) => child.once("exit", resolve));
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

const paths = { "stream per exchange": false, "mux per peer": true };
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

const rows = [
  ["Ping p50 / p99, idle (ms)", (r) => `${r.pingIdleP50} / ${r.pingIdleP99}`],
  [
    "Ping p50 / p99 while another exchange streams bulk (ms)",
    (r) => `${r.pingBulkP50} / ${r.pingBulkP99}`,
  ],
  ["Bulk throughput meanwhile (MB/s)", (r) => `${r.bulkMBps}`],
  [
    "256 B exchanges/s, K = 1 / 10 / 100",
    (r) =>
      `${Math.round(r.exchangesPerSecK1)} / ${Math.round(r.exchangesPerSecK10)} / ${Math.round(r.exchangesPerSecK100)}`,
  ],
  [
    "256 B messages/s on K echo exchanges, K = 1 / 10 / 100",
    (r) =>
      `${Math.round(r.messagesPerSecK1)} / ${Math.round(r.messagesPerSecK10)} / ${Math.round(r.messagesPerSecK100)}`,
  ],
];
const labels = Object.keys(table);
console.log(
  `\nLOOPBACK ONLY. Median of ${RUNS} runs, ${SECONDS} s per throughput case; mux window ${WINDOW ?? "262144 (default)"} B, frame size ${FRAME ?? "16384 (default)"} B.\n`,
);
console.log(`| | ${labels.join(" | ")} |`);
console.log(`|---|${labels.map(() => "---").join("|")}|`);
for (const [name, cell] of rows)
  console.log(`| ${name} | ${labels.map((l) => cell(table[l])).join(" | ")} |`);
process.exit(0);

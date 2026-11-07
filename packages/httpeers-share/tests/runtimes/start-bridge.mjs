// Started under node, bun or deno by `bridge-runtimes.e2e.test.ts`: one Bridge
// on a loopback port, its origin printed as the first line of stdout.
import { createBridge, listenLoopback } from "../../dist/bridge/index.js";

const [token, allowedOrigin] = process.argv.slice(2);
const listening = await listenLoopback(createBridge({ token, allowedOrigin }));
console.log(listening.origin);

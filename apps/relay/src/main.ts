/**
 * The container entrypoint.
 *
 * Everything env-shaped lives here rather than in the modules it configures,
 * so that `relay.ts` stays a function of its arguments and the tests never
 * touch `process.env`.
 */
import { parseAnnounceAddrs } from "./addresses.js";
import { DEFAULT_RELAY_KEY_PATH, MissingRelayKeyError, resolveRelayKey } from "./key.js";
import { startRelay } from "./relay.js";

// `async` is load-bearing, not stylistic. Every guard below throws
// synchronously; a plain function would throw before returning a promise, so
// `main().catch()` would never run and the operator would get a raw stack
// trace instead of the guidance the error was written to carry.
async function main(): Promise<void> {
  const port = process.env.RELAY_PORT != null ? Number(process.env.RELAY_PORT) : undefined;
  const keyPath = process.env.RELAY_KEY_PATH ?? DEFAULT_RELAY_KEY_PATH;
  const announce = parseAnnounceAddrs(process.env.RELAY_ANNOUNCE_ADDRS);

  // Behind a reverse proxy the bound address is unreachable from outside, so
  // starting without an announce list produces a relay that runs, reports
  // healthy, and is undialable. Refuse instead -- the failure is otherwise
  // discovered by clients, not by the deploy.
  if (announce.length === 0 && process.env.RELAY_REQUIRE_ANNOUNCE !== "false") {
    throw new Error(
      "relay: RELAY_ANNOUNCE_ADDRS is empty.\n" +
        "relay: behind a TLS-terminating proxy the address this process binds is not the address\n" +
        "relay: peers can dial, so advertising the bound address would make every connection fail\n" +
        "relay: with a symptom pointing at the relay rather than at its advertised address.\n" +
        "relay: set e.g. RELAY_ANNOUNCE_ADDRS=/dns4/relay.httpeers.net/tcp/443/tls/ws\n" +
        "relay: for a local run without a proxy, set RELAY_REQUIRE_ANNOUNCE=false.",
    );
  }

  const privateKey = resolveRelayKey({ keyPath, seedBase64: process.env.RELAY_KEY });
  const relay = await startRelay({ privateKey, port, announce });

  console.log(`relay peerId: ${relay.node.peerId.toString()}`);
  console.log("relay addrs:");
  for (const addr of relay.node.getMultiaddrs()) console.log(`  ${addr.toString()}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nrelay: received ${signal}, stopping...`);
    try {
      await relay.stop();
    } catch (err) {
      console.error("relay: error during stop:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof MissingRelayKeyError) console.error(err.message);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * The container entrypoint.
 *
 * Everything env-shaped lives here rather than in the modules it configures,
 * so that `relay.ts` stays a function of its arguments and the tests never
 * touch `process.env`.
 */
import { parseAnnounceAddrs } from "./addresses.js";
import { clearRelayDocument, writeRelayDocument } from "./bootstrap-doc.js";
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

  // Opt-in: unset means no document is written and startup is exactly what it
  // was before this existed. Local runs are unaffected.
  const bootstrapPath = process.env.RELAY_BOOTSTRAP_PATH?.trim();
  const publishBootstrap = bootstrapPath != null && bootstrapPath.length > 0;

  // BEFORE the relay is attempted, not after it succeeds. Every failure below
  // -- a missing key, an empty announce list, a port already bound -- would
  // otherwise leave the previous document in place for the reverse proxy to
  // keep serving, pointing peers confidently at a relay that is crash-looping.
  // Clearing here makes a relay that cannot start yield 404 instead.
  if (publishBootstrap) clearRelayDocument(bootstrapPath);

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

  // From what the node advertises, never from RELAY_ANNOUNCE_ADDRS -- see
  // bootstrap-doc.ts. A failure here is fatal on purpose: the operator asked
  // for the document to be published, and a relay that is healthy while the
  // document is silently absent is the failure this whole path exists to make
  // impossible. The likely cause is ownership, since the process runs as an
  // unprivileged user and the directory is a mounted volume.
  if (publishBootstrap) {
    try {
      writeRelayDocument(
        bootstrapPath,
        relay.node.getMultiaddrs().map((addr) => addr.toString()),
      );
    } catch (err) {
      await relay.stop();
      throw new Error(
        `relay: could not write the bootstrap document to "${bootstrapPath}".\n` +
          "relay: the relay refuses to keep running without it, because a healthy relay whose\n" +
          "relay: bootstrap document is missing is a failure nobody notices until peers cannot\n" +
          "relay: reach it. Check that the directory exists and is writable by the user this\n" +
          "relay: process runs as (`node` in the image; the volume must be chowned to it), or\n" +
          "relay: unset RELAY_BOOTSTRAP_PATH to stop publishing the document at all.\n" +
          `relay: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log(`relay: wrote the bootstrap document to ${bootstrapPath}`);
  }

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

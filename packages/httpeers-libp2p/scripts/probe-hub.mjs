// An INDEPENDENT libp2p client: does the public relay actually carry a circuit
// to the hub right now? Run from this directory so its deps resolve.
//
//   node probe-hub.mjs <hubPeerId>
//
// This is the check that found the 2026-09-19 incident, and the only one that
// answers the members' question rather than the hub's own belief.
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";

const hubPeerId = process.argv[2];
if (hubPeerId == null) throw new Error("usage: node probe-hub.mjs <hubPeerId>");

const doc = await (
  await fetch("https://relay.httpeers.net/.well-known/httpeers-relay.json")
).json();
const relayAddr = doc.relayAddrs[0];
const target = `${relayAddr}/p2p-circuit/p2p/${hubPeerId}`;

const node = await createLibp2p({
  transports: [webSockets(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
});

const started = Date.now();
try {
  const connection = await node.dial(multiaddr(target));
  console.log(
    JSON.stringify({
      ok: true,
      ms: Date.now() - started,
      remotePeer: connection.remotePeer.toString(),
      limited: connection.limits != null,
      remoteAddr: connection.remoteAddr.toString(),
    }),
  );
  await connection.close();
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, ms: Date.now() - started, error: String(error).split("\n")[0] }),
  );
  process.exitCode = 1;
} finally {
  await node.stop();
}

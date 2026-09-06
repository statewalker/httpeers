/**
 * Generates the relay's identity. The ONLY place a key is created.
 *
 * Refuses to overwrite: replacing a live relay's key invalidates every
 * client's configuration, so that has to be a deliberate `rm` rather than a
 * re-run of a setup command.
 *
 * Prints the key base64-encoded as well, because that is the `RELAY_KEY`
 * value for seeding a fresh volume elsewhere, and because it is the thing to
 * put in a password manager -- there is no other copy.
 */
import { existsSync } from "node:fs";
import { privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { DEFAULT_RELAY_KEY_PATH, generateRelayKey, loadRelayKey } from "./key.js";

const keyPath = process.argv[2] ?? process.env.RELAY_KEY_PATH ?? DEFAULT_RELAY_KEY_PATH;

if (existsSync(keyPath)) {
  const existing = loadRelayKey(keyPath);
  console.log(`relay: key already exists at "${keyPath}" -- not overwriting.`);
  console.log(`relay: peerId ${peerIdFromPrivateKey(existing).toString()}`);
  console.log("relay: to replace this identity, delete the file deliberately and re-run.");
  process.exit(0);
}

const key = await generateRelayKey(keyPath);
console.log(`relay: wrote a new Ed25519 key to "${keyPath}".`);
console.log(`relay: peerId ${peerIdFromPrivateKey(key).toString()}`);
console.log("relay: back this up -- there is no other copy, and losing it changes the relay's");
console.log("relay: identity, which every client has embedded in its configuration.");
console.log("");
console.log("RELAY_KEY (base64, for seeding another deployment):");
console.log(Buffer.from(privateKeyToProtobuf(key)).toString("base64"));

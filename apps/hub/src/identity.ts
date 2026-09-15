/**
 * The hub's key, and the peerId published beside it.
 *
 * `hub.key` is the libp2p protobuf encoding (`encodeKey`), the same format as
 * the relay's key, created once and never overwritten: `identityStore` has no
 * write on the path where a key already exists, which is the property that
 * keeps a restart from re-founding the mesh.
 *
 * `hub.env` is `HUB_PEER_ID=<peerId>\n`, rewritten on EVERY start. LiteLLM's
 * entrypoint waits for it and sources it to build `SERVER_ROOT_PATH`, so it has
 * to exist after any start, including one where an operator deleted it.
 */

import { join } from "node:path";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { identityStore, peerIdOf } from "@statewalker/httpeers-libp2p";
import { fileBytesStore } from "@statewalker/httpeers-libp2p/node";
import { writeFileAtomic } from "./fs-atomic.js";

export const HUB_KEY_FILE = "hub.key";
export const HUB_ENV_FILE = "hub.env";

export async function loadOrCreateIdentity(
  dir: string,
): Promise<{ privateKey: Ed25519PrivateKey; peerId: string }> {
  // `fileBytesStore` writes the key write-then-rename, in `dir`, mode 0600.
  const privateKey = await identityStore({
    backend: fileBytesStore(dir),
    key: HUB_KEY_FILE,
  }).loadOrCreate();
  const peerId = peerIdOf(privateKey);
  // 0644, unlike the key: it is not a secret, and LiteLLM's container reads it.
  await writeFileAtomic(join(dir, HUB_ENV_FILE), `HUB_PEER_ID=${peerId}\n`, 0o644);
  return { privateKey, peerId };
}

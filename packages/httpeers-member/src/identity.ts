/**
 * This origin's persistent libp2p identity, in IndexedDB.
 *
 * IDENTITY PERSISTS PER ORIGIN. Each page (the main app, the image peer,
 * the hub page) is its own origin (`../static-server/main.ts`'s "ORIGINS
 * ARE A CORRECTNESS REQUIREMENT" note) and therefore its own IndexedDB, so
 * each gets its OWN signing key and its own peerId. That is deliberate: two
 * pages sharing one identity would be two independent libp2p nodes racing
 * to be "the" peer for that identity, which is a different and worse
 * problem than two distinct mesh members.
 *
 * THE KEY FORMAT IS THE NODE SIDE'S, EXACTLY. `@libp2p/crypto/keys`'s
 * protobuf encoding -- the same bytes `../setup/keys.ts` writes to
 * `.httpeers/hub.key` and `../hub/main.ts` reads back -- just stored in
 * IndexedDB instead of a file, because a browser has no filesystem to write
 * one to. That is not a cosmetic alignment: `peerIdFromPrivateKey` on a key
 * that round-tripped through this store must produce the SAME peerId string
 * as the Node path produces for the same key, or the hub page's mesh
 * identity would not be the thing every token's `mesh` claim restates.
 * `tests/browser-identity.test.ts` pins that round trip.
 *
 * WHY THIS IS SPLIT OUT OF `./browser-profile.ts` (Task 24). That module
 * loaded the key and handed it straight to `createLibp2p`, which never
 * gives it back -- fine for a page that only needs a node, and impossible
 * for the hub page, which must ALSO pass the very same key to `createPeer`
 * so its `mintToken` closure signs as the mesh (`httpeers.core`'s
 * `CreatePeerInit.privateKey`). Loading the identity is now its own step
 * that a caller can take first and use twice. `browser-profile.ts` re-exports
 * everything here, so nothing that imported it from there had to change.
 */
import { privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { generateKey } from "@statewalker/httpeers-libp2p";
import type { AsyncBytesBackend } from "./kv.js";


/** Where this origin's identity key lives in IndexedDB (via `idb-keyval`, the same store `@statewalker/webrun-http-browser` already uses). */
export const IDENTITY_STORAGE_KEY = "httpeers:identity-key";

/**
 * Where the key is kept, injectable -- `./kv.ts`'s bytes seam, defaulting
 * to the real IndexedDB.
 *
 * ADDED IN TASK 28 SO THE STORE'S OWN BEHAVIOUR IS NODE-TESTABLE, not just
 * its codec. "A first run has no key", "a second run gets the same peerId
 * back", and "after a reset the next run is a different peerId" are the
 * three facts the two consumer pages' whole resume story rests on, and all
 * three used to be unreachable from Node because `idb-keyval` needs a real
 * IndexedDB. The stored VALUE is unchanged -- raw protobuf bytes, exactly
 * as Task 24 wrote them -- so a page that already holds a key reads it back
 * identically; see `./kv.ts` on why the bytes seam is separate from the
 * string one.
 */
export interface IdentityStoreInit {
  backend: AsyncBytesBackend;
  storageKey?: string;
}

const backendOf = (init: IdentityStoreInit): AsyncBytesBackend => init.backend;
const keyOf = (init: IdentityStoreInit): string => init.storageKey ?? IDENTITY_STORAGE_KEY;

/**
 * Decode the protobuf bytes this store holds, refusing anything that is not
 * Ed25519. Exported so a Node test can exercise the decode half of the
 * round trip without an IndexedDB (see this module's comment).
 */
export function decodeIdentity(bytes: Uint8Array): Ed25519PrivateKey {
  const key = privateKeyFromProtobuf(bytes);
  if (key.type !== "Ed25519") {
    throw new Error(
      `identity: the key stored at "${IDENTITY_STORAGE_KEY}" is a ${key.type} key -- ` +
        "only Ed25519 is supported (design note 05 §2).",
    );
  }
  return key;
}

/** The bytes this store holds for `key`. The inverse of `decodeIdentity`. */
export function encodeIdentity(key: Ed25519PrivateKey): Uint8Array {
  return privateKeyToProtobuf(key);
}

/**
 * The peerId a key derives to -- the same computation `httpeers.core`'s
 * `mintToken` uses, and the same one `../setup/keys.ts`'s `peerIdOf` does
 * on the Node side. Not imported from there: that module reads
 * `node:fs`/`node:crypto` at module scope and would poison a browser
 * bundle. `tests/browser-identity.test.ts` pins that the two agree.
 */
export function peerIdOf(key: Ed25519PrivateKey): string {
  return peerIdFromPrivateKey(key).toString();
}

/**
 * Load this origin's persisted identity, or generate and persist one on
 * first run. Reuses `httpeers.core`'s own `generateKey` rather than
 * calling `@libp2p/crypto`'s `generateKeyPair` directly a second time --
 * one call site for "how this mesh mints a fresh identity," matching the
 * lesson note 22 §5/§6 draws about reading this workspace's own source
 * before re-deriving something already sitting in it.
 */
export async function loadOrCreateIdentity(
  init: IdentityStoreInit,
): Promise<Ed25519PrivateKey> {
  const stored = await readIdentity(init);
  if (stored != null) return stored;
  const key = await generateKey();
  await backendOf(init).set(keyOf(init), encodeIdentity(key));
  return key;
}

/**
 * This origin's persisted identity, or `null` when it has never had one.
 *
 * THE DIFFERENCE BETWEEN THIS AND `loadOrCreateIdentity` IS A SENTENCE ON
 * SCREEN. A page that starts by trying to RESUME a membership has to tell
 * an operator which of two situations it is in, and they are not alike:
 * "this browser has never joined anything" is a first run, and "this
 * browser holds an identity the hub does not recognise" is a hub reset or a
 * revoked membership -- the second being the one that is otherwise baffling
 * (Task 28, requirement 3). `loadOrCreateIdentity` cannot tell them apart
 * by construction, because it has already created the key by the time it
 * returns. So the read is its own step, and creation happens only when the
 * page actually goes on to join.
 */
export async function readIdentity(
  init: IdentityStoreInit,
): Promise<Ed25519PrivateKey | null> {
  const stored = await backendOf(init).get(keyOf(init));
  if (stored == null) return null;
  return decodeIdentity(stored);
}

/**
 * Forget this origin's identity, so the next `loadOrCreateIdentity` mints a
 * fresh one.
 *
 * DESTRUCTIVE, AND FOR THE HUB PAGE IT IS THE MOST DESTRUCTIVE THING THERE
 * IS: the hub's peerId IS the mesh (`claims.mesh === claims.iss`), so
 * dropping this key does not rotate a credential, it founds a DIFFERENT
 * mesh -- every token ever issued stops verifying and every join URL handed
 * out stops working. Whoever calls this owes the operator a confirmation
 * that says so in those terms; `../pages/hub/main.ts` is where that lives.
 * A caller that also holds hub state must clear it in the same breath (see
 * that page): members carried into a new mesh would be peers that never
 * joined it.
 */
export async function clearIdentity(init: IdentityStoreInit): Promise<void> {
  await backendOf(init).delete(keyOf(init));
}

/**
 * The transport — the one package in the extraction that knows what libp2p is.
 *
 * An explicit list, never `export *`: the barrel this code came from ended
 * with `export * from "./transport-duplex.js"`, which is how a package that
 * documented itself as isomorphic pulled libp2p, TCP, Noise and yamux into
 * every consumer's bundle.
 */

export {
  type BytesStore,
  decodeKey,
  encodeKey,
  type GenerateKeyInit,
  generateKey,
  type IdentityStore,
  type IdentityStoreInit,
  identityStore,
  peerIdOf,
  type SignerLike,
  signerOf,
} from "./identity.js";

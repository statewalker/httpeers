/**
 * Membership tokens: minting and verification, over Biscuit (ADR-0019).
 *
 * A token is a Biscuit — an Ed25519-signed, attenuable capability token whose
 * contents are Datalog facts and checks — serialised as URL-safe base64. It
 * replaces the hand-rolled compact JWS this file used to carry. Prototype 10
 * (`apps/httpeers-protos/10-token-chain/`) is the reference; this file is that
 * chain narrowed to the seam the rest of the package already speaks
 * (`mintToken` / `verifyToken` / `MeshClaims`), not a re-derivation of it.
 *
 * THE MESH IS THE HUB'S peerId, AND THAT IS WHAT MAKES VERIFICATION OFFLINE.
 * Biscuit verifies a token against a ROOT PUBLIC KEY the verifier supplies. We
 * do not fetch one and we do not carry one in the token: an Ed25519 libp2p
 * peerId inlines its own public key, so `peerIdFromString(issuer).publicKey`
 * IS the root key, recovered by local computation from the mesh id the caller
 * already knows. `mintToken` derives the same peerId from the signing key it
 * was handed, so a hub can only ever mint tokens that self-certify as its own
 * mesh. No JWKS, no directory, no network — the same property the JWS version
 * had, obtained the same way. This is why `tokens.ts` keeps its `@libp2p/*`
 * imports: they are not incidental, they are the bridge between the mesh's
 * identity scheme and Biscuit's key scheme (see `rootKeyFor` / `signingKeyFor`).
 *
 * WHAT THE TOKEN SAYS. `mintToken` writes one authority block:
 *
 *     mesh("<hubPeerId>"); subject("<sub>"); bound("<sub>");
 *     role("<r>"); ...  issued_at(<iatMs>); expires_at(<expMs>);
 *     audience("<peer>"); ...            // OR audience_unrestricted(true)
 *     check if bound($k), connection_peer($k);
 *     check if mesh($m), root_mesh($m);
 *     check if audience($k), self_peer($k);   // OR: audience_unrestricted(true)
 *     check if time_ms($t), $t < <expMs>;
 *
 * WHAT THE VERIFIER SAYS. `verifyToken` asserts, and only ever asserts, facts
 * the NODE knows — never anything read out of the token:
 *
 *     connection_peer("<what the transport handshake proved>");
 *     self_peer("<this verifier's own peerId>");
 *     root_mesh("<the mesh this verifier expects>");
 *     time_ms(<this verifier's clock>);
 *     allow if true;
 *
 * That separation is the design (prototype 10's README), not an implementation
 * detail: the token states what it was granted, the node states what is true
 * right now, and Datalog decides. `allow if true` means "this verifier adds no
 * policy of its own; the token's own checks are the whole decision" — exactly
 * the JWS-era semantics, and it stays that way. The NODE's policy is a second,
 * separate authorization in `rules.ts`, run by the policy middleware over the
 * claims this one produced: splitting them is what keeps a tokenless request
 * decidable and keeps "no usable token" a 401 while "not permitted" is a 403.
 * See `rules.ts`'s `authorize` for the full argument.
 *
 * THE BINDING IS DATALOG NOW (ADR-0009). `check if bound($k),
 * connection_peer($k)` is the rule `peer-handlers.ts` states in prose
 * (`claims.sub !== peer` -> 403). It is now enforced where it belongs — inside
 * the token, by the token — so a hub-minted bearer token cannot be replayed by
 * the provider that received it even against a verifier that forgot to check.
 * `peer-handlers.ts` keeps its own check: it is fed by an INJECTED `getClaims`
 * seam, so it must still refuse a mismatch its supplier let through.
 *
 * THE AUDIENCE, AND WHO CHECKS IT (ADR-0020). A token may name the peers it
 * may be presented to. The load-bearing detail is not the field, it is WHO
 * EVALUATES IT: `audience` is a fact of the TOKEN, `self_peer` is a fact the
 * DESTINATION asserts about itself, and the check that joins them lives in the
 * token's authority block, so it is evaluated by the receiving peer against
 * its own identity. A peer that is not an intended audience refuses however
 * the request reached it — it does not trust whoever routed it to have
 * respected the restriction. That is defence in depth behind ADR-0011's
 * forwarding decision: a bug in either is caught by the other.
 *
 * This does NOT close a replay hole — ADR-0009's binding already did that.
 * What it adds is least privilege: a token obtained to talk to one peer is
 * now mintable so that it cannot be used against another, so the blast radius
 * of a compromise stops being the whole mesh.
 *
 * The audience check needs `self_peer`, which is why `verifyToken` grew a
 * `selfPeer` option. It is OPTIONAL, and omitting it fails CLOSED: a verifier
 * that does not say who it is satisfies no `audience` fact and refuses every
 * audience-scoped token. Unrestricted tokens are unaffected, which is what
 * lets a caller that has not been updated keep working without being handed a
 * permissive default.
 *
 * UNRESTRICTED IS A STATE, NOT A SILENCE. `mintToken` always writes one of
 * two things: `audience(...)` facts plus the check above, or the explicit
 * marker `audience_unrestricted(true)` plus `check if
 * audience_unrestricted(true)` — a check that is trivially satisfied by its
 * own fact and is there so the two states are structurally parallel (a fact
 * and a check about it) rather than "present" versus "missing". A token with
 * NEITHER is possible only from an issuer older than this field; `readClaims`
 * reports that third state as `"unstated"` and it verifies as unrestricted.
 *
 * That last choice is the one migration decision here, and it is deliberate:
 * every token in flight when this shipped carries no audience, so reading
 * absence as "refuse everywhere" would break the running mesh, while reading
 * it as "valid everywhere" is exactly the permissive default ADR-0020 argues
 * against. It is safe here for a reason particular to Biscuit: the audience
 * facts and their check are in the SIGNED authority block, so an attacker
 * holding a restricted token cannot strip it back to silence — that would
 * need the hub's key. Silence is always an old issuer, never a downgrade. The
 * cost is that a mesh cannot yet REQUIRE its tokens to state an audience;
 * doing so is a verifier-side policy for whoever decides the old tokens are
 * gone, and `MeshClaims.audience` distinguishing `"unstated"` from
 * `"unrestricted"` is what makes it decidable when they do.
 *
 * NO AUDIENCE CLASSES YET. ADR-0020 also permits restriction by CLASS —
 * `audience_class($t,$v)` against a `self_fact($t,$v)` the destination
 * asserts. Not implemented: nothing in this package or the stack above it
 * produces a `self_fact`, and the ADR is explicit that such facts are
 * security-relevant and must be as trustworthy as the node's own policy. An
 * option nothing can populate would be a security surface with no source, so
 * classes wait for a node-identity configuration to attach them to. A token
 * carrying `audience_class` today is refused by A-20's rule: an unsatisfied
 * check this verifier does not know how to satisfy denies.
 *
 * AN APPENDED BLOCK CANNOT FORGE ANY OF THIS. Biscuit scopes facts: a check in
 * the authority block sees authority and authorizer facts only, never a later
 * block's. So a thief who appends `bound("mallory"); role("admin")` to a stolen
 * token changes nothing — the authority check cannot see it, and neither can
 * `readClaims`, which reads through the authorizer and therefore also sees only
 * the authority block. Attenuation can narrow a token; it can never widen one.
 * That covers the audience too: appending `audience("elsewhere")` or
 * `audience_unrestricted(true)` to a scoped token is invisible to the
 * authority check that consumes them, so it neither travels nor reports.
 *
 * MILLISECONDS, NOT DATES — the one deliberate divergence from prototype 10,
 * which asserts a date-valued `time($t)`. This package's clock is
 * `now: () => number` everywhere, and `revocation.ts` compares `claims.iat`
 * against a hub-issued `changedAt` at MILLISECOND resolution: `clock.ts`'s
 * `createMonotonicClock` exists precisely because a same-millisecond tie there
 * was a real revocation bypass. Biscuit's date terms are RFC3339 seconds, so
 * routing time through them would throw away the resolution that fix depends
 * on. The predicate is therefore named `time_ms` and carries an integer, so
 * that a rule ported from prototype 10 expecting a date fails loudly (unknown
 * predicate -> unsatisfied check -> deny, A-20) rather than silently comparing
 * two different notions of time.
 */
import {
  AuthorizerBuilder,
  Biscuit,
  BiscuitBuilder,
  KeyPair,
  PrivateKey,
  PublicKey,
  Rule,
  SignatureAlgorithm,
} from "@biscuit-auth/biscuit-wasm";
import type {
  Anonymous,
  MeshClaims,
  PeerIdStr,
  TokenRejectionReason,
} from "@statewalker/httpeers-core";
import { ANONYMOUS } from "@statewalker/httpeers-core";
import { type IssuerKeys, meshIdProblem, publicKeyOf, selfCertifyingKeys } from "./keys.js";
import type { Signer } from "./signer.js";

/**
 * The evaluation budget (spec P9, ADR-0019), and NOT an optional hardening
 * measure: `Authorizer.authorize()` with this build's default limits throws
 * `{ RunLimit: 'Timeout' }` on a single-fact policy, so every authorization
 * goes through `authorizeWithLimits`. The ceiling is far above any legitimate
 * evaluation; it is here so that a pathological one — a token carrying a rule
 * set that explodes combinatorially — denies with `TooManyFacts` instead of
 * becoming a denial of service. `tokens.test.ts` proves that on a real token.
 */
export const LIMITS = { max_facts: 5_000, max_iterations: 200, max_time_micro: 1_000_000 };

/**
 * `generateMeshKey` used to live here, returning libp2p's `Ed25519PrivateKey`.
 * It is `generateSigner()` in `./signer.js` now, on WebCrypto — the reason
 * this file no longer imports `@libp2p/crypto` at all. The comment it carried
 * argued for keeping the libp2p allowlist at two entries; the allowlist is
 * empty now, which is a better answer to the same worry.
 */

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

/**
 * `TokenRejectionReason` — the closed set of reasons — now lives in
 * `types.ts`, the file that imports nothing, because `peer-handlers.ts` has
 * to map a refusal onto a status code and may not import this one. See its
 * doc comment there. It is still exported from the package root.
 */

/** Raised for any reason a token fails to verify. `reason` is stable and matchable. */
export class TokenVerificationError extends Error {
  readonly reason: TokenRejectionReason;
  /**
   * The one-line prose, WITHOUT the `httpeers token rejected: ` prefix
   * `message` carries. Kept as its own field because it is what a refusal
   * surfaces to a client (`peer-handlers.ts`), where the prefix would be
   * noise — a client that got a 403 already knows it was rejected.
   */
  readonly detail: string;
  /**
   * Every failing check, as `block <id> check <id>: <rule text>` (spec P8).
   * Empty when the refusal was cryptographic or structural rather than
   * logical. This is the explainability the `.access` tree gave as "which
   * directory governed", at finer grain — keep it out of headers; it belongs
   * in a body, if it is surfaced at all.
   */
  readonly failedChecks: readonly string[];

  constructor(reason: TokenRejectionReason, detail: string, failedChecks: string[] = []) {
    super(`httpeers token rejected: ${detail}`);
    this.name = "TokenVerificationError";
    this.reason = reason;
    this.detail = detail;
    this.failedChecks = failedChecks;
  }
}

// ---------------------------------------------------------------------------
// Key bridge: mesh ids <-> Biscuit keys
// ---------------------------------------------------------------------------

/**
 * Biscuit signs from a 32-byte Ed25519 SEED, and a `Signer` carries exactly
 * that. The prototype took libp2p's `Ed25519PrivateKey`, whose `raw` is the
 * 64-byte expanded form — seed followed by public key — and sliced the first
 * 32 bytes here.
 *
 * Verified, not assumed: the ported `tokens.test.ts` asserts that the key
 * Biscuit derives from this seed is byte-for-byte the mesh id's own public
 * key, which is the whole reason a token minted here verifies against a hub's
 * peerId.
 */
function signingKeyFor(seed: Uint8Array): PrivateKey {
  return PrivateKey.fromBytes(seed, SignatureAlgorithm.Ed25519);
}

/**
 * Recover the root public key from a mesh id. Local computation, never a fetch
 * — see `keys.ts` for why a peerId is its own key and what that saves.
 */
function rootKeyFor(issuer: string): PublicKey {
  const raw = publicKeyOf(issuer);
  if (raw == null) {
    // The two reasons are kept apart deliberately. "Not a peerId" and "a
    // peerId that does not carry its key" send an operator to different
    // places, and an early version of this function collapsed them — which
    // reported a perfectly valid RSA peerId as unparseable.
    if (meshIdProblem(issuer) === "not-ed25519") {
      throw new TokenVerificationError(
        "issuer-not-ed25519",
        "issuer peerId does not carry an inline Ed25519 public key",
      );
    }
    throw new TokenVerificationError("unparseable-issuer", "issuer peerId is not parseable");
  }
  return PublicKey.fromBytes(raw, SignatureAlgorithm.Ed25519);
}

// ---------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------

let warmedUp = false;

/**
 * Absorb the first authorization in this process on a throwaway key.
 *
 * Two reasons, one measured and one inherited. Measured: the first
 * `authorizeWithLimits` in a process costs ~20 ms of one-time wasm warm-up and
 * every later one costs ~0.1 ms; paying that at start-up keeps it off a real
 * request. Inherited: prototype 10's finding F2 records that in this build the
 * first call throws `{ RunLimit: 'Timeout' }` *regardless* of `max_time_micro`,
 * so a peer that skips this fails its first authorized request closed for no
 * reason. F2 did NOT reproduce here — under Node 24.8, in vitest and under
 * `tsx`, the first call succeeds in ~20 ms against `LIMITS`' 1-second budget —
 * but the failure mode is a spurious denial of a legitimate request on a
 * machine slower than this one, and the mitigation costs one key generation.
 * It stays until the defect is understood.
 *
 * Idempotent, synchronous, and never throws: `verifyToken` calls it lazily, so
 * no caller has to remember. An application may call it at start-up to move
 * the cost off its first request.
 */
export function warmUpTokens(attempts = 3): void {
  if (warmedUp) return;
  warmedUp = true;
  try {
    // A fixed, published seed: this key signs nothing but the throwaway token
    // below, which never leaves this function, so there is nothing to protect
    // and one less source of nondeterminism at start-up.
    const pair = KeyPair.fromPrivateKey(
      PrivateKey.fromBytes(new Uint8Array(32).fill(7), SignatureAlgorithm.Ed25519),
    );
    const builder = new BiscuitBuilder();
    builder.addCode("warm(true); check if time_ms($t), $t < 1;");
    // Keep the BYTES, not the parsed token: these wasm handles are consumed by
    // the call that takes them, so a retry that reused one would fail with a
    // null-pointer trap instead of retrying. Everything is rebuilt per attempt.
    const bytes = builder.build(pair.getPrivateKey()).toBase64();
    for (let i = 0; i < attempts; i++) {
      const authorizer = new AuthorizerBuilder();
      authorizer.addCode("time_ms(0); allow if warm(true);");
      try {
        authorizer
          .buildAuthenticated(Biscuit.fromBase64(bytes, pair.getPublicKey()))
          .authorizeWithLimits(LIMITS);
        return;
      } catch {
        /* the defect this function exists for; retry */
      }
    }
  } catch {
    /* warming up is best-effort — never let it break the caller */
  }
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

export interface MintTokenOptions {
  /**
   * The mesh's own signing key. `iss` and `mesh` are both set to
   * `signer.mesh` — which self-certifies, so a verifier needs nothing else.
   */
  signer: Signer;
  /** peerId of the member the token is minted for. */
  sub: string;
  roles: string[];
  /** Time-to-live from mint time, in milliseconds. */
  ttlMs: number;
  /**
   * The peers this token may be presented to (ADR-0020). Omit for a token
   * usable at every peer in the mesh — which is minted as the EXPLICIT marker
   * `audience_unrestricted(true)`, never as silence, so the two states are
   * distinguishable on the wire. See the module comment's "THE AUDIENCE".
   *
   * An EMPTY array is refused rather than quietly meaning "unrestricted", the
   * way prototype 10 read it. `audience: peers.filter(...)` collapsing to `[]`
   * would otherwise widen a token to the whole mesh at exactly the moment its
   * author meant to narrow it — a silent failure in the permissive direction,
   * which is the one this file will not make.
   */
  audience?: readonly PeerIdStr[];
  /** Injected clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Mint a signed membership token. `mesh` (and `iss`) are always derived from
 * `privateKey`'s own peerId — a hub can only ever mint tokens that
 * self-certify as its own, never forge membership in some other mesh.
 *
 * Every value that reaches the Datalog goes through `addCodeWithParameters`.
 * Interpolating a peerId or a role name into a Datalog source string would be
 * an injection seam: roles come from an application's own vocabulary and a
 * `sub` from whatever the hub was asked to admit, and neither is this file's
 * to trust. Parameters are bound as terms, so a role named `"); role("admin` is
 * a role with a silly name and nothing more.
 *
 * `async` only for source compatibility — Biscuit signs synchronously, where
 * `@libp2p/crypto`'s `sign` did not. Every call site already awaits it.
 */
export async function mintToken(options: MintTokenOptions): Promise<string> {
  const now = options.now ?? Date.now;
  const iat = now();
  const exp = iat + options.ttlMs;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) {
    // A plain Error, not a TokenVerificationError: this is the hub calling us
    // wrongly, not a token failing to verify. Silent truncation to i64 would
    // corrupt `iat`, which `revocation.ts` orders against `changedAt`.
    throw new Error(
      `mintToken: iat and exp must be safe integer milliseconds (got iat=${iat}, exp=${exp})`,
    );
  }
  // Same wasm-boundary guard as `verifyToken` — a non-string here traps rather
  // than throwing, and the trap says nothing about where it came from.
  if (typeof options.sub !== "string") {
    throw new TypeError("mintToken: sub must be a peerId string");
  }
  if (options.roles.some((role) => typeof role !== "string")) {
    throw new TypeError("mintToken: every role must be a string");
  }
  if (options.audience !== undefined) {
    if (!Array.isArray(options.audience)) {
      throw new TypeError("mintToken: audience must be an array of peerId strings");
    }
    if (options.audience.length === 0) {
      throw new Error(
        "mintToken: audience must name at least one peer -- omit it for an unrestricted token",
      );
    }
    if (options.audience.some((peer) => typeof peer !== "string")) {
      throw new TypeError("mintToken: every audience entry must be a peerId string");
    }
  }
  const mesh = options.signer.mesh;

  const builder = new BiscuitBuilder();
  builder.addCodeWithParameters(
    "mesh({mesh}); subject({sub}); bound({sub}); issued_at({iat}); expires_at({exp});",
    { mesh, sub: options.sub, iat, exp },
    {},
  );
  for (const role of options.roles) {
    builder.addCodeWithParameters("role({role});", { role }, {});
  }
  // ADR-0009: the token is usable only over a connection that proved its
  // subject. Stated as a check in the AUTHORITY block, where a later appended
  // block's facts are invisible to it — see the module comment.
  builder.addCode("check if bound($k), connection_peer($k);");
  // Self-certification: the mesh this token names must be the mesh whose key
  // just verified it. The signature already proves the signer holds that key;
  // this catches a hub that signed a token naming somebody else's mesh.
  builder.addCode("check if mesh($m), root_mesh($m);");
  // ADR-0020: the audience, and it is ALWAYS stated — see "THE AUDIENCE" and
  // "UNRESTRICTED IS A STATE, NOT A SILENCE" in the module comment. Both
  // branches are a fact plus a check in the AUTHORITY block, so a later block
  // can neither see them nor widen them, and `self_peer` is asserted by the
  // DESTINATION, which is what makes the destination the one that enforces.
  if (options.audience !== undefined) {
    for (const peer of options.audience) {
      builder.addCodeWithParameters("audience({peer});", { peer }, {});
    }
    builder.addCode("check if audience($k), self_peer($k);");
  } else {
    // Biscuit predicates take at least one term, so the marker carries one:
    // `audience_unrestricted()` is a parse error (prototype 10, finding F5).
    builder.addCode("audience_unrestricted(true);");
    builder.addCode("check if audience_unrestricted(true);");
  }
  // Expiry, against the verifier's clock. The bound is INLINED rather than
  // read from `expires_at($e)`: a check is existential, so a rule that read the
  // fact would be satisfiable by any later `expires_at` a block cared to add.
  builder.addCodeWithParameters("check if time_ms($t), $t < {exp};", { exp }, {});

  return builder.build(signingKeyFor(options.signer.seed)).toBase64();
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifyTokenOptions {
  /** The mesh (hub peerId) this verifier expects the token to belong to. */
  issuer: string;
  /**
   * The peer the TRANSPORT proved is on the other end of this connection —
   * never anything the caller claimed, and never anything read out of the
   * token. Asserted as `connection_peer`, which is what the token's own
   * binding check consumes (ADR-0009).
   *
   * Required, not optional with a permissive default: a caller that has no
   * proven peer has `ANONYMOUS`, which asserts no `connection_peer` at all and
   * therefore fails the binding — deny by default, expressed in the type.
   */
  connectionPeer: PeerIdStr | Anonymous;
  /**
   * THIS verifier's own peerId, asserted as `self_peer` — the destination's
   * statement about its own identity, which an audience-scoped token's check
   * is evaluated against (ADR-0020). It is asserted by the node and never read
   * from the token, exactly like `connectionPeer`.
   *
   * Optional, unlike `connectionPeer`, and omitting it fails CLOSED rather
   * than open: a verifier that does not say who it is satisfies no `audience`
   * fact, so it refuses every audience-scoped token and accepts unrestricted
   * ones unchanged. That is the safe direction, and it is what lets a caller
   * written before this option existed keep working — at the cost that a peer
   * which simply FORGOT to pass it refuses legitimate scoped tokens. That is a
   * loud, uniform failure rather than a quiet permissive one.
   */
  selfPeer?: PeerIdStr;
  /** Injected clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Verify a Biscuit membership token and return the claims its authority block carries. */
export async function verifyToken(token: string, options: VerifyTokenOptions): Promise<MeshClaims> {
  warmUpTokens();
  // Guard the wasm boundary before anything reaches it. `addCodeWithParameters`
  // given a value it has no term type for does not throw — it traps, and a wasm
  // `RuntimeError: unreachable` surfaces from deep inside the binding shim with
  // no indication of which caller was wrong. A `connectionPeer` of `undefined`
  // (a caller on an untyped path, or one written before this argument existed)
  // is the way that happens in practice, so it is named here instead.
  if (typeof token !== "string") {
    throw new TokenVerificationError("malformed-token", "token must be a string");
  }
  if (options.connectionPeer !== ANONYMOUS && typeof options.connectionPeer !== "string") {
    throw new TypeError(
      "verifyToken: connectionPeer must be the transport-proven peerId, or ANONYMOUS for none",
    );
  }
  if (options.selfPeer !== undefined && typeof options.selfPeer !== "string") {
    throw new TypeError("verifyToken: selfPeer must be this peer's own peerId string");
  }
  const root = rootKeyFor(options.issuer);

  let parsed: Biscuit;
  try {
    parsed = Biscuit.fromBase64(token, root);
  } catch (error) {
    throw parseFailure(error);
  }

  const now = options.now ?? Date.now;
  const builder = new AuthorizerBuilder();
  builder.addCodeWithParameters(
    "root_mesh({mesh}); time_ms({now});",
    { mesh: options.issuer, now: now() },
    {},
  );
  if (options.connectionPeer !== ANONYMOUS) {
    builder.addCodeWithParameters("connection_peer({peer});", { peer: options.connectionPeer }, {});
  }
  // The destination's statement about itself, which the token's audience check
  // consumes (ADR-0020). Omitted, nothing satisfies `audience($k), self_peer($k)`.
  if (options.selfPeer !== undefined) {
    builder.addCodeWithParameters("self_peer({peer});", { peer: options.selfPeer }, {});
  }
  // This verifier contributes no policy of its own — the token's checks are the
  // whole decision. Task 30 replaces this with the access tree as Datalog.
  builder.addCode("allow if true;");

  const authorizer = builder.buildAuthenticated(parsed);
  try {
    authorizer.authorizeWithLimits(LIMITS);
  } catch (error) {
    throw denial(error);
  }

  return readClaims(authorizer, options.issuer);
}

/**
 * Read the claims back out of the authority block.
 *
 * Queries run through the AUTHORIZER, which by Biscuit's scoping sees authority
 * and authorizer facts only — so an appended block cannot inject a role or
 * rewrite a subject, and this verifier asserts none of these predicates itself.
 * Each is required and must be unique: two `subject` facts is a hub bug, and
 * picking one arbitrarily would be picking a subject arbitrarily.
 */
function readClaims(
  authorizer: ReturnType<AuthorizerBuilder["buildAuthenticated"]>,
  issuer: string,
): MeshClaims {
  const mesh = one(queryTerms(authorizer, "mesh"), "mesh");
  const sub = one(queryTerms(authorizer, "subject"), "subject");
  const iat = one(queryTerms(authorizer, "issued_at"), "issued_at");
  const exp = one(queryTerms(authorizer, "expires_at"), "expires_at");

  if (typeof mesh !== "string" || typeof sub !== "string") {
    throw new TokenVerificationError("malformed-claims", "mesh and subject must be strings");
  }
  if (typeof iat !== "number" || typeof exp !== "number") {
    throw new TokenVerificationError(
      "malformed-claims",
      "issued_at and expires_at must be integers",
    );
  }
  // `check if mesh($m), root_mesh($m)` already proved this; asserting it here
  // too is the belt to that braces, and costs a string compare.
  if (mesh !== issuer) {
    throw new TokenVerificationError("mesh-mismatch", "mesh does not match issuer");
  }

  // Datalog facts are a SET: `role("a"); role("a")` is one fact and the order
  // they were minted in is not recoverable. Sorted so the claim is at least
  // deterministic. Nothing in this package treats roles as ordered —
  // `rules.ts` derives a capability set from them.
  const roles = queryTerms(authorizer, "role")
    .filter((term): term is string => typeof term === "string")
    .sort();

  return { sub, iss: issuer, mesh, roles, iat, exp, audience: readAudience(authorizer) };
}

/**
 * Which of the three audience states (ADR-0020) the authority block is in.
 *
 * Read through the same authorizer as everything else, so an appended block's
 * `audience` fact is invisible here exactly as it is to the check that
 * enforces it. Carrying BOTH families is a hub bug and is refused rather than
 * resolved: the two carry different checks, so guessing which one describes
 * the token would be reporting an audience this function cannot know.
 */
function readAudience(
  authorizer: ReturnType<AuthorizerBuilder["buildAuthenticated"]>,
): MeshClaims["audience"] {
  const named = queryTerms(authorizer, "audience")
    .filter((term): term is string => typeof term === "string")
    .sort();
  const unrestricted = queryTerms(authorizer, "audience_unrestricted").length > 0;
  if (named.length > 0 && unrestricted) {
    throw new TokenVerificationError(
      "malformed-claims",
      "the authority block states both an audience and audience_unrestricted",
    );
  }
  if (named.length > 0) return named;
  return unrestricted ? "unrestricted" : "unstated";
}

/** Every first term of `<predicate>($x)`, as JS values. */
function queryTerms(
  authorizer: ReturnType<AuthorizerBuilder["buildAuthenticated"]>,
  predicate: string,
): unknown[] {
  const facts = authorizer.queryWithLimits(
    Rule.fromString(`claim($x) <- ${predicate}($x)`),
    LIMITS,
  );
  return facts.map((fact: { terms(): unknown[] }) => fact.terms()[0]);
}

function one(values: unknown[], predicate: string): unknown {
  if (values.length !== 1) {
    throw new TokenVerificationError(
      "malformed-claims",
      `the authority block must carry exactly one ${predicate} fact, found ${values.length}`,
    );
  }
  return values[0];
}

/** `Biscuit.fromBase64` failed: bad bytes, or bytes that are not ours. */
function parseFailure(error: unknown): TokenVerificationError {
  if (hasKey(error, "Format") && hasKey(error.Format, "Signature")) {
    return new TokenVerificationError(
      "signature",
      "token signature does not verify against this mesh's key",
    );
  }
  return new TokenVerificationError("malformed-token", "malformed token");
}

/**
 * `authorizeWithLimits` failed. Map the failing check back to a reason by the
 * predicate it names — the four checks `mintToken` writes are the four
 * outcomes a well-formed token can fail on, and anything else is a constraint
 * this verifier does not know how to satisfy, which denies (A-20).
 */
function denial(error: unknown): TokenVerificationError {
  if (hasKey(error, "RunLimit")) {
    return new TokenVerificationError(
      "evaluation-budget",
      `evaluation budget exhausted (${String(error.RunLimit)})`,
    );
  }
  const checks = failedChecks(error);
  const joined = checks.join(" ");
  if (joined.includes("connection_peer")) {
    return new TokenVerificationError(
      "peer-binding",
      "token subject does not match connected peer",
      checks,
    );
  }
  // ADR-0020. Matched on `audience`, which appears in the rule text of BOTH
  // branches (`audience($k), self_peer($k)` and `audience_unrestricted(true)`),
  // so a hand-built token carrying the marker check without its fact reports
  // the same reason rather than falling through to the generic one. Ordered
  // after `connection_peer`: a token failing binding AND audience at once is
  // reported as a binding failure, because that is the one the caller can act
  // on first (present it over the right connection, then find the right peer).
  if (joined.includes("audience")) {
    return new TokenVerificationError(
      "audience",
      "this peer is not an intended audience for this token",
      checks,
    );
  }
  if (joined.includes("time_ms")) {
    return new TokenVerificationError("expired", "token expired", checks);
  }
  if (joined.includes("root_mesh")) {
    return new TokenVerificationError("mesh-mismatch", "mesh does not match issuer", checks);
  }
  return new TokenVerificationError(
    "unsatisfied-constraint",
    checks.length > 0 ? `unsatisfied constraint: ${joined}` : "no policy matched",
    checks,
  );
}

/** Pull `block_id` / `check_id` / `rule` out of Biscuit's structured failure (spec P8). */
function failedChecks(error: unknown): string[] {
  if (!hasKey(error, "FailedLogic")) return [];
  const failed = error.FailedLogic;
  if (!hasKey(failed, "Unauthorized")) return [];
  const checks = (failed.Unauthorized as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return [];
  return checks.map((check: unknown) => {
    if (hasKey(check, "Block")) {
      const block = check.Block as { block_id: number; check_id: number; rule: string };
      return `block ${block.block_id} check ${block.check_id}: ${block.rule}`;
    }
    if (hasKey(check, "Authorizer")) {
      const auth = check.Authorizer as { check_id: number; rule: string };
      return `authorizer check ${auth.check_id}: ${auth.rule}`;
    }
    return JSON.stringify(check);
  });
}

function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

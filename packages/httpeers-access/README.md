# @statewalker/httpeers-access

Who is calling, and may they. Biscuit tokens, Datalog policy, revocation, and
**one** middleware.

```ts
import { ruleSet, withAccess, access } from "@statewalker/httpeers-access";

const guarded = withAccess({
  issuer: hubPeerId,          // the mesh — and its own verifying key
  rules: ruleSet({ /* … */ }),
  provenPeer: (req) => whatTheTransportProved(req),
})(myHandler);
```

## No libp2p, and that is the point

Verifying a token used to require `@libp2p/peer-id` and `@libp2p/crypto` — a
transport stack, pulled in by anything that merely wanted to check a bearer
token. It needed them for one thing: turning a hub's peerId into a verifying
key.

**An Ed25519 peerId carries its own public key.** The string is base58btc of an
*identity* multihash — the digest is the value, not a hash of it — wrapping a
protobuf `PublicKey`. Recovering the key is parsing, so `selfCertifyingKeys()`
does it in about twenty lines with `multiformats`, and
`tests/self-certifying.test.ts` checks it against libp2p's own answer over real
generated peers, byte for byte, in both directions.

Not every peerId works this way: an RSA peerId *hashes* its key, so there is
nothing to recover and `resolve` returns empty. Empty means **deny**.

## Three entry points, and why

| Import | For | Holds |
|---|---|---|
| `.` | a **member** | `withAccess`, `verifyToken`, the rule set, `RevocationCache` |
| `./issuer` | a **hub** | `mintToken`, `generateSigner`, `RevocationRegistry` |
| `./engine` | almost nobody | `initBiscuit`, the WASM loader seam |

The split is enforced by the import graph, not by documentation: a member that
imports the root never pulls a code path that signs into its bundle.

## One middleware, not two

The prototype ships binding and policy separately and needs the caller to nest
them correctly, with the reason in a comment three files away:

> *"Reverse the nesting and policy reads an empty cache: every request would
> look tokenless to the authorizer, no matter what it actually carried."*

A correctness requirement enforced nowhere, violated by writing two calls in
the natural reading order. `withAccess` removes the choice rather than
documenting it better — it takes no ordering parameter, because there is
nothing to order. Inside, the composition is exactly the proven one.

## There is no `DEFAULT_RULES`

The prototype exported one. It derived `std:` capabilities for the demo's
`/test` mount and **no `app:` capability at all**, so every caller who reached
for it as a starting point mounted an application under it and got a permanent
silent denial. A default that is wrong for every real use is worse than none,
because it is reached for first. `rules` is a parameter.

## What is DESIGNED and not implemented

`cnf` per-device binding (ADR-0009), key rotation and the issuer directory
(ADR-0008/0018), and delegation (ADR-0010). Extracting is not implementing, so
none of them ships here, and conformance A-13, A-13b, A-21 and A-23 stay
reported as **missing** rather than quietly skipped.

`verifyToken` takes `operation` and `resource` so attenuation checks become
*possible* without delegation, and `keys` so rotation has a seam to arrive
through — every acceptable key is tried, which with the default resolver is
exactly one and the prototype's behaviour unchanged.

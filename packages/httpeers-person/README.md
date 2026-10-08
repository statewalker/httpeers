# @statewalker/httpeers-person

## What it is

The pure parts of person identity on an httpeers mesh: a **person key** (an Ed25519 key pair
that names a human and is copied between their devices), the **statements** that key signs
(binding a device to the person, merging two people, asking for a device invite, the person's
profile), and the **link code** two devices show while one hands its identity to the other. It
does no I/O and has no dependencies; the hub and the member call it.

## Why a person is a key, and a device is not

A device's peer key proves "this connection is this device". A person needs more: the same
identity on a laptop and a phone, revocable as a whole. So the person key signs each of the
person's devices (`DeviceConfirmation`), and anyone holding the person's public key can check
that binding without asking the hub.

## How to use

```sh
pnpm add @statewalker/httpeers-person
```

One entry point. It needs WebCrypto with Ed25519: Node 22+, current browsers, workers.

## Examples

```ts
import {
  checkReveal, commitment, generatePersonKey, linkCode, newNonce, signStatement, verifyStatement,
} from "@statewalker/httpeers-person";

const hubPeerId = "12D3KooW…"; // the hub's peer id: the group the statements belong to
const peerId = "12D3KooW…"; // this device's peer id
const keeper = "12D3KooW…"; // peer id of the device that already holds the identity
const mover = "12D3KooW…"; // peer id of the device receiving it

const person = await generatePersonKey();
const signed = await signStatement(
  { tag: "sandclaw/device-confirmation/v1", peerId, mesh: hubPeerId, issuedAt: new Date().toISOString() },
  person,
);
const result = await verifyStatement(signed, {
  tag: "sandclaw/device-confirmation/v1", mesh: hubPeerId, now: new Date(),
});
if (!result.ok) console.warn(result.reason); // "bad-signature", "clock-skew", …

// Link: the mover commits first, the keeper answers, the mover reveals.
const moverNonce = newNonce();
const committed = await commitment(moverNonce);   // mover → keeper
const keeperNonce = newNonce();                   // keeper → mover
await checkReveal(committed, moverNonce);         // keeper checks the reveal
await linkCode({ mesh: hubPeerId, keeper, mover, keeperNonce, moverNonce }); // "482 193" on both screens
```

## Internals

- **Signed bytes.** A statement is a flat record of strings. It is signed over its canonical
  JSON: keys sorted, values NFC-normalized, no whitespace. Re-serializing it in another key
  order, or typing a name with another Unicode composition, still verifies. A field the
  statement kind does not have makes it `malformed`, rather than being ignored.
- **Verification never throws on wire input.** `verifyStatement` returns a reason instead;
  anything that is not a well-formed statement of a known kind (including a tag such as
  `constructor`) is `malformed`. Only a bad argument from the caller throws: `expect.now` that
  is an invalid `Date` is a `TypeError`.
- **Why a verification fails.** `verifyStatement` returns `{ ok: false, reason }`, checked in
  this order:
  - `malformed`: not a record of the kind's exact string fields, a time that is not strict
    ISO-8601, or a signature or signer that is not in canonical form.
  - `wrong-tag`: a well-formed statement of another kind than `expect.tag`.
  - `bad-signature`: the signature does not match the statement and the signer.
  - `wrong-signer`: valid signature, but by the wrong person: a merge must be signed by its
    `from`, an invite request by its `personId`. Without this, anyone could sign a statement
    in another person's name.
  - `wrong-mesh`: the statement is for another group, or `expect.mesh` is missing.
  - `clock-skew`: the statement's time is more than 5 minutes from `expect.now`.
- **`mesh` is required for kinds that carry one.** Confirmations, merges and invite requests
  name a group, so `expect.mesh` is required by the type and a missing one is `wrong-mesh` at
  runtime: a check that forgot the group fails instead of passing. Profiles have no group and
  take none.
- **`now` is a choice, never a default.** Pass `now: new Date()` when accepting a fresh
  statement from the network: it must be within ±5 minutes. Pass `now: null` when re-checking
  a statement stored earlier (a cached profile, one received during a link): it skips only the
  clock check; the signature, signer and group are still checked.
- **Times are strict.** A statement's time must be ISO-8601 UTC with a `Z`, as
  `new Date().toISOString()` writes it (`2026-10-08T10:00:00.000Z`, fractions optional).
  Zone-less and offset forms are `malformed`, because `Date.parse` would read them in the
  verifier's local zone.
- **Canonical encodings only.** A signature must decode to exactly 64 bytes and re-encode to
  the same string, so spare trailing bits cannot give one signature several spellings.
- **Signing checks the shape.** `signStatement` throws a `TypeError` for a statement with
  fields other than its kind's, or a field that is not a string, rather than producing a
  signature that every verifier would call `malformed`.
- **Domain tags.** Every statement and every hash input starts with a tag
  (`sandclaw/device-confirmation/v1`, …), so a signature or a digest made for one purpose
  cannot be replayed as another.
- **Time.** Statements carry their own time. A device with a wrong clock sees `clock-skew`,
  not `bad-signature`.
- **Canonical person ids only.** A person id is accepted only in its canonical form:
  `publicKeyOf` re-encodes the decoded key and compares, because base64url decoding ignores
  spare trailing bits and several strings would otherwise name one key.
  `importPersonKey` throws on bytes that are not an Ed25519 private key.
- **Why commit, then reveal.** If each screen derived the code from the two peer ids alone, an
  attacker in the middle could generate peer keys until one matched: six digits is about a
  million tries, which takes seconds. The mover commits to its nonce before it sees the
  keeper's, so the code cannot be steered.
- **Nonces are checked, not trusted.** `commitment` and `linkCode` throw a `RangeError` unless
  every nonce is 32 bytes of base64url, because a junk nonce would make the code predictable.
  `checkReveal` never throws; it returns `false`.
- **Hashing.** Hash inputs are length-prefixed (a 4-byte big-endian length before each field),
  so `("ab","c")` and `("a","bc")` never collide.
- **Key material.** A person key's private part is extractable on purpose, because it has to
  move between devices. Protecting it at rest is the caller's job.
- **Dependencies:** none. WebCrypto, `TextEncoder` and `atob`/`btoa` are platform globals.

## License

MIT

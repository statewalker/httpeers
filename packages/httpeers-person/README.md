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
  generatePersonKey, signStatement, verifyStatement, newNonce, commitment, checkReveal, linkCode,
} from "@statewalker/httpeers-person";

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
- **Verification never throws.** `verifyStatement` returns a reason instead; anything that is
  not a well-formed statement of a known kind (including a tag such as `constructor`) is
  `malformed`.
- **Domain tags.** Every statement and every hash input starts with a tag
  (`sandclaw/device-confirmation/v1`, …), so a signature or a digest made for one purpose
  cannot be replayed as another.
- **Time.** Statements carry their own time; `verifyStatement` accepts ±5 minutes around `now`.
  A device with a wrong clock sees `clock-skew`, not `bad-signature`.
- **Canonical person ids only.** A person id is accepted only in its canonical form:
  `publicKeyOf` re-encodes the decoded key and compares, because base64url decoding ignores
  spare trailing bits and several strings would otherwise name one key.
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

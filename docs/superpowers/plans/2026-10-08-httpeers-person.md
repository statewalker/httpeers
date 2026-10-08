# httpeers-person Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new isomorphic package, `@statewalker/httpeers-person`, holding the pure parts of the person-identity protocol: person keys, the signed statements (device confirmation, merge, device-invite request, profile), and the link code with its commit-then-reveal nonces.

**Architecture:** Zero runtime dependencies. Ed25519 comes from WebCrypto (`crypto.subtle`), as in `httpeers-access/src/signer.ts`. A statement is a flat record of strings with a domain `tag`, signed over its canonical JSON (sorted keys, NFC-normalized values). Hashes for the link code are SHA-256 over length-prefixed fields. Nothing here does I/O: the hub (plan 2) and the member (plan 3) call these functions.

**Tech Stack:** TypeScript (ES2022 lib, no DOM), WebCrypto Ed25519 and SHA-256, vitest in Node, `tsc` build, Biome.

**Spec:** `~/workspace-statewalker/notes/2026/2026-10/2026-10-07/sandclaw-device-enrollment-protocol.md`, sections "Actors and keys", "Signed statements" and "The link operation" steps 1–3. Design record: `~/workspace-statewalker/notes/2026/2026-10/2026-10-07/grill-module-group-core.md` (Q2–Q2d).

## Global Constraints

- Package name `@statewalker/httpeers-person`, directory `packages/httpeers-person`, isomorphic: no `node:` imports in `src/`, no DOM lib, no runtime dependencies.
- Ed25519 only; keys and signatures through `crypto.subtle`.
- A person id is the base64url (no padding) encoding of the 32-byte raw Ed25519 public key.
- Domain tags, exactly:
  - `sandclaw/device-confirmation/v1`
  - `sandclaw/person-merge/v1`
  - `sandclaw/device-invite-request/v1`
  - `sandclaw/profile/v1`
  - `sandclaw/link-commit/v1`
  - `sandclaw/link-code/v1`
- Clock tolerance: a statement's time must be within ±5 minutes (300 000 ms) of the verifier's clock. Exactly 5 minutes is accepted.
- The link code is 6 decimal digits shown as `"ddd ddd"` (leading zeros kept), taken from SHA-256 of `"sandclaw/link-code/v1" ‖ mesh ‖ keeper ‖ mover ‖ nₖ ‖ nₘ`. Including `mesh` keeps a code from ever repeating across groups.
- Nonces are 32 random bytes.
- Verification never throws on bad input. It returns `{ ok: false, reason }`.
- Every package script and file layout follows `packages/httpeers-core`: `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, tests in `tests/`, README in the repository's README shape.

## Review Focus

1. **Key order and extra fields.** A statement re-serialized with its keys in another order must still verify. A statement with a field the type does not have must be refused as `malformed`; it must not be silently ignored. → Task 3, tests "verifies whatever the key order" and "refuses unknown fields".
2. **Unicode names.** "Inès" typed as a composed `è` on one device and as `e` + combining grave on another must produce the same signed bytes. → Task 3, test "NFC-normalizes values before signing".
3. **The clock-skew boundary.** Exactly ±5 minutes is accepted; 5 minutes + 1 ms is refused as `clock-skew`, in both directions. → Task 3, test "accepts exactly 5 minutes, refuses one millisecond more".
4. **Garbage from the wire.** A truncated signature, a non-base64url id, a 31-byte key, or a missing field returns `{ ok: false, reason: "malformed" }`; it never throws. → Task 3, test "never throws on garbage"; Task 2, test "rejects ids that are not 32-byte keys".
5. **Leading zeros in the code.** A digest whose first 6 digits start with 0 must show as `"004 193"`, not `"4 193"`. → Task 4, test "keeps leading zeros".

---

## File Structure

```
packages/httpeers-person/
  package.json            name, exports, scripts (copied from httpeers-core)
  tsconfig.json           ES2022, types: node, noEmit
  tsconfig.build.json     emit to dist/
  vitest.config.ts        environment: node
  README.md               package README (Task 5)
  src/
    index.ts              public exports
    encoding.ts           base64url, utf8, length-prefixed concat, canonical JSON
    keys.ts               PersonKey: generate, id, export/import (PKCS#8), public key of an id
    statements.ts         statement types, signStatement, verifyStatement
    link-code.ts          newNonce, commitment, checkReveal, linkCode
  tests/
    encoding.test.ts
    keys.test.ts
    statements.test.ts
    link-code.test.ts
    boundary.test.ts      no node: imports, no dependencies (Task 5)
```

Files that change elsewhere: the root `README.md` (the libraries table), `.changeset/` (a new changeset).

---

### Task 1: Package scaffold and encoding helpers

**Files:**
- Create: `packages/httpeers-person/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`
- Create: `packages/httpeers-person/src/encoding.ts`, `src/index.ts`
- Test: `packages/httpeers-person/tests/encoding.test.ts`

**Interfaces:**
- Produces:
  - `toBase64Url(bytes: Uint8Array): string`
  - `fromBase64Url(text: string): Uint8Array | undefined` (undefined on any invalid input)
  - `utf8(text: string): Uint8Array`
  - `lengthPrefixed(parts: readonly (string | Uint8Array)[]): Uint8Array`: each part is a 4-byte big-endian length followed by its bytes; strings are UTF-8
  - `canonicalJson(record: Readonly<Record<string, string>>): string`: keys sorted by code unit, values NFC-normalized, `JSON.stringify` with no spaces

- [ ] **Step 1: Create the package files**

`packages/httpeers-person/package.json`:

```json
{
  "name": "@statewalker/httpeers-person",
  "version": "0.0.0",
  "type": "module",
  "description": "Person keys, signed statements and the link code of the httpeers person-identity protocol. Isomorphic: WebCrypto only, no dependencies.",
  "bugs": { "url": "https://github.com/statewalker/httpeers/issues" },
  "homepage": "https://github.com/statewalker/httpeers/tree/main/packages/httpeers-person#readme",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/statewalker/httpeers.git",
    "directory": "packages/httpeers-person"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "source": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist", "src"],
  "sideEffects": false,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "pnpm run build && pnpm run typecheck && vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src tests",
    "lint:check": "biome check src tests"
  },
  "dependencies": {},
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "publishConfig": { "access": "public" }
}
```

`packages/httpeers-person/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // ES2022 and deliberately not "DOM", as in httpeers-core: the package must run in
    // workers and Node. WebCrypto, TextEncoder, atob/btoa come from @types/node.
    "lib": ["ES2022"],
    "types": ["node"],
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`packages/httpeers-person/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*.ts"]
}
```

`packages/httpeers-person/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: the package claims to need no DOM, so it is tested without one.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

Run: `cd ~/sw-migration/work/httpeers && pnpm install`
Expected: the new workspace package is linked; no errors.

- [ ] **Step 2: Write the failing test**

`packages/httpeers-person/tests/encoding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  fromBase64Url,
  lengthPrefixed,
  toBase64Url,
  utf8,
} from "../src/encoding.js";

describe("base64url", () => {
  it("round-trips every byte value without padding", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it("returns undefined for text that is not base64url", () => {
    expect(fromBase64Url("abc+")).toBeUndefined();
    expect(fromBase64Url("a")).toBeUndefined(); // a length of 1 mod 4 is never valid
    expect(fromBase64Url("é")).toBeUndefined();
  });
});

describe("lengthPrefixed", () => {
  it("prefixes each part with its 4-byte big-endian length", () => {
    expect(lengthPrefixed(["ab", Uint8Array.of(7)])).toEqual(
      Uint8Array.of(0, 0, 0, 2, 0x61, 0x62, 0, 0, 0, 1, 7),
    );
  });

  it("keeps ['ab','c'] and ['a','bc'] apart", () => {
    expect(lengthPrefixed(["ab", "c"])).not.toEqual(lengthPrefixed(["a", "bc"]));
  });
});

describe("canonicalJson", () => {
  it("sorts keys, so key order does not change the bytes", () => {
    expect(canonicalJson({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
    expect(canonicalJson({ a: "1", b: "2" })).toBe(canonicalJson({ b: "2", a: "1" }));
  });

  it("NFC-normalizes values", () => {
    const composed = "Inès";
    const decomposed = "Inès";
    expect(canonicalJson({ name: decomposed })).toBe(canonicalJson({ name: composed }));
    expect(utf8(canonicalJson({ name: decomposed }))).toEqual(utf8(`{"name":"${composed}"}`));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run tests/encoding.test.ts`
Expected: FAIL: `Failed to load url ../src/encoding.js`.

- [ ] **Step 4: Write the implementation**

`packages/httpeers-person/src/encoding.ts`:

```ts
/**
 * Byte and text helpers shared by keys, statements and the link code.
 * No dependencies: atob/btoa and TextEncoder are WinterCG globals.
 */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url string, or `undefined` when it is not one. Never throws. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Each part as a 4-byte big-endian length followed by its bytes. Hashing a
 * plain concatenation would let ("ab","c") and ("a","bc") collide.
 */
export function lengthPrefixed(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? utf8(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const chunk of chunks) {
    view.setUint32(at, chunk.length);
    out.set(chunk, at + 4);
    at += 4 + chunk.length;
  }
  return out;
}

/**
 * The one byte form a statement is signed in: keys sorted by code unit, values
 * NFC-normalized, no whitespace. Two devices that type the same name with
 * different Unicode compositions sign the same bytes.
 */
export function canonicalJson(record: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = (record[key] ?? "").normalize("NFC");
  return JSON.stringify(sorted);
}
```

`packages/httpeers-person/src/index.ts`:

```ts
export { canonicalJson, fromBase64Url, lengthPrefixed, toBase64Url, utf8 } from "./encoding.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run && npx tsc --noEmit`
Expected: PASS (6 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
cd ~/sw-migration/work/httpeers
git add packages/httpeers-person pnpm-lock.yaml
git commit -m "feat(httpeers-person): package scaffold and encoding helpers"
```

---

### Task 2: Person keys

**Files:**
- Create: `packages/httpeers-person/src/keys.ts`
- Modify: `packages/httpeers-person/src/index.ts`
- Test: `packages/httpeers-person/tests/keys.test.ts`

**Interfaces:**
- Consumes: `toBase64Url`, `fromBase64Url` (Task 1).
- Produces:
  - `type PersonId = string`: base64url of the raw 32-byte public key
  - `interface PersonKey { readonly id: PersonId; readonly publicKey: Uint8Array; readonly privateKey: CryptoKey }`
  - `generatePersonKey(): Promise<PersonKey>`: the private key is extractable, because it must be copied to the person's other devices
  - `exportPersonKey(key: PersonKey): Promise<Uint8Array>`: PKCS#8 bytes
  - `importPersonKey(pkcs8: Uint8Array): Promise<PersonKey>`
  - `publicKeyOf(id: PersonId): Uint8Array | undefined`: the 32 key bytes, or undefined when `id` is not a 32-byte key
  - `verifyingKeyOf(id: PersonId): Promise<CryptoKey | undefined>`

- [ ] **Step 1: Write the failing test**

`packages/httpeers-person/tests/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  exportPersonKey,
  generatePersonKey,
  importPersonKey,
  publicKeyOf,
  verifyingKeyOf,
} from "../src/keys.js";

describe("person keys", () => {
  it("names a person by their public key", async () => {
    const key = await generatePersonKey();
    expect(key.publicKey).toHaveLength(32);
    expect(publicKeyOf(key.id)).toEqual(key.publicKey);
  });

  it("survives export and import, the way it moves to another device", async () => {
    const key = await generatePersonKey();
    const copy = await importPersonKey(await exportPersonKey(key));
    expect(copy.id).toBe(key.id);
    const data = new TextEncoder().encode("hello");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, copy.privateKey, data);
    const verifier = await verifyingKeyOf(key.id);
    expect(verifier).toBeDefined();
    expect(await crypto.subtle.verify({ name: "Ed25519" }, verifier!, sig, data)).toBe(true);
  });

  it("rejects ids that are not 32-byte keys", async () => {
    const short = (await generatePersonKey()).id.slice(0, -2);
    expect(publicKeyOf(short)).toBeUndefined();
    expect(publicKeyOf("not base64url!")).toBeUndefined();
    expect(await verifyingKeyOf("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run tests/keys.test.ts`
Expected: FAIL: `Failed to load url ../src/keys.js`.

- [ ] **Step 3: Write the implementation**

`packages/httpeers-person/src/keys.ts`:

```ts
/**
 * A person key is the person's identity in a group. Unlike a device's peer
 * key, it is copied from device to device, so its private part is extractable
 * by design. Protecting it at rest is the caller's job (the browser's storage,
 * an optional password).
 */
import { fromBase64Url, toBase64Url } from "./encoding.js";

/** Base64url (no padding) of the raw 32-byte Ed25519 public key. */
export type PersonId = string;

export interface PersonKey {
  readonly id: PersonId;
  readonly publicKey: Uint8Array;
  readonly privateKey: CryptoKey;
}

// The DOM lib declares CryptoKeyPair; this package does not load the DOM lib.
interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const ED25519 = { name: "Ed25519" } as const;
const KEY_BYTES = 32;

export async function generatePersonKey(): Promise<PersonKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as KeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { id: toBase64Url(publicKey), publicKey, privateKey: pair.privateKey };
}

/** PKCS#8 bytes of the private key: what travels to a new device. */
export async function exportPersonKey(key: PersonKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
}

export async function importPersonKey(pkcs8: Uint8Array): Promise<PersonKey> {
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, ED25519, true, ["sign"]);
  // WebCrypto has no "public key of this private key" call; the JWK export carries it as `x`.
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = jwk.x ? fromBase64Url(jwk.x) : undefined;
  if (!publicKey || publicKey.length !== KEY_BYTES) throw new Error("not an Ed25519 private key");
  return { id: toBase64Url(publicKey), publicKey, privateKey };
}

export function publicKeyOf(id: PersonId): Uint8Array | undefined {
  const bytes = fromBase64Url(id);
  return bytes && bytes.length === KEY_BYTES ? bytes : undefined;
}

export async function verifyingKeyOf(id: PersonId): Promise<CryptoKey | undefined> {
  const raw = publicKeyOf(id);
  if (!raw) return undefined;
  return crypto.subtle.importKey("raw", raw, ED25519, true, ["verify"]);
}
```

Append to `packages/httpeers-person/src/index.ts`:

```ts
export {
  exportPersonKey,
  generatePersonKey,
  importPersonKey,
  type PersonId,
  type PersonKey,
  publicKeyOf,
  verifyingKeyOf,
} from "./keys.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run && npx tsc --noEmit`
Expected: PASS (9 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
cd ~/sw-migration/work/httpeers
git add packages/httpeers-person
git commit -m "feat(httpeers-person): person keys (generate, export, import, verify by id)"
```

---

### Task 3: Signed statements

**Files:**
- Create: `packages/httpeers-person/src/statements.ts`
- Modify: `packages/httpeers-person/src/index.ts`
- Test: `packages/httpeers-person/tests/statements.test.ts`

**Interfaces:**
- Consumes: `canonicalJson`, `utf8`, `toBase64Url`, `fromBase64Url` (Task 1); `PersonKey`, `PersonId`, `verifyingKeyOf` (Task 2).
- Produces:
  - Statement types; every field is a string, and times are ISO-8601 UTC:
    - `DeviceConfirmation = { tag: "sandclaw/device-confirmation/v1"; peerId; mesh; issuedAt }`
    - `MergeStatement = { tag: "sandclaw/person-merge/v1"; from: PersonId; into: PersonId; mesh; at }`
    - `DeviceInviteRequest = { tag: "sandclaw/device-invite-request/v1"; mesh; requester; personId: PersonId; at }`
    - `Profile = { tag: "sandclaw/profile/v1"; name; updatedAt }`
    - `type Statement = DeviceConfirmation | MergeStatement | DeviceInviteRequest | Profile`
  - `interface Signed<T extends Statement> { statement: T; signer: PersonId; signature: string }` (signature is base64url)
  - `signStatement<T extends Statement>(statement: T, key: PersonKey): Promise<Signed<T>>`
  - `type VerifyFailure = "malformed" | "wrong-tag" | "bad-signature" | "wrong-mesh" | "clock-skew"`
  - `verifyStatement<T extends Statement>(signed: unknown, expect: { tag: T["tag"]; mesh?: string; now: Date }): Promise<{ ok: true; signed: Signed<T> } | { ok: false; reason: VerifyFailure }>`
    - `mesh` is checked for every statement that has a `mesh` field. Profiles have none, so the check is skipped for them.
    - `now` is compared with the statement's time field (`issuedAt`, `at` or `updatedAt`), within ±300 000 ms.

- [ ] **Step 1: Write the failing test**

`packages/httpeers-person/tests/statements.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generatePersonKey } from "../src/keys.js";
import {
  type DeviceConfirmation,
  type Profile,
  signStatement,
  verifyStatement,
} from "../src/statements.js";

const MESH = "12D3KooWHubPeerIdForTests";
const NOW = new Date("2026-10-08T10:00:00.000Z");

function confirmation(at = NOW): DeviceConfirmation {
  return {
    tag: "sandclaw/device-confirmation/v1",
    peerId: "12D3KooWDevice",
    mesh: MESH,
    issuedAt: at.toISOString(),
  };
}

const expectConfirmation = { tag: "sandclaw/device-confirmation/v1", mesh: MESH, now: NOW } as const;

describe("signed statements", () => {
  it("verifies a statement signed by the person key", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    expect(signed.signer).toBe(key.id);
    expect(await verifyStatement(signed, expectConfirmation)).toMatchObject({ ok: true });
  });

  it("verifies whatever the key order after a round trip through JSON", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    const { tag, peerId, mesh, issuedAt } = signed.statement;
    const reordered = { ...signed, statement: { issuedAt, mesh, peerId, tag } };
    const wire = JSON.parse(JSON.stringify(reordered));
    expect(await verifyStatement(wire, expectConfirmation)).toMatchObject({ ok: true });
  });

  it("refuses a statement whose fields were changed", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    const tampered = { ...signed, statement: { ...signed.statement, peerId: "12D3KooWOther" } };
    expect(await verifyStatement(tampered, expectConfirmation)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a statement signed by someone else", async () => {
    const [a, b] = [await generatePersonKey(), await generatePersonKey()];
    const signed = await signStatement(confirmation(), a);
    expect(await verifyStatement({ ...signed, signer: b.id }, expectConfirmation)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses unknown fields", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    const extra = { ...signed, statement: { ...signed.statement, role: "admin" } };
    expect(await verifyStatement(extra, expectConfirmation)).toEqual({ ok: false, reason: "malformed" });
  });

  it("does not accept one kind of statement as another", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    expect(await verifyStatement(signed, { tag: "sandclaw/person-merge/v1", mesh: MESH, now: NOW })).toEqual({
      ok: false,
      reason: "wrong-tag",
    });
  });

  it("refuses a statement made for another group", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    expect(await verifyStatement(signed, { ...expectConfirmation, mesh: "12D3KooWOtherHub" })).toEqual({
      ok: false,
      reason: "wrong-mesh",
    });
  });

  it("accepts exactly 5 minutes, refuses one millisecond more", async () => {
    const key = await generatePersonKey();
    for (const offset of [-300_000, 300_000]) {
      const at = new Date(NOW.getTime() + offset);
      expect(await verifyStatement(await signStatement(confirmation(at), key), expectConfirmation)).toMatchObject({
        ok: true,
      });
    }
    for (const offset of [-300_001, 300_001]) {
      const at = new Date(NOW.getTime() + offset);
      expect(await verifyStatement(await signStatement(confirmation(at), key), expectConfirmation)).toEqual({
        ok: false,
        reason: "clock-skew",
      });
    }
  });

  it("NFC-normalizes values before signing", async () => {
    const key = await generatePersonKey();
    const profile: Profile = { tag: "sandclaw/profile/v1", name: "Inès", updatedAt: NOW.toISOString() };
    const signed = await signStatement(profile, key);
    const composed = { ...signed, statement: { ...signed.statement, name: "Inès" } };
    expect(await verifyStatement(composed, { tag: "sandclaw/profile/v1", now: NOW })).toMatchObject({ ok: true });
  });

  it("never throws on garbage", async () => {
    const key = await generatePersonKey();
    const good = await signStatement(confirmation(), key);
    const garbage: unknown[] = [
      null,
      "text",
      {},
      { statement: good.statement, signer: good.signer },
      { ...good, signature: good.signature.slice(0, 10) },
      { ...good, signature: "!!!" },
      { ...good, signer: "short" },
      { ...good, statement: { ...good.statement, issuedAt: "yesterday" } },
      { ...good, statement: { ...good.statement, mesh: 42 } },
    ];
    for (const input of garbage) {
      const result = await verifyStatement(input, expectConfirmation);
      expect(result.ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run tests/statements.test.ts`
Expected: FAIL: `Failed to load url ../src/statements.js`.

- [ ] **Step 3: Write the implementation**

`packages/httpeers-person/src/statements.ts`:

```ts
/**
 * The statements a person key signs. Each starts with a domain tag, so a
 * signature made for one kind can never be read as another, and each is a flat
 * record of strings, signed over its canonical JSON (see encoding.ts).
 */
import { canonicalJson, fromBase64Url, toBase64Url, utf8 } from "./encoding.js";
import { type PersonId, type PersonKey, verifyingKeyOf } from "./keys.js";

/** Binds a device (its peerId) to a person, in one group. */
export interface DeviceConfirmation {
  tag: "sandclaw/device-confirmation/v1";
  peerId: string;
  mesh: string;
  issuedAt: string;
}

/** A person's consent to stop existing and become another. Signed by `from`. */
export interface MergeStatement {
  tag: "sandclaw/person-merge/v1";
  from: PersonId;
  into: PersonId;
  mesh: string;
  at: string;
}

/** A person asks the hub for an invite for one of their own new devices. */
export interface DeviceInviteRequest {
  tag: "sandclaw/device-invite-request/v1";
  mesh: string;
  requester: string;
  personId: PersonId;
  at: string;
}

/** What a person says about themself. The only source of their name. */
export interface Profile {
  tag: "sandclaw/profile/v1";
  name: string;
  updatedAt: string;
}

export type Statement = DeviceConfirmation | MergeStatement | DeviceInviteRequest | Profile;

export interface Signed<T extends Statement> {
  statement: T;
  signer: PersonId;
  signature: string;
}

export type VerifyFailure = "malformed" | "wrong-tag" | "bad-signature" | "wrong-mesh" | "clock-skew";

export type VerifyResult<T extends Statement> =
  | { ok: true; signed: Signed<T> }
  | { ok: false; reason: VerifyFailure };

/** The fields of each kind, and which of them holds its time. */
const SHAPES: Record<Statement["tag"], { fields: readonly string[]; time: string }> = {
  "sandclaw/device-confirmation/v1": { fields: ["tag", "peerId", "mesh", "issuedAt"], time: "issuedAt" },
  "sandclaw/person-merge/v1": { fields: ["tag", "from", "into", "mesh", "at"], time: "at" },
  "sandclaw/device-invite-request/v1": {
    fields: ["tag", "mesh", "requester", "personId", "at"],
    time: "at",
  },
  "sandclaw/profile/v1": { fields: ["tag", "name", "updatedAt"], time: "updatedAt" },
};

const MAX_SKEW_MS = 5 * 60 * 1000;
const ED25519 = { name: "Ed25519" } as const;

export async function signStatement<T extends Statement>(statement: T, key: PersonKey): Promise<Signed<T>> {
  const bytes = utf8(canonicalJson(statement as unknown as Record<string, string>));
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, key.privateKey, bytes));
  return { statement, signer: key.id, signature: toBase64Url(signature) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks shape, tag, signature, group and time, in that order. Never throws:
 * anything that is not a well-formed statement of the expected kind is
 * `malformed` or `wrong-tag`.
 */
export async function verifyStatement<T extends Statement>(
  signed: unknown,
  expect: { tag: T["tag"]; mesh?: string; now: Date },
): Promise<VerifyResult<T>> {
  if (!isRecord(signed) || !isRecord(signed.statement)) return { ok: false, reason: "malformed" };
  const { statement, signer, signature } = signed;
  if (typeof signer !== "string" || typeof signature !== "string") return { ok: false, reason: "malformed" };

  const shape = SHAPES[statement.tag as Statement["tag"]];
  if (!shape) return { ok: false, reason: "malformed" };
  const keys = Object.keys(statement);
  const wellFormed =
    keys.length === shape.fields.length &&
    shape.fields.every((f) => typeof statement[f] === "string");
  if (!wellFormed) return { ok: false, reason: "malformed" };
  if (statement.tag !== expect.tag) return { ok: false, reason: "wrong-tag" };

  const time = Date.parse(statement[shape.time] as string);
  const sig = fromBase64Url(signature);
  const verifier = await verifyingKeyOf(signer);
  if (Number.isNaN(time) || !sig || !verifier) return { ok: false, reason: "malformed" };

  const bytes = utf8(canonicalJson(statement as Record<string, string>));
  const valid = await crypto.subtle.verify(ED25519, verifier, sig, bytes).catch(() => false);
  if (!valid) return { ok: false, reason: "bad-signature" };

  if ("mesh" in statement && expect.mesh !== undefined && statement.mesh !== expect.mesh) {
    return { ok: false, reason: "wrong-mesh" };
  }
  if (Math.abs(time - expect.now.getTime()) > MAX_SKEW_MS) return { ok: false, reason: "clock-skew" };

  return { ok: true, signed: { statement: statement as unknown as T, signer, signature } };
}
```

Append to `packages/httpeers-person/src/index.ts`:

```ts
export {
  type DeviceConfirmation,
  type DeviceInviteRequest,
  type MergeStatement,
  type Profile,
  type Signed,
  type Statement,
  signStatement,
  type VerifyFailure,
  type VerifyResult,
  verifyStatement,
} from "./statements.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run && npx tsc --noEmit`
Expected: PASS (19 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
cd ~/sw-migration/work/httpeers
git add packages/httpeers-person
git commit -m "feat(httpeers-person): signed statements with tag, group and clock checks"
```

---

### Task 4: The link code

**Files:**
- Create: `packages/httpeers-person/src/link-code.ts`
- Modify: `packages/httpeers-person/src/index.ts`
- Test: `packages/httpeers-person/tests/link-code.test.ts`

**Interfaces:**
- Consumes: `lengthPrefixed`, `toBase64Url`, `fromBase64Url` (Task 1).
- Produces:
  - `newNonce(): string`: 32 random bytes, base64url
  - `commitment(nonce: string): Promise<string>`: base64url SHA-256 of `lengthPrefixed(["sandclaw/link-commit/v1", nonceBytes])`
  - `checkReveal(commitment: string, nonce: string): Promise<boolean>`
  - `linkCode(input: { mesh: string; keeper: string; mover: string; keeperNonce: string; moverNonce: string }): Promise<string>`: `"ddd ddd"`

- [ ] **Step 1: Write the failing test**

`packages/httpeers-person/tests/link-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkReveal, commitment, linkCode, newNonce } from "../src/link-code.js";
import { fromBase64Url } from "../src/encoding.js";

const base = { mesh: "hub", keeper: "12D3KooWKeeper", mover: "12D3KooWMover" };

describe("commit, then reveal", () => {
  it("accepts the committed nonce and nothing else", async () => {
    const nonce = newNonce();
    const c = await commitment(nonce);
    expect(await checkReveal(c, nonce)).toBe(true);
    expect(await checkReveal(c, newNonce())).toBe(false);
    expect(await checkReveal(c, "not base64url!")).toBe(false);
  });

  it("makes 32-byte nonces that differ each time", () => {
    const [a, b] = [newNonce(), newNonce()];
    expect(fromBase64Url(a)).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

describe("linkCode", () => {
  it("gives both devices the same code from the same exchange", async () => {
    const input = { ...base, keeperNonce: newNonce(), moverNonce: newNonce() };
    const code = await linkCode(input);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(await linkCode({ ...input })).toBe(code);
  });

  it("changes when any input changes", async () => {
    const input = { ...base, keeperNonce: newNonce(), moverNonce: newNonce() };
    const code = await linkCode(input);
    const variants = [
      { ...input, mesh: "other-hub" },
      { ...input, keeper: "12D3KooWOther" },
      { ...input, mover: "12D3KooWOther" },
      { ...input, keeperNonce: newNonce() },
      { ...input, moverNonce: newNonce() },
    ];
    // Six digits: a single collision is possible (1 in a million) but five in a row is not.
    const codes = await Promise.all(variants.map(linkCode));
    expect(codes.filter((c) => c === code).length).toBeLessThan(2);
  });

  it("keeps leading zeros", async () => {
    // Search for an exchange whose code starts with 0; one in ten does.
    for (let i = 0; i < 200; i++) {
      const code = await linkCode({ ...base, keeperNonce: newNonce(), moverNonce: newNonce() });
      if (code.startsWith("0")) {
        expect(code).toMatch(/^0\d{2} \d{3}$/);
        return;
      }
    }
    throw new Error("no code with a leading zero in 200 tries");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run tests/link-code.test.ts`
Expected: FAIL: `Failed to load url ../src/link-code.js`.

- [ ] **Step 3: Write the implementation**

`packages/httpeers-person/src/link-code.ts`:

```ts
/**
 * The code both screens show during a link. The mover commits to its nonce
 * before it sees the keeper's, so nobody (the hub included) can steer the code
 * by choosing keys or nonces until it matches another screen.
 */
import { fromBase64Url, lengthPrefixed, toBase64Url } from "./encoding.js";

const NONCE_BYTES = 32;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function newNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

export async function commitment(nonce: string): Promise<string> {
  const bytes = fromBase64Url(nonce) ?? new Uint8Array();
  return toBase64Url(await sha256(lengthPrefixed(["sandclaw/link-commit/v1", bytes])));
}

export async function checkReveal(committed: string, nonce: string): Promise<boolean> {
  const bytes = fromBase64Url(nonce);
  if (!bytes || bytes.length !== NONCE_BYTES) return false;
  return (await commitment(nonce)) === committed;
}

export async function linkCode(input: {
  mesh: string;
  keeper: string;
  mover: string;
  keeperNonce: string;
  moverNonce: string;
}): Promise<string> {
  const digest = await sha256(
    lengthPrefixed([
      "sandclaw/link-code/v1",
      input.mesh,
      input.keeper,
      input.mover,
      fromBase64Url(input.keeperNonce) ?? new Uint8Array(),
      fromBase64Url(input.moverNonce) ?? new Uint8Array(),
    ]),
  );
  // The first 4 bytes as an unsigned integer, reduced to 6 digits. The modulo
  // bias (2^32 mod 10^6) is about 0.02% and does not help anyone steer the code.
  const value = new DataView(digest.buffer).getUint32(0) % 1_000_000;
  const digits = value.toString().padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
```

Append to `packages/httpeers-person/src/index.ts`:

```ts
export { checkReveal, commitment, linkCode, newNonce } from "./link-code.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run && npx tsc --noEmit`
Expected: PASS (24 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
cd ~/sw-migration/work/httpeers
git add packages/httpeers-person
git commit -m "feat(httpeers-person): link code with commit-then-reveal nonces"
```

---

### Task 5: Boundary test, README, changeset, repository wiring

**Files:**
- Create: `packages/httpeers-person/tests/boundary.test.ts`
- Create: `packages/httpeers-person/README.md`
- Create: `.changeset/httpeers-person-initial.md`
- Modify: `README.md` (root: the libraries table, after the `httpeers-access` row)

**Interfaces:**
- Consumes: everything exported from `src/index.ts` (Tasks 1–4).
- Produces: a buildable, documented package.

- [ ] **Step 1: Write the boundary test**

`packages/httpeers-person/tests/boundary.test.ts`:

```ts
/**
 * The package's claim — isomorphic, no dependencies — as a test. If the file
 * scan finds nothing, every check would pass vacuously, so it is guarded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = readdirSync(join(root, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(join(root, "src", f), "utf8") }));

describe("boundary", () => {
  it("scans some sources", () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
  });

  it("imports nothing but its own files", () => {
    for (const { file, text } of sources) {
      for (const [, spec] of text.matchAll(/from "([^"]+)"/g)) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\//);
      }
    }
  });

  it("declares no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
```

Run: `cd ~/sw-migration/work/httpeers/packages/httpeers-person && npx vitest run tests/boundary.test.ts`
Expected: PASS (3 tests). This guards an existing property, so it passes on the first run. Check that the guard works: temporarily add `import "node:fs";` to `src/keys.ts`, run the test, and see it FAIL with `keys.ts imports node:fs`. Then remove the line.

- [ ] **Step 2: Write the package README**

`packages/httpeers-person/README.md`. Use the package shape from the repository's README rules: what it is, why it exists, how to use, examples, internals, license. Headings are claims, not labels. Describe the current state only; do not mention the notes, the plan or Sandclaw's design history. Content:

````markdown
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
- **Domain tags.** Every statement and every hash input starts with a tag
  (`sandclaw/device-confirmation/v1`, …), so a signature or a digest made for one purpose
  cannot be replayed as another.
- **Time.** Statements carry their own time; `verifyStatement` accepts ±5 minutes around `now`.
  A device with a wrong clock sees `clock-skew`, not `bad-signature`.
- **Why commit, then reveal.** If each screen derived the code from the two peer ids alone, an
  attacker in the middle could generate peer keys until one matched: six digits is about a
  million tries, which takes seconds. The mover commits to its nonce before it sees the
  keeper's, so the code cannot be steered.
- **Hashing.** Hash inputs are length-prefixed (a 4-byte big-endian length before each field),
  so `("ab","c")` and `("a","bc")` never collide.
- **Key material.** A person key's private part is extractable on purpose, because it has to
  move between devices. Protecting it at rest is the caller's job.
- **Dependencies:** none. WebCrypto, `TextEncoder` and `atob`/`btoa` are platform globals.

## License

MIT
````

- [ ] **Step 3: Add the changeset and the root README row**

`.changeset/httpeers-person-initial.md`:

```markdown
---
"@statewalker/httpeers-person": minor
---

New package: person keys, signed statements (device confirmation, merge, device-invite request, profile) and the link code.
```

In the root `README.md`, in the libraries table, after the `httpeers-access` row, add:

```markdown
| [`httpeers-person`](packages/httpeers-person) | [`@statewalker/httpeers-person`](https://www.npmjs.com/package/@statewalker/httpeers-person) | person keys, the statements they sign, and the link code; no dependencies |
```

- [ ] **Step 4: Run the full checks**

Run:

```bash
cd ~/sw-migration/work/httpeers
pnpm --filter @statewalker/httpeers-person test
pnpm --filter @statewalker/httpeers-person lint:check
pnpm biome check --write --unsafe packages/httpeers-person README.md
```

Expected:
- `test`: builds `dist/`, typechecks, and PASSES 27 tests.
- `lint:check`: no findings.
- `biome check --write`: no remaining findings.

- [ ] **Step 5: Commit**

```bash
cd ~/sw-migration/work/httpeers
git add packages/httpeers-person README.md .changeset/httpeers-person-initial.md
git commit -m "docs(httpeers-person): README, boundary test, changeset"
```

---

## Roadmap: the plans that follow

Each is its own plan, written after this one is merged, and each ends in working, tested
software:

2. **httpeers-hub: people, devices and the new endpoints.**
   - Records: `Person` (active, unlinked, merged, revoked), `Device`, and `Invitation.linkTo`,
     persisted in the snapshot.
   - Endpoints: `POST /.well-known/confirm-device`, `POST /hub/device-invitations`,
     `POST /.well-known/link`.
   - Unlinked-person expiry; revoking a person.
   - The four additions: cancel an invite, set a person's roles (with a revocation on
     demotion), self-revoke own devices, and the group profile `{ name }` signed by the hub key,
     with the name in the join blob.
   - Members' view: people, not devices.
3. **httpeers-member: the person side.**
   - Person-key storage.
   - The keeper's link window and `/link/hello`, `/link/reveal` and `/link/identity` handlers.
   - The mover's link client.
   - The device-signed link hello (`sandclaw/link-hello/v1`, signed by the device key over
     `canonicalJson` from this package).
   - Verifying stored profiles with `now: null`.
   - `confirm-device` after joining.
   - The `pending` and `unlinked` session phases.
4. **The LLM passthrough tags the caller.** `apps/hub` `services/llm` sets LiteLLM's `user`
   to the caller's person id, so usage per person is visible. Plus a test that a revoked
   member's `/llm` call is refused (Q1).

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

export type VerifyFailure =
  | "malformed"
  | "wrong-tag"
  | "bad-signature"
  | "wrong-signer"
  | "wrong-mesh"
  | "clock-skew";

export type VerifyResult<T extends Statement> =
  | { ok: true; signed: Signed<T> }
  | { ok: false; reason: VerifyFailure };

/** The fields of each kind, and which of them holds its time. */
const SHAPES: Record<Statement["tag"], { fields: readonly string[]; time: string }> = {
  "sandclaw/device-confirmation/v1": {
    fields: ["tag", "peerId", "mesh", "issuedAt"],
    time: "issuedAt",
  },
  "sandclaw/person-merge/v1": { fields: ["tag", "from", "into", "mesh", "at"], time: "at" },
  "sandclaw/device-invite-request/v1": {
    fields: ["tag", "mesh", "requester", "personId", "at"],
    time: "at",
  },
  "sandclaw/profile/v1": { fields: ["tag", "name", "updatedAt"], time: "updatedAt" },
};

const MAX_SKEW_MS = 5 * 60 * 1000;
const ED25519 = { name: "Ed25519" } as const;
const STRICT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const SIGNATURE_BYTES = 64;

type StatementOf<K extends Statement["tag"]> = Extract<Statement, { tag: K }>;

/** `mesh` is required exactly for the kinds that carry one; `now: null` skips the clock check. */
type Expect<K extends Statement["tag"]> = { tag: K; now: Date | null } & (StatementOf<K> extends {
  mesh: string;
}
  ? { mesh: string }
  : { mesh?: undefined });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `statement` is a known kind with exactly that kind's fields, all strings. */
function hasShape(statement: Record<string, unknown>): boolean {
  if (typeof statement.tag !== "string" || !Object.hasOwn(SHAPES, statement.tag)) return false;
  const { fields } = SHAPES[statement.tag as Statement["tag"]];
  return (
    Object.keys(statement).length === fields.length &&
    fields.every((f) => typeof statement[f] === "string")
  );
}

export async function signStatement<T extends Statement>(
  statement: T,
  key: PersonKey,
): Promise<Signed<T>> {
  if (!hasShape(statement as unknown as Record<string, unknown>))
    throw new TypeError("statement does not have the shape of its kind");
  const bytes = utf8(canonicalJson(statement as unknown as Record<string, string>));
  const signature = new Uint8Array(
    await crypto.subtle.sign(ED25519, key.privateKey, new Uint8Array(bytes)),
  );
  return { statement, signer: key.id, signature: toBase64Url(signature) };
}

/**
 * Checks shape, tag, time format, signature, signer, group and freshness, in
 * that order. Never throws on wire input: anything that is not a well-formed
 * statement of the expected kind is `malformed` or `wrong-tag`. Only an invalid
 * `expect.now` (the caller's argument) throws a TypeError.
 */
export async function verifyStatement<K extends Statement["tag"]>(
  signed: unknown,
  expect: Expect<K>,
): Promise<VerifyResult<StatementOf<K>>> {
  if (expect.now !== null && !Number.isFinite(expect.now.getTime()))
    throw new TypeError("expect.now is not a valid date");
  if (!isRecord(signed) || !isRecord(signed.statement)) return { ok: false, reason: "malformed" };
  const { statement, signer, signature } = signed;
  if (typeof signer !== "string" || typeof signature !== "string")
    return { ok: false, reason: "malformed" };
  if (!hasShape(statement)) return { ok: false, reason: "malformed" };
  if (statement.tag !== expect.tag) return { ok: false, reason: "wrong-tag" };

  const timeText = statement[SHAPES[statement.tag as Statement["tag"]].time] as string;
  const sig = fromBase64Url(signature);
  const verifier = await verifyingKeyOf(signer);
  if (
    !STRICT_TIME.test(timeText) ||
    Number.isNaN(Date.parse(timeText)) ||
    sig?.length !== SIGNATURE_BYTES ||
    toBase64Url(sig) !== signature ||
    !verifier
  )
    return { ok: false, reason: "malformed" };

  const bytes = utf8(canonicalJson(statement as Record<string, string>));
  const valid = await crypto.subtle
    .verify(ED25519, verifier, new Uint8Array(sig), new Uint8Array(bytes))
    .catch(() => false);
  if (!valid) return { ok: false, reason: "bad-signature" };

  if (statement.tag === "sandclaw/person-merge/v1" && statement.from !== signer)
    return { ok: false, reason: "wrong-signer" };
  if (statement.tag === "sandclaw/device-invite-request/v1" && statement.personId !== signer)
    return { ok: false, reason: "wrong-signer" };

  if ("mesh" in statement && statement.mesh !== expect.mesh)
    return { ok: false, reason: "wrong-mesh" };
  if (expect.now !== null && Math.abs(Date.parse(timeText) - expect.now.getTime()) > MAX_SKEW_MS)
    return { ok: false, reason: "clock-skew" };

  return {
    ok: true,
    signed: { statement: statement as unknown as StatementOf<K>, signer, signature },
  };
}

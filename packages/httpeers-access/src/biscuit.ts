/**
 * The seam between this package and the Biscuit engine — pure TypeScript
 * (`@statewalker/webrun-biscuit`), no WebAssembly.
 *
 * `tokens.ts` and `rules.ts` speak only through this file, so it is the one
 * place that knows the engine's shape. It supplies the four things the wasm
 * binding offered directly and webrun-biscuit 0.1.0 does not:
 *
 *   1. PARAMETER BINDING. The wasm had `addCodeWithParameters`; here values
 *      are rendered as Datalog literals by `datalog\`...\``. Interpolating an
 *      untrusted string into Datalog is an injection seam, so this is the
 *      security-relevant part: a string is quoted exactly the way the engine's
 *      own printer quotes it (backslash and double quote escaped, nothing else
 *      — the parser takes every other character literally), a number must be a
 *      safe integer, and nothing else is accepted. `tests/biscuit.test.ts`
 *      round-trips hostile strings through the parser to prove it.
 *   2. QUERIES. The wasm had `authorizer.query(rule)`; here the facts are read
 *      out of `authorizeDetailed`'s world snapshot, keeping only those an
 *      authorizer-scoped query can see (origin within {authority, authorizer}).
 *      The snapshot prints terms, so they are parsed back with the engine's own
 *      parser — a round trip the corpus world-snapshot suite already pins.
 *   3. AUTHORIZING WITH NO TOKEN (`buildUnauthenticated`): an empty
 *      `LoadedToken`.
 *   4. FAILED-CHECK TEXT. Results name a failed check by block and index; the
 *      rule text comes from the same snapshot.
 *
 * What it no longer needs: a warm-up, a spurious-`Timeout` retry, a wasm
 * loader, bundler aliases, or guards against values that trap at the wasm
 * boundary. A `Timeout` from this engine is a real wall-clock measurement.
 */

import {
  type AuthorizationResult,
  type AuthorizeDetails,
  type AuthorizeOptions,
  authorizeDetailed,
  type LoadedToken,
  parseAuthorizer,
  type Term,
  type WorldSnapshot,
} from "@statewalker/webrun-biscuit";

export type EngineLimits = NonNullable<AuthorizeOptions["limits"]>;

/** Render one value as a Datalog literal. Throws on anything without a safe literal form. */
export function literal(value: unknown): string {
  if (typeof value === "string") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`datalog: ${value} is not a safe integer`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new TypeError(`datalog: no literal form for a value of type ${typeof value}`);
}

/** Datalog source with every interpolated value bound as a literal — `addCodeWithParameters`. */
export function datalog(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? literal(values[i]) : ""), "");
}

/** What `buildUnauthenticated` evaluated against: no blocks, no keys. */
export const NO_TOKEN: LoadedToken = Object.freeze({
  blocks: [],
  publicKeyToBlockIds: new Map(),
  revocationIds: [],
}) as LoadedToken;

export function evaluate(token: LoadedToken, code: string, limits: EngineLimits): AuthorizeDetails {
  return authorizeDetailed(token, code, { limits });
}

/**
 * Every first term of `<predicate>(...)` visible to an authorizer-scoped query,
 * as JS values — `authorizer.query("claim($x) <- <predicate>($x)")`.
 *
 * Visible means every origin of the fact is the authority block (0) or the
 * authorizer (printed `null`): a later block's facts are out of scope, exactly
 * as they were for the wasm query.
 */
export function queryFirstTerms(world: WorldSnapshot, predicate: string): unknown[] {
  const prefix = `${predicate}(`;
  const printed = world.facts
    .filter((group) => group.origin.every((id) => id === 0 || id === null))
    .flatMap((group) => group.facts)
    .filter((fact) => fact.startsWith(prefix));
  if (printed.length === 0) return [];
  return parseAuthorizer(`${printed.join(";\n")};`).facts.map((fact) =>
    toJs(fact.predicate.terms[0]),
  );
}

function toJs(term: Term | undefined): unknown {
  if (term === undefined) return undefined;
  switch (term.t) {
    case "str":
    case "bool":
      return term.v;
    case "int":
      // The wasm handed integers back as JS numbers; keep that contract. One
      // that does not fit stays a bigint, which the caller's type check refuses
      // rather than silently rounding.
      return Number.isSafeInteger(Number(term.v)) ? Number(term.v) : term.v;
    default:
      return term;
  }
}

/** Render a result's failed checks as `block <id> check <id>: <rule>` / `authorizer check <id>: <rule>`. */
export function failedCheckTexts(result: AuthorizationResult, world: WorldSnapshot): string[] {
  if (result.kind !== "unauthorized" && result.kind !== "noMatchingPolicy") return [];
  // The snapshot keys authorizer checks by the u64 block id `usize::MAX`,
  // which a JS number cannot hold exactly; anything past u32 is the authorizer.
  const textOf = (origin: number, index: number): string =>
    world.checks.find((g) => (origin < 0 ? g.origin > 0xffffffff : g.origin === origin))?.checks[
      index
    ] ?? "?";
  return result.checks.map((check) =>
    check.source === "authorizer"
      ? `authorizer check ${check.checkId}: ${textOf(-1, check.checkId)}`
      : `block ${check.blockId} check ${check.checkId}: ${textOf(check.blockId, check.checkId)}`,
  );
}

/** Parse ONE statement of the expected kind and return its canonical text, or throw with why not. */
export function canonicalStatement(
  text: string,
  kind: "rule" | "policy",
  limits: EngineLimits,
): string {
  const code = `${text};`;
  const parsed = parseAuthorizer(code); // throws ParseError on bad syntax
  const count =
    parsed.facts.length + parsed.rules.length + parsed.checks.length + parsed.policies.length;
  const wanted = kind === "rule" ? parsed.rules.length : parsed.policies.length;
  if (count !== 1 || wanted !== 1) {
    throw new Error(`expected exactly one ${kind}`);
  }
  const { world } = evaluate(NO_TOKEN, code, limits);
  const canonical = kind === "rule" ? world.rules[0]?.rules[0] : world.policies[0];
  if (canonical === undefined) throw new Error(`expected exactly one ${kind}`);
  return canonical;
}

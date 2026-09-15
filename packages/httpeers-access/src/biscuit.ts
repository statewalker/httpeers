/**
 * The seam between this package and the Biscuit engine — pure TypeScript
 * (`@statewalker/webrun-biscuit`), no WebAssembly.
 *
 * `tokens.ts` and `rules.ts` speak only through this file, so it is the one
 * place that knows the engine's shape. It is thin on purpose: the engine binds
 * parameters, answers queries, evaluates without a token and names failed
 * checks by their rule text itself. What is left here is vocabulary.
 *
 * VALUES ARE PARAMETERS, NEVER TEXT. `Datalog.add` is a tagged template, so a
 * call site reads like the program it builds, but every interpolated value is
 * bound as a `{pN}` parameter — a TERM. A `sub`, a role or a request path is
 * never spliced into source, so none of them can change a program's shape:
 * a role named `"); role("admin` is a role with a silly name and nothing more.
 *
 * What the wasm era needed and this does not: a warm-up, a spurious-`Timeout`
 * retry, a loader, bundler aliases, and guards against values that trap at the
 * wasm boundary. A `Timeout` from this engine is a real wall-clock measurement.
 */

import {
  type AuthorizationResult,
  type Evaluation,
  evaluate as evaluateProgram,
  type LoadedToken,
  type ParamValue,
  parseAuthorizer,
  type RunLimits,
  type Term,
} from "@statewalker/webrun-biscuit";

export type EngineLimits = RunLimits;

/** Datalog source plus the parameters its interpolated values were bound to. */
export class Datalog {
  private readonly lines: string[] = [];
  private readonly bound: Record<string, ParamValue> = {};
  private next = 0;

  /** Append source. Every `${value}` becomes a `{pN}` parameter — a term, never text. */
  add(strings: TemplateStringsArray, ...values: ParamValue[]): this {
    let line = strings[0] ?? "";
    values.forEach((value, i) => {
      const name = `p${this.next++}`;
      this.bound[name] = value;
      line += `{${name}}${strings[i + 1] ?? ""}`;
    });
    this.lines.push(line);
    return this;
  }

  /** Append source that interpolates nothing — rules and policies already validated. */
  raw(source: string): this {
    this.lines.push(source);
    return this;
  }

  get source(): string {
    return this.lines.join("\n");
  }

  get params(): Readonly<Record<string, ParamValue>> {
    return this.bound;
  }
}

/** Run `code` against a verified token, or against no token at all. */
export function evaluate(
  token: LoadedToken | null,
  code: Datalog,
  limits: EngineLimits,
): Evaluation {
  return evaluateProgram(token, code.source, { limits, params: code.params });
}

/**
 * Every first term of `<predicate>(...)` an authorizer-scoped query can see,
 * as JS values. `predicate` is always a constant of this package, never input.
 */
export function firstTerms(evaluation: Evaluation, predicate: string): unknown[] {
  return evaluation.query(`claim($x) <- ${predicate}($x)`).map((fact) => toJs(fact.terms[0]));
}

function toJs(term: Term | undefined): unknown {
  if (term === undefined) return undefined;
  switch (term.t) {
    case "str":
    case "bool":
      return term.v;
    case "int":
      // Integers come back as JS numbers, as the wasm handed them. One that does
      // not fit stays a bigint, which the caller's type check refuses rather
      // than silently rounding.
      return Number.isSafeInteger(Number(term.v)) ? Number(term.v) : term.v;
    default:
      return term;
  }
}

/** A result's failed checks as `block <id> check <id>: <rule>` / `authorizer check <id>: <rule>`. */
export function failedCheckTexts(result: AuthorizationResult): string[] {
  if (result.kind !== "unauthorized" && result.kind !== "noMatchingPolicy") return [];
  return result.checks.map((check) =>
    check.source === "authorizer"
      ? `authorizer check ${check.checkId}: ${check.rule}`
      : `block ${check.blockId} check ${check.checkId}: ${check.rule}`,
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
  const world = evaluateProgram(null, code, { limits }).snapshot();
  const canonical = kind === "rule" ? world.rules[0]?.rules[0] : world.policies[0];
  if (canonical === undefined) throw new Error(`expected exactly one ${kind}`);
  return canonical;
}

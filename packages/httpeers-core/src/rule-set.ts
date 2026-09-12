/**
 * The rule-set VOCABULARY: the value, and the functions that read one.
 *
 * WHAT IS HERE AND WHAT IS NOT, and why the line falls where it does.
 * `rules.ts` in the package this was extracted from is 628 lines, and exactly
 * four of its functions need WebAssembly: `ruleSet()` (which canonicalises
 * every rule and policy through the Biscuit parser), `authorize`,
 * `deriveCapabilities`, and the private `addRules`. Everything else — this
 * file — is pure string work over an already-built value.
 *
 * Splitting there rather than moving `rules.ts` wholesale is what lets
 * `createMemberStore(rules, clock)` keep validating its roles AT THE STORE,
 * where the durable guard belongs, without dragging a WASM runtime into every
 * consumer that merely holds a membership registry. The alternative considered
 * was injecting a validator function into the store; measuring which functions
 * actually touch wasm made that unnecessary, and it would have changed a
 * signature with thirteen call sites for no gain.
 *
 * DO NOT "RESTORE" `ruleSet()` INTO THIS FILE. It is in
 * `@statewalker/httpeers-access` deliberately. A rule set is *built* where the
 * parser lives and *read* everywhere, which is the whole shape of the split.
 */

const BUILT: unique symbol = Symbol.for("httpeers.ruleSet") as typeof BUILT;

/**
 * An immutable, validated rule set (ADR-0007: a value, swapped atomically).
 *
 * Only `ruleSet()` produces one — and it now lives in another package, which
 * is why the brand below is `Symbol.for` and not `Symbol()`. A registry symbol
 * is shared across module instances and package boundaries; a fresh `Symbol()`
 * would mean a rule set built by `httpeers-access` failed `assertBuilt` here,
 * silently, with a message accusing the caller of passing an object literal.
 * **Changing it to `Symbol()` breaks the split and looks like tidying.**
 *
 * The brand is not decoration either: a caller who could assemble a `RuleSet`
 * from an object literal would bypass every check the builder performs, and a
 * rule set that was never validated is exactly the silent permanent denial the
 * policy module exists to refuse.
 */
export interface RuleSet {
  readonly [BUILT]: true;
  /** Bumped by the author on every edit; carried in the heartbeat version vector. */
  readonly version: number;
  /** Capability derivation and role implication, canonicalized, one rule each. */
  readonly rules: readonly string[];
  /** `deny` policies first, then `allow`, each group in authored order. */
  readonly policies: readonly string[];
}

/** The brand, exported so the builder in `httpeers-access` can apply it. */
export const RULE_SET_BRAND: typeof BUILT = BUILT;

/** Every problem with a rule set, never just the first. */
export class RuleSetError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid rule set:\n  - ${problems.join("\n  - ")}`);
    this.name = "RuleSetError";
  }
}

export function assertValid(problems: string[]): void {
  if (problems.length > 0) throw new RuleSetError(problems);
}

export interface RuleSetDefs {
  version?: number;
  rules?: readonly string[];
  policies?: readonly string[];
}

/** Guards the seam `RuleSet`'s brand describes — see that interface. */
export function assertBuilt(value: RuleSet): void {
  if (value?.[BUILT] !== true) {
    throw new RuleSetError([
      "a rule set must be built by ruleSet(), which validates it -- an object literal is not one",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Reading a rule set
// ---------------------------------------------------------------------------

/**
 * Every role name the rules mention, sorted.
 *
 * There is no role registry any more, so this IS the registry: a role exists
 * for this node exactly when some rule fires on it. Used to validate the roles
 * an invitation or a membership record names, and to populate an admin UI's
 * role list.
 */
export function roleNames(rules: RuleSet): string[] {
  return [...new Set(rules.rules.flatMap((r) => literalsOf("role", r)))].sort();
}

/** Every capability some rule can derive, sorted. Empty when derivation is open. */
export function capabilityNames(rules: RuleSet): string[] {
  return [
    ...new Set(rules.rules.flatMap((r) => literalsOf("capability", r.split("<-")[0] ?? ""))),
  ].sort();
}

/** Roles named in an invitation or a membership record must be roles some rule knows. */
export function validateRoles(rules: RuleSet, roles: readonly string[], context: string): string[] {
  const known = new Set(roleNames(rules));
  return roles.filter((r) => !known.has(r)).map((r) => `${context}: unknown role '${r}'`);
}

/** Pull `predicate("literal")` occurrences out of a rule's source text. */
export function literalsOf(predicate: string, text: string): string[] {
  const pattern = new RegExp(`${predicate}\\(\\s*"([^"]*)"\\s*\\)`, "g");
  return [...text.matchAll(pattern)].map((m) => m[1] as string);
}

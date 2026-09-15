/**
 * The engine seam's one security-relevant job: binding values into Datalog.
 *
 * The wasm bound parameters as terms (`addCodeWithParameters`). The TypeScript
 * engine takes source text, so `datalog` renders each value as a literal — and
 * a literal that a hostile string can escape is an injection seam through which
 * a `sub`, a role or a request path could assert facts of its own. These tests
 * feed hostile strings through the engine's OWN parser and require exactly one
 * fact carrying exactly the original string back out.
 */

import { parseAuthorizer } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import { datalog, evaluate, literal, NO_TOKEN, queryFirstTerms } from "../src/biscuit.js";
import { ENGINE_LIMITS } from "../src/tokens.js";

const CONTROL = String.fromCharCode(0, 31, 0x2028, 0xd83d, 0xde00);

const HOSTILE = [
  '"); role("admin',
  '\\"); role("admin',
  "\\",
  '\\\\"',
  'line\nbreak); role("admin"',
  "/* comment */ // and more",
  CONTROL,
  "$x",
  "",
];

describe("datalog literals", () => {
  it.each(HOSTILE)("binds %j as one string term and nothing else", (value) => {
    const parsed = parseAuthorizer(datalog`role(${value});`);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.rules.length + parsed.checks.length + parsed.policies.length).toBe(0);
    expect(parsed.facts[0]?.predicate.terms).toEqual([{ t: "str", v: value }]);
  });

  it("round-trips random strings through the parser and the world snapshot", () => {
    const alphabet = ['"', "\\", "\n", ";", "(", ")", "$", "a", " ", "é", "/", "*"];
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(Math.random() * 12);
      const value = Array.from(
        { length },
        () => alphabet[Math.floor(Math.random() * alphabet.length)],
      ).join("");
      const { world } = evaluate(NO_TOKEN, datalog`role(${value});`, ENGINE_LIMITS);
      expect(queryFirstTerms(world, "role")).toEqual([value]);
    }
  });

  it("refuses values that have no exact literal form", () => {
    expect(() => literal(1.5)).toThrow(TypeError);
    expect(() => literal(2 ** 60)).toThrow(TypeError);
    expect(() => literal(undefined)).toThrow(TypeError);
    expect(() => literal({ toString: () => '"); role("admin' })).toThrow(TypeError);
  });

  it("reads only facts an authorizer query can see", () => {
    const { world } = evaluate(
      NO_TOKEN,
      'role("a"); role("b");\ncapability("x") <- role("a");',
      ENGINE_LIMITS,
    );
    expect(queryFirstTerms(world, "capability")).toEqual(["x"]);
    // a predicate that merely shares a prefix is not the predicate
    expect(queryFirstTerms(world, "rol")).toEqual([]);
  });
});

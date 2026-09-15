/**
 * The engine seam's one security-relevant job: getting values into Datalog.
 *
 * `Datalog.add` reads like string interpolation, and that is exactly the
 * mistake it must not make. Every interpolated value has to arrive as a TERM —
 * a parameter the engine binds — so a hostile `sub`, role or request path can
 * never assert a fact of its own. These tests feed hostile strings through the
 * seam and require exactly the original string back out, and nothing else.
 */

import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import { Datalog, evaluate, firstTerms } from "../src/biscuit.js";
import { ENGINE_LIMITS } from "../src/tokens.js";

const CONTROL = String.fromCharCode(0, 31, 0x2028, 0xd83d, 0xde00);

const HOSTILE = [
  '"); role("admin',
  '\\"); role("admin',
  "\\",
  '\\\\"',
  'line\nbreak); role("admin"',
  "/* comment */ // and more",
  "{p1}",
  CONTROL,
  "$x",
  "",
];

describe("the Datalog seam", () => {
  it.each(HOSTILE)("binds %j as one term and asserts nothing else", (value) => {
    const code = new Datalog().add`role(${value});`;
    expect(code.source).toBe("role({p0});");
    const evaluation = evaluate(null, code, ENGINE_LIMITS);
    expect(firstTerms(evaluation, "role")).toEqual([value]);
    expect(firstTerms(evaluation, "admin")).toEqual([]);
  });

  it("round-trips random strings", () => {
    const alphabet = ['"', "\\", "\n", ";", "(", ")", "$", "{", "}", "a", " ", "é", "/", "*"];
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(Math.random() * 12);
      const value = Array.from(
        { length },
        () => alphabet[Math.floor(Math.random() * alphabet.length)],
      ).join("");
      const code = new Datalog().add`role(${value}); subject(${value});`;
      expect(firstTerms(evaluate(null, code, ENGINE_LIMITS), "role")).toEqual([value]);
    }
  });

  it("numbers every parameter across statements, so none shadows another", () => {
    const code = new Datalog().add`subject(${"a"}); issued_at(${1});`.raw(
      'capability("x") <- role("r");',
    ).add`role(${"r"});`;
    expect(code.source).toBe(
      'subject({p0}); issued_at({p1});\ncapability("x") <- role("r");\nrole({p2});',
    );
    const evaluation = evaluate(null, code, ENGINE_LIMITS);
    expect(firstTerms(evaluation, "capability")).toEqual(["x"]);
    expect(firstTerms(evaluation, "issued_at")).toEqual([1]);
  });

  it("refuses a value that has no exact term, rather than rounding it", () => {
    const evaluation = evaluate(null, new Datalog().add`n(${1.5});`, ENGINE_LIMITS);
    expect(evaluation.result.kind).toBe("format");
  });

  it("reads only facts an authorizer query can see", () => {
    const root = generateKeypair();
    const token = Biscuit.build(root.secretKey, 'role("member");')
      .attenuate('role("admin");')
      .verify(root.publicKey);
    const evaluation = evaluate(
      token.token,
      new Datalog().raw(
        'capability("read") <- role("member");\ncapability("root") <- role("admin");',
      ),
      ENGINE_LIMITS,
    );
    expect(firstTerms(evaluation, "capability")).toEqual(["read"]);
    // a predicate that merely shares a prefix is not the predicate
    expect(firstTerms(evaluation, "rol")).toEqual([]);
  });
});

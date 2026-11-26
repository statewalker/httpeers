/**
 * The helpers a token issuer needs around the core: a revocation check, the
 * printer, and the parameterised code builder (statewalker/httpeers#156).
 */
import assert from "node:assert";
import {
  assertNotRevoked,
  Biscuit,
  Datalog,
  datalog,
  evaluate,
  generateKeypair,
  isRevoked,
  printBlock,
  RevokedTokenError,
  revokedId,
} from "../src/index.js";

const root = generateKeypair();

test("isRevoked finds any block's revocation id in the revoked set", () => {
  const base = Biscuit.build(root.secretKey, 'user("alice");');
  const attenuated = base.attenuate('check if operation("read");');
  const verified = attenuated.verify(root.publicKey);
  const [authorityId, blockId] = verified.revocationIds;
  assert.ok(authorityId && blockId && authorityId !== blockId);

  assert.equal(isRevoked(verified, new Set()), false);
  assert.equal(isRevoked(verified, new Set(["00"])), false);
  // revoking the authority block revokes every token derived from it
  assert.equal(isRevoked(verified, new Set([authorityId])), true);
  // revoking an attenuation revokes that attenuation, not its parent
  assert.equal(isRevoked(verified, new Set([blockId])), true);
  assert.equal(isRevoked(base.verify(root.publicKey), new Set([blockId])), false);
  assert.equal(verified.isRevoked(new Set([blockId])), true);
  assert.equal(revokedId(verified, new Set([blockId, authorityId])), authorityId);
});

test("assertNotRevoked throws a typed error naming the revoked id", () => {
  const verified = Biscuit.build(root.secretKey, 'user("alice");').verify(root.publicKey);
  const [id] = verified.revocationIds;
  assert.doesNotThrow(() => assertNotRevoked(verified, new Set(["ff"])));
  assert.throws(
    () => assertNotRevoked(verified, new Set([id as string])),
    (error: unknown) =>
      error instanceof RevokedTokenError &&
      error.revocationId === id &&
      /revoked/.test(error.message),
  );
});

test("print shows each block as Datalog that parses back to the same block", () => {
  const external = generateKeypair();
  const key = `ed25519/${Array.from(external.publicKey, (x) => x.toString(16).padStart(2, "0")).join("")}`;
  const token = Biscuit.build(
    root.secretKey,
    'user("alice");\nright($r, "read") <- resource($r);\ncheck if time($t), $t < 2030-01-01T00:00:00Z;',
  ).attenuate(`trusting authority, ${key};\ncheck if operation("read") or operation("list");`);
  const printed = token.verify(root.publicKey).print();
  assert.deepStrictEqual(printed, [
    [
      'user("alice");',
      'right($r, "read") <- resource($r);',
      "check if time($t), $t < 2030-01-01T00:00:00Z;",
    ].join("\n"),
    [`trusting authority, ${key};`, 'check if operation("read") or operation("list");'].join("\n"),
  ]);

  // the text builds a token whose blocks print the same
  const rebuilt = Biscuit.build(root.secretKey, printed[0] as string)
    .attenuate(printed[1] as string)
    .verify(root.publicKey);
  assert.deepStrictEqual(rebuilt.print(), printed);
  assert.equal(printBlock(rebuilt.token.blocks[0] as never), printed[0]);
});

test("Datalog binds every interpolated value as a parameter, never as text", () => {
  const hostile = '"); role("admin';
  const code = new Datalog().add`user(${hostile});`
    .add`check if time($t), $t < ${new Date("2030-01-01T00:00:00Z")};`;
  assert.equal(code.source, "user({p0});\ncheck if time($t), $t < {p1};");
  assert.deepStrictEqual(Object.keys(code.params), ["p0", "p1"]);

  const verified = Biscuit.build(root.secretKey, code.source, { params: code.params }).verify(
    root.publicKey,
  );
  assert.deepStrictEqual(verified.print(), [
    `user(${JSON.stringify(hostile)});\ncheck if time($t), $t < 2030-01-01T00:00:00Z;`,
  ]);
  const ev = verified.evaluate("time(2029-01-01T00:00:00Z); allow if user($u);");
  assert.deepStrictEqual(ev.result, { kind: "ok", policy: 0 });
  assert.equal(ev.query("r($r) <- role($r)").length, 0, "the hostile string added no role fact");
});

test("datalog`…` starts a builder, raw appends text, and the result authorizes", () => {
  const code = datalog`resource(${"/a"});`.raw("allow if resource($r), owner($u, $r);");
  code.add`owner(${"alice"}, ${"/a"});`;
  assert.equal(
    code.source,
    "resource({p0});\nallow if resource($r), owner($u, $r);\nowner({p1}, {p2});",
  );
  const ev = evaluate(null, code.source, { params: code.params });
  assert.deepStrictEqual(ev.result, { kind: "ok", policy: 0 });
});

test("revoked ids match in either case, so an uppercase list does not fail open", () => {
  const verified = Biscuit.build(root.secretKey, 'user("alice");').verify(root.publicKey);
  const [id] = verified.revocationIds as [string];
  assert.equal(id, id.toLowerCase());
  assert.equal(isRevoked(verified, new Set([id.toUpperCase()])), true);
  assert.throws(() => assertNotRevoked(verified, new Set([id.toUpperCase()])), RevokedTokenError);
});

test("print escapes control characters, so one string never shows as several statements", () => {
  const spoof = 'ok");\ncheck if true;\rrole("admin\u2028\u202e\t\u0000\u0085';
  const code = datalog`note(${spoof});`.add`check if note(${"a\nb"});`;
  const verified = Biscuit.build(root.secretKey, code.source, { params: code.params }).verify(
    root.publicKey,
  );
  const [printed] = verified.print() as [string];
  assert.equal(printed.split("\n").length, 2, printed);
  assert.equal(
    printed,
    'note("ok\\");\\ncheck if true;\\rrole(\\"admin\\u{2028}\\u{202e}\\t\\0\\u{85}");\ncheck if note("a\\nb");',
  );
  // the escaped text parses back to the same strings
  const rebuilt = Biscuit.build(root.secretKey, printed).verify(root.publicKey);
  assert.deepStrictEqual(rebuilt.print(), [printed]);
  const ev = rebuilt.evaluate("allow if true;");
  assert.deepStrictEqual(
    ev.query("n($n) <- note($n)").map((f) => f.terms[0]),
    [{ t: "str", v: spoof }],
  );
});

test("error messages keep the reference printer's text", () => {
  const verified = Biscuit.build(root.secretKey, 'check if note("a\nb");').verify(root.publicKey);
  const result = verified.authorize("allow if true;");
  assert.equal(result.kind, "unauthorized");
  if (result.kind === "unauthorized") assert.equal(result.checks[0]?.rule, 'check if note("a\nb")');
});

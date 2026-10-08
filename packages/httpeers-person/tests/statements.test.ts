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

const expectConfirmation = {
  tag: "sandclaw/device-confirmation/v1",
  mesh: MESH,
  now: NOW,
} as const;

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
    expect(await verifyStatement(tampered, expectConfirmation)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
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
    expect(await verifyStatement(extra, expectConfirmation)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("does not accept one kind of statement as another", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    expect(
      await verifyStatement(signed, { tag: "sandclaw/person-merge/v1", mesh: MESH, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "wrong-tag",
    });
  });

  it("refuses a statement made for another group", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    expect(
      await verifyStatement(signed, { ...expectConfirmation, mesh: "12D3KooWOtherHub" }),
    ).toEqual({
      ok: false,
      reason: "wrong-mesh",
    });
  });

  it("accepts exactly 5 minutes, refuses one millisecond more", async () => {
    const key = await generatePersonKey();
    for (const offset of [-300_000, 300_000]) {
      const at = new Date(NOW.getTime() + offset);
      expect(
        await verifyStatement(await signStatement(confirmation(at), key), expectConfirmation),
      ).toMatchObject({
        ok: true,
      });
    }
    for (const offset of [-300_001, 300_001]) {
      const at = new Date(NOW.getTime() + offset);
      expect(
        await verifyStatement(await signStatement(confirmation(at), key), expectConfirmation),
      ).toEqual({
        ok: false,
        reason: "clock-skew",
      });
    }
  });

  it("NFC-normalizes values before signing", async () => {
    const key = await generatePersonKey();
    const profile: Profile = {
      tag: "sandclaw/profile/v1",
      name: "Ine\u0300s",
      updatedAt: NOW.toISOString(),
    };
    const signed = await signStatement(profile, key);
    const composed = { ...signed, statement: { ...signed.statement, name: "In\u00e8s" } };
    expect(await verifyStatement(composed, { tag: "sandclaw/profile/v1", now: NOW })).toMatchObject(
      { ok: true },
    );
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

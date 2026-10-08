import { describe, expect, it } from "vitest";
import { generatePersonKey } from "../src/keys.js";
import {
  type DeviceConfirmation,
  type DeviceInviteRequest,
  type MergeStatement,
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

  it("binds a merge to the person it merges away", async () => {
    const [claire, attacker] = [await generatePersonKey(), await generatePersonKey()];
    const merge = (from: string): MergeStatement => ({
      tag: "sandclaw/person-merge/v1",
      from,
      into: attacker.id,
      mesh: MESH,
      at: NOW.toISOString(),
    });
    const expectMerge = { tag: "sandclaw/person-merge/v1", mesh: MESH, now: NOW } as const;
    expect(
      await verifyStatement(await signStatement(merge(claire.id), attacker), expectMerge),
    ).toEqual({
      ok: false,
      reason: "wrong-signer",
    });
    expect(
      await verifyStatement(await signStatement(merge(claire.id), claire), expectMerge),
    ).toMatchObject({
      ok: true,
    });
  });

  it("binds an invite request to the person it names", async () => {
    const [claire, attacker] = [await generatePersonKey(), await generatePersonKey()];
    const request = (personId: string): DeviceInviteRequest => ({
      tag: "sandclaw/device-invite-request/v1",
      mesh: MESH,
      requester: "12D3KooWDevice",
      personId,
      at: NOW.toISOString(),
    });
    const expectReq = { tag: "sandclaw/device-invite-request/v1", mesh: MESH, now: NOW } as const;
    expect(
      await verifyStatement(await signStatement(request(claire.id), attacker), expectReq),
    ).toEqual({
      ok: false,
      reason: "wrong-signer",
    });
    expect(
      await verifyStatement(await signStatement(request(claire.id), claire), expectReq),
    ).toMatchObject({
      ok: true,
    });
  });

  it("fails closed when a kind that carries a mesh is verified without one", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    const noMesh = { tag: "sandclaw/device-confirmation/v1", now: NOW } as never;
    expect(await verifyStatement(signed, noMesh)).toEqual({ ok: false, reason: "wrong-mesh" });
  });

  describe("freshness", () => {
    const oldProfile = async (key: Awaited<ReturnType<typeof generatePersonKey>>) =>
      signStatement(
        {
          tag: "sandclaw/profile/v1",
          name: "Claire",
          updatedAt: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        } satisfies Profile,
        key,
      );

    it("skips the clock check with now: null, and checks it with a date", async () => {
      const signed = await oldProfile(await generatePersonKey());
      expect(
        await verifyStatement(signed, { tag: "sandclaw/profile/v1", now: null }),
      ).toMatchObject({
        ok: true,
      });
      expect(await verifyStatement(signed, { tag: "sandclaw/profile/v1", now: NOW })).toEqual({
        ok: false,
        reason: "clock-skew",
      });
    });

    it("types the verified statement by its tag", async () => {
      const signed = await oldProfile(await generatePersonKey());
      const result = await verifyStatement(signed, { tag: "sandclaw/profile/v1", now: null });
      if (result.ok) expect(result.signed.statement.name).toBe("Claire");
      else throw new Error(result.reason);
    });

    it("accepts only strict ISO-8601 UTC times, even with now: null", async () => {
      const key = await generatePersonKey();
      const withTime = (updatedAt: string) =>
        signStatement({ tag: "sandclaw/profile/v1", name: "C", updatedAt }, key);
      for (const bad of [
        "2026-10-08T10:00:00",
        "2026-10-08T10:00:00+00:00",
        "Thu, 08 Oct 2026 10:00:00 GMT",
      ]) {
        expect(
          await verifyStatement(await withTime(bad), { tag: "sandclaw/profile/v1", now: null }),
        ).toEqual({ ok: false, reason: "malformed" });
      }
      for (const good of [new Date().toISOString(), "2026-10-08T10:00:00Z"]) {
        expect(
          await verifyStatement(await withTime(good), { tag: "sandclaw/profile/v1", now: null }),
        ).toMatchObject({ ok: true });
      }
    });

    it("throws a TypeError for an invalid now, since that is the caller's bug", async () => {
      const signed = await oldProfile(await generatePersonKey());
      await expect(
        verifyStatement(signed, { tag: "sandclaw/profile/v1", now: new Date("x") }),
      ).rejects.toThrow(TypeError);
    });
  });

  it("accepts a signature only in its canonical 64-byte form", async () => {
    const key = await generatePersonKey();
    const signed = await signStatement(confirmation(), key);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = signed.signature.at(-1) as string;
    const twin = signed.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    for (const signature of [signed.signature.slice(0, 10), twin]) {
      expect(await verifyStatement({ ...signed, signature }, expectConfirmation)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses to sign a statement of the wrong shape", async () => {
    const key = await generatePersonKey();
    const extra = { ...confirmation(), role: "admin" } as unknown as DeviceConfirmation;
    const undef = { ...confirmation(), issuedAt: undefined } as unknown as DeviceConfirmation;
    await expect(signStatement(extra, key)).rejects.toThrow(TypeError);
    await expect(signStatement(undef, key)).rejects.toThrow(TypeError);
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
      { ...good, statement: { ...good.statement, tag: "constructor" } },
      { ...good, statement: { ...good.statement, tag: "__proto__" } },
      { ...good, statement: { ...good.statement, tag: "toString" } },
      { ...good, statement: { ...good.statement, tag: 42 } },
    ];
    for (const input of garbage) {
      const result = await verifyStatement(input, expectConfirmation);
      expect(result.ok).toBe(false);
    }
  });
});

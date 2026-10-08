import { describe, expect, it } from "vitest";
import { fromBase64Url } from "../src/encoding.js";
import { checkReveal, commitment, linkCode, newNonce } from "../src/link-code.js";

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

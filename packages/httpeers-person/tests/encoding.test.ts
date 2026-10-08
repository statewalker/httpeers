import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  fromBase64Url,
  lengthPrefixed,
  toBase64Url,
  utf8,
} from "../src/encoding.js";

describe("base64url", () => {
  it("round-trips every byte value without padding", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it("returns undefined for text that is not base64url", () => {
    expect(fromBase64Url("abc+")).toBeUndefined();
    expect(fromBase64Url("a")).toBeUndefined(); // a length of 1 mod 4 is never valid
    expect(fromBase64Url("é")).toBeUndefined();
  });
});

describe("lengthPrefixed", () => {
  it("prefixes each part with its 4-byte big-endian length", () => {
    expect(lengthPrefixed(["ab", Uint8Array.of(7)])).toEqual(
      Uint8Array.of(0, 0, 0, 2, 0x61, 0x62, 0, 0, 0, 1, 7),
    );
  });

  it("keeps ['ab','c'] and ['a','bc'] apart", () => {
    expect(lengthPrefixed(["ab", "c"])).not.toEqual(lengthPrefixed(["a", "bc"]));
  });
});

describe("canonicalJson", () => {
  it("sorts keys, so key order does not change the bytes", () => {
    expect(canonicalJson({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
    expect(canonicalJson({ a: "1", b: "2" })).toBe(canonicalJson({ b: "2", a: "1" }));
  });

  it("NFC-normalizes values", () => {
    const composed = "Inès"; // precomposed è (U+00E8)
    const decomposed = "Inès"; // e (U+0065) + combining grave (U+0300)
    expect(canonicalJson({ name: decomposed })).toBe(canonicalJson({ name: composed }));
    expect(utf8(canonicalJson({ name: decomposed }))).toEqual(utf8(`{"name":"${composed}"}`));
  });
});

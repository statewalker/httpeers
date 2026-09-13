/**
 * The join blob (`src/browser/join-blob.ts`) -- how a mesh whose hub is a
 * BROWSER PAGE tells a joining page where it is.
 *
 * Pure string/URL logic, so it runs under Node exactly as it runs in a tab:
 * `btoa`/`atob`, `TextEncoder`, `URL` and `URLSearchParams` are all
 * available in both, and this module deliberately uses nothing else.
 *
 * THE DECODE TESTS MATTER MORE THAN THE ENCODE ONES. Everything here is
 * typed or pasted by a person -- a link copied out of one tab and into
 * another's address bar or join box -- so a malformed value is an ordinary
 * event, not an exceptional one, and "the link you pasted is missing its
 * hub peer id" is a fixable complaint where `undefined is not an object` is
 * not.
 */
import { describe, expect, it } from "vitest";
import type { JoinBlob } from "../src/join-blob.js";
import {
  decodeJoinBlob,
  encodeJoinBlob,
  JOIN_BLOB_PARAM,
  joinUrl,
  readJoinInputFromSearch,
  readJoinInputFromText,
} from "../src/join-blob.js";

const BLOB: JoinBlob = {
  relayAddrs: ["/ip4/127.0.0.1/tcp/9090/ws/p2p/12D3KooWRelay000000000000000000000000000000000000"],
  hubPeerId: "12D3KooWHub00000000000000000000000000000000000000",
  invitationId: "6f1f4b7e-0c2a-4a1f-9f4c-8a2b1c3d4e5f",
};

describe("encodeJoinBlob / decodeJoinBlob", () => {
  it("round-trips every field", () => {
    expect(decodeJoinBlob(encodeJoinBlob(BLOB))).toEqual(BLOB);
  });

  it("encodes to a URL-safe, unpadded alphabet -- so it survives a copy-paste unquoted", () => {
    // A blob long enough to force padding in standard base64, and content
    // chosen to produce bytes that map to `+` and `/` there.
    const encoded = encodeJoinBlob({ ...BLOB, invitationId: "ÿÿÿ?>?>~~~" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("survives a non-ASCII relay host -- `btoa` alone would have thrown", () => {
    // A relay host can be a hostname an operator supplied (`RELAY_HOST`),
    // and a hostname can be an IDN. UTF-8 first, then base64.
    const idn: JoinBlob = { ...BLOB, relayAddrs: ["/dns4/relais-café.example/tcp/443/wss"] };
    expect(decodeJoinBlob(encodeJoinBlob(idn))).toEqual(idn);
  });

  it("tolerates surrounding whitespace, which a paste routinely carries", () => {
    expect(decodeJoinBlob(`  ${encodeJoinBlob(BLOB)}\n`)).toEqual(BLOB);
  });

  it("rejects something that is not a blob at all, and says so", () => {
    expect(() => decodeJoinBlob("hello")).toThrow(/not a join link/);
  });

  it("names the missing field rather than failing on a property access", () => {
    const missing = (partial: Record<string, unknown>): (() => unknown) => {
      const encoded = Buffer.from(JSON.stringify(partial), "utf8").toString("base64url");
      return () => decodeJoinBlob(encoded);
    };

    expect(missing({ hubPeerId: "h", invitationId: "i" })).toThrow(/no relayAddrs/);
    expect(missing({ relayAddrs: [], hubPeerId: "h", invitationId: "i" })).toThrow(/no relayAddrs/);
    expect(missing({ relayAddrs: ["/x"], invitationId: "i" })).toThrow(/no hubPeerId/);
    expect(missing({ relayAddrs: ["/x"], hubPeerId: "h" })).toThrow(/no invitationId/);
  });
});

describe("joinUrl", () => {
  it("attaches the blob to the page's URL as a single parameter", () => {
    const url = new URL(joinUrl("http://127.0.0.1:5175/", BLOB));

    expect(url.origin).toBe("http://127.0.0.1:5175");
    expect(url.pathname).toBe("/");
    expect(decodeJoinBlob(url.searchParams.get(JOIN_BLOB_PARAM) ?? "")).toEqual(BLOB);
  });

  it("round-trips back out through the page's own reader", () => {
    const url = new URL(joinUrl("http://127.0.0.1:5176/", BLOB));
    const input = readJoinInputFromSearch(url.search);

    expect(input).toEqual({ kind: "blob", blob: BLOB });
  });
});

describe("readJoinInputFromSearch", () => {
  it("returns null when the page was opened with neither parameter", () => {
    expect(readJoinInputFromSearch("")).toBeNull();
    expect(readJoinInputFromSearch("?something=else")).toBeNull();
  });

  it("still reads a bare `?invite=` -- the Node hub's mesh is not going anywhere", () => {
    expect(readJoinInputFromSearch("?invite=abc-123")).toEqual({
      kind: "invitation-id",
      invitationId: "abc-123",
    });
  });

  it("prefers a blob over a bare invite when both are somehow present", () => {
    // The blob names its own mesh; the bare id names whichever mesh
    // `httpeers.json` does. If a link carried both, the one that came from a
    // hub -- with the mesh identity attached -- is the one that can be acted
    // on unambiguously.
    const search = `?invite=abc&${JOIN_BLOB_PARAM}=${encodeJoinBlob(BLOB)}`;
    expect(readJoinInputFromSearch(search)).toEqual({ kind: "blob", blob: BLOB });
  });

  it("treats an empty parameter as absent", () => {
    expect(readJoinInputFromSearch("?invite=&join=")).toBeNull();
  });
});

describe("readJoinInputFromText -- what someone pastes into a join box", () => {
  it("accepts a whole join link, because that is what gets copied", () => {
    expect(readJoinInputFromText(joinUrl("http://127.0.0.1:5175/", BLOB))).toEqual({
      kind: "blob",
      blob: BLOB,
    });
  });

  it("accepts a bare blob", () => {
    expect(readJoinInputFromText(encodeJoinBlob(BLOB))).toEqual({ kind: "blob", blob: BLOB });
  });

  it("accepts a bare invitation id", () => {
    expect(readJoinInputFromText(" 6f1f4b7e-0c2a-4a1f-9f4c-8a2b1c3d4e5f ")).toEqual({
      kind: "invitation-id",
      invitationId: "6f1f4b7e-0c2a-4a1f-9f4c-8a2b1c3d4e5f",
    });
  });

  it("returns null for an empty box rather than throwing at someone", () => {
    expect(readJoinInputFromText("   ")).toBeNull();
  });

  it("complains legibly about a link with no join parameter in it", () => {
    expect(() => readJoinInputFromText("http://127.0.0.1:5175/")).toThrow(/is it the whole link/);
  });
});

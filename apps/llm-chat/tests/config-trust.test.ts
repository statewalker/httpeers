import { describe, expect, it } from "vitest";
import { judgeConfigUrl } from "../src/core/config-trust.js";

const PAGE = "https://llm-chat.httpeers.net/mesh.html";
const EDGE = "https://llm-chat.httpeers.net/peers/12D3KooWHub/";

describe("judgeConfigUrl", () => {
  it("trusts a same-origin URL", () => {
    expect(
      judgeConfigUrl("https://llm-chat.httpeers.net/config.json", {
        pageUrl: PAGE,
        edgeBase: null,
      }),
    ).toEqual({ trusted: true, reason: "same-origin" });
  });

  it("trusts a relative URL", () => {
    expect(judgeConfigUrl("./config.json", { pageUrl: PAGE, edgeBase: null }).trusted).toBe(true);
  });

  it("trusts a URL under the page's own mesh edge", () => {
    expect(judgeConfigUrl(`${EDGE}llm/config.json`, { pageUrl: PAGE, edgeBase: EDGE })).toEqual({
      trusted: true,
      reason: "mesh-edge",
    });
  });

  it("does NOT trust a different port", () => {
    expect(
      judgeConfigUrl("https://llm-chat.httpeers.net:8443/c.json", { pageUrl: PAGE, edgeBase: null })
        .trusted,
    ).toBe(false);
  });

  it("does NOT trust a different scheme", () => {
    expect(
      judgeConfigUrl("http://llm-chat.httpeers.net/c.json", { pageUrl: PAGE, edgeBase: null })
        .trusted,
    ).toBe(false);
  });

  it("does NOT trust a host that merely ends with the page's host", () => {
    expect(
      judgeConfigUrl("https://evil-llm-chat.httpeers.net/c.json", { pageUrl: PAGE, edgeBase: null })
        .trusted,
    ).toBe(false);
  });

  it("does NOT trust a userinfo prefix dressed up as the page's host", () => {
    expect(
      judgeConfigUrl("https://llm-chat.httpeers.net@evil.example/c.json", {
        pageUrl: PAGE,
        edgeBase: null,
      }).trusted,
    ).toBe(false);
  });

  it("does NOT trust a path that escapes the edge base with ..", () => {
    expect(
      judgeConfigUrl(`${EDGE}../../elsewhere/c.json`, { pageUrl: PAGE, edgeBase: EDGE }).trusted,
    ).toBe(false);
  });

  it("does NOT trust another peer's mount under the same edge", () => {
    const other = "https://llm-chat.httpeers.net/peers/12D3KooWOther/llm/c.json";
    expect(judgeConfigUrl(other, { pageUrl: PAGE, edgeBase: EDGE }).trusted).toBe(false);
  });

  it("reports the untrusted ORIGIN, so the dialog can name it", () => {
    const verdict = judgeConfigUrl("https://evil.example/c.json", {
      pageUrl: PAGE,
      edgeBase: null,
    });
    expect(verdict).toEqual({ trusted: false, origin: "https://evil.example" });
  });

  it("does not trust a non-http scheme at all", () => {
    for (const url of ["javascript:alert(1)", "data:application/json,{}", "file:///etc/passwd"]) {
      expect(judgeConfigUrl(url, { pageUrl: PAGE, edgeBase: null }).trusted, url).toBe(false);
    }
  });

  it('reports the WHATWG opaque origin "null" for a non-http scheme -- ChatApp is what substitutes the raw URL for display, not this function', () => {
    for (const url of ["javascript:alert(1)", "data:application/json,{}", "file:///etc/passwd"]) {
      expect(judgeConfigUrl(url, { pageUrl: PAGE, edgeBase: null })).toEqual({
        trusted: false,
        origin: "null",
      });
    }
  });

  it("does not throw on an unparseable URL -- it distrusts it", () => {
    expect(judgeConfigUrl("::::", { pageUrl: PAGE, edgeBase: null }).trusted).toBe(false);
  });

  it("does NOT trust an encoded slash/backslash in the edge-base path, even though it stays under the mount today", () => {
    expect(
      judgeConfigUrl(`${EDGE}..%2f..%2felsewhere/c.json`, { pageUrl: PAGE, edgeBase: EDGE })
        .trusted,
    ).toBe(false);
    expect(
      judgeConfigUrl(`${EDGE}llm%5cconfig.json`, { pageUrl: PAGE, edgeBase: EDGE }).trusted,
    ).toBe(false);
  });
});

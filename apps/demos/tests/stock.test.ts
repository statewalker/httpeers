/**
 * The image stock, with no network.
 *
 * `loadStockImages` takes its `fetch`, which is the only reason these
 * assertions are possible: the failure modes that matter here are a stock that
 * rate-limits, redirects to an HTML error page, or answers half the requests,
 * and none of them can be provoked reliably against the real service.
 */

import { describe, expect, it } from "vitest";
import { loadStockImages, STOCK_IMAGE_COUNT } from "../src/shared/stock.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A stock that always answers with the same tiny JPEG, recording what it was asked for. */
function fakeStock(): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof globalThis.fetch,
  };
}

describe("loadStockImages", () => {
  it("fetches the requested count and keeps the bytes", async () => {
    const stock = fakeStock();
    const loaded = await loadStockImages({ fetch: stock.fetch, count: 3 });

    expect(loaded).toHaveLength(3);
    expect(stock.urls).toHaveLength(3);
    for (const { info, bytes } of loaded) {
      expect(bytes).toEqual(JPEG);
      expect(info.size).toBe(JPEG.length);
      // Taken from the RESPONSE, never assumed: a stock may serve png or webp.
      expect(info.contentType).toBe("image/jpeg");
    }
  });

  it("asks for a different picture every time", async () => {
    const stock = fakeStock();
    await loadStockImages({ fetch: stock.fetch, count: 4 });
    await loadStockImages({ fetch: stock.fetch, count: 4 });

    // Distinct seeds within one call AND across calls -- a reload that showed
    // the same four pictures would look like a cache bug.
    expect(new Set(stock.urls).size).toBe(8);
    for (const url of stock.urls)
      expect(url).toMatch(/^https:\/\/picsum\.photos\/seed\/[^/]+\/\d+\/\d+$/);
  });

  it("ids are unique, so two pictures never collide in the catalogue", async () => {
    const loaded = await loadStockImages({ fetch: fakeStock().fetch, count: 5 });
    expect(new Set(loaded.map((l) => l.info.id)).size).toBe(5);
  });

  it("keeps the pictures that loaded when one request fails", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 2) return new Response("rate limited", { status: 429 });
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof globalThis.fetch;

    // PARTIAL, NOT TOTAL. One bad response must not cost the whole gallery.
    expect(await loadStockImages({ fetch: flaky, count: 3 })).toHaveLength(2);
  });

  it("refuses an HTML error page served with status 200", async () => {
    // The failure this exists for: a stock under load answers 200 with HTML.
    // Serving that as image/jpeg puts a broken picture in every peer's gallery
    // with nothing anywhere saying why.
    const html = (async () =>
      new Response("<html>too many requests</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof globalThis.fetch;

    expect(await loadStockImages({ fetch: html, count: 2 })).toEqual([]);
  });

  it("returns empty rather than throwing when the stock is unreachable", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;

    // The caller falls back to drawn pictures; a thrown error would take the
    // page down instead, and a provider with no catalogue is the worse demo.
    await expect(loadStockImages({ fetch: offline, count: 2 })).resolves.toEqual([]);
  });

  it("defaults to a small count, because each one is a round trip before the gallery renders", async () => {
    const stock = fakeStock();
    await loadStockImages({ fetch: stock.fetch });
    expect(stock.urls).toHaveLength(STOCK_IMAGE_COUNT);
    expect(STOCK_IMAGE_COUNT).toBeLessThanOrEqual(6);
  });
});

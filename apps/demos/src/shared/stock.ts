/**
 * Pictures pulled from a public image stock, so this peer serves bytes it
 * fetched from the open web rather than shapes it drew itself.
 *
 * WHY THIS MATTERS FOR THE DEMO. A peer that serves its own build artefacts
 * proves routing. A peer that serves something it went and got, to another peer
 * that could have gone and got it itself but asks this one instead, is the
 * actual claim: the mesh moves bytes between participants, and a participant is
 * whatever holds the bytes. Real photographs also make the streaming visible --
 * a 20 KB JPEG arrives in chunks where a flat-coloured PNG compresses to almost
 * nothing and lands in one.
 *
 * LOREM PICSUM, NOT UNSPLASH. Unsplash's `source.unsplash.com/random` endpoint
 * -- the one that needed no key -- is retired and answers 503; what is left is
 * an API that requires a client id, and a public page cannot hold a credential.
 * Picsum needs none. It was also the prototype's choice, for a reason that
 * still holds and was re-verified rather than assumed: it answers cross-origin
 * requests with `access-control-allow-origin: *` on BOTH the 302 and the CDN it
 * redirects to. Without that the bytes are unreadable to script, and bytes this
 * peer cannot read are bytes it cannot re-serve.
 *
 * FAILURE IS PARTIAL, NEVER TOTAL. A stock that rate-limits, 500s, or serves an
 * HTML error page for one request must not cost the whole gallery; and if every
 * request fails this returns an empty list rather than throwing, so the caller
 * can fall back to drawn pictures instead of the page dying. A peer advertising
 * an image service with nothing behind it is the worse demonstration.
 */

import type { ImageInfo } from "./images.js";

/** How many pictures a fresh page pulls. Small: each one is a network round trip before the gallery renders. */
export const STOCK_IMAGE_COUNT = 4;

/** Lorem Picsum -- see the module comment for why this one and not Unsplash. */
const STOCK_BASE = "https://picsum.photos/seed";

/** Wide enough to look like a photograph, small enough that four are a fast page load and a cheap mesh transfer. */
const WIDTH = 600;
const HEIGHT = 400;

export interface LoadStockImagesInit {
  /** Injected so tests exercise the real code path without a network. */
  fetch?: typeof globalThis.fetch;
  count?: number;
}

/** One fetched picture: its catalogue entry, and the bytes to write into the provider's files. */
export interface LoadedStockImage {
  info: ImageInfo;
  bytes: Uint8Array;
}

/**
 * A seed nobody else is using this second, so a reload asks the stock for a
 * different picture -- and two pictures in one gallery are never the same.
 *
 * `Math.random` IS CORRECT HERE, which is worth saying because it is wrong
 * almost everywhere else in this codebase. A seed is a cache key, not a
 * credential: nothing is authorised by it, and a collision costs a duplicate
 * photograph. Invitation ids, which ARE bearer credentials, come from the
 * platform CSPRNG and must keep doing so.
 */
function freshSeed(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadStockImages(init: LoadStockImagesInit = {}): Promise<LoadedStockImage[]> {
  const doFetch = init.fetch ?? globalThis.fetch;
  const count = init.count ?? STOCK_IMAGE_COUNT;

  const settled = await Promise.allSettled(
    Array.from({ length: count }, async (): Promise<LoadedStockImage> => {
      const seed = freshSeed();
      const res = await doFetch(`${STOCK_BASE}/${seed}/${WIDTH}/${HEIGHT}`);
      if (!res.ok) throw new Error(`stock image ${seed}: HTTP ${res.status}`);

      // A stock under load answers with an HTML error page and status 200.
      // Serving that as `image/jpeg` would put a broken picture in every peer's
      // gallery, with nothing anywhere saying why.
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`stock image ${seed}: expected an image, got "${contentType}"`);
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        info: {
          id: `stock-${seed}`,
          title: `From an image stock (${WIDTH}x${HEIGHT})`,
          contentType,
          size: bytes.length,
        },
        bytes,
      };
    }),
  );

  const loaded: LoadedStockImage[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") {
      console.warn("images page: a stock image did not load:", outcome.reason);
      continue;
    }
    loaded.push(outcome.value);
  }
  return loaded;
}

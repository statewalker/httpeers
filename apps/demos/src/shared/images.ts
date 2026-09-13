/**
 * `GET /images` / `GET /images/{id}` — the image peer's own service (Task
 * 12, design record §5.5): "a provider running in a browser," the thing
 * nothing in this record has done yet. This module is the pure, isomorphic
 * half of it — no `node:fs`, no browser API, no libp2p — so it typechecks
 * and unit-tests under plain Node exactly like `search.ts` does; only the
 * PAGE (`../pages/image-peer/main.ts`) and the test fixture loader
 * (`image-fixtures.node.ts`) know how bytes actually get onto disk or into
 * a bundle.
 *
 * THE SEAM: `ImagesEndpointInit.files` is a bare `FilesApi`
 * (`@statewalker/webrun-files`) — this module never imports
 * `@statewalker/webrun-files-mem` or any other concrete implementation, so
 * swapping the in-memory fixture store for OPFS or a real file picker later
 * is a change to what gets passed as `files`, never to `createImagesEndpoint`
 * or to `IMAGES_ACCESS_TREE`.
 *
 * TITLES GO IN THE JSON LIST, NEVER IN A HEADER. Same reasoning as
 * `search.ts`'s own module comment: HTTP header values are latin1 by
 * specification, so a title carrying an accented letter or an emoji (the
 * fixture set carries both, deliberately — see `image-fixtures/manifest.json`)
 * would throw or be mangled before the request ever reached the wire if it
 * were hoisted into a header. `GET /images` returns titles in the body;
 * `GET /images/{id}` returns ONLY bytes and a `content-type`, no title at
 * all — there was never a reason to put one there.
 *
 * STREAMING IS NOT `files.read()`'S DEFAULT SHAPE — IT IS THIS HANDLER'S
 * JOB. `MemFilesApi.read(path)` with no `{ length }` yields the WHOLE file
 * as a single `Uint8Array` in one iteration; calling it that way and handing
 * the result to `new Response(...)` would "work" (correct bytes, wrong
 * property) while defeating the one thing this page exists to demonstrate
 * (browser-to-browser response streaming over WebRTC — design note 20, "4
 * chunks sent, 4 chunks received"). `createImagesEndpoint`'s `GET
 * /images/:id` handler instead drives a `ReadableStream` whose `pull`
 * repeatedly calls `files.read(path, { start, length: chunkSize })` —
 * `MemFilesApi.read` honours `start`/`length` and yields at most one
 * bounded chunk per call (verified by reading `mem-files-api.ts` directly),
 * so this handler alone controls how many chunks a client observes,
 * regardless of what the underlying `FilesApi` implementation would have
 * handed back for an unbounded read.
 */
import type { FetchHandler } from "@statewalker/httpeers-core";
import type { FilesApi } from "@statewalker/webrun-files";
import { Hono } from "hono";

/** One fixture's public metadata — exactly what `GET /images` lists, and what a client needs to then ask for `GET /images/{id}`. No title (or any other free text) belongs outside this JSON shape -- see the module comment. */
export interface ImageInfo {
  id: string;
  title: string;
  contentType: string;
  size: number;
}

/** Where a given image's bytes live in `files` -- one flat file per id, at the root. Exported so a caller building `files` (a fixture loader, a future OPFS-backed one) and this module agree on the same layout without duplicating the string. */
export function imagePath(id: string): string {
  return `/${id}`;
}

/** Streamed chunk size when nothing else is specified. Large enough that a real fixture image is normally served in one or two chunks in production; a test that wants to OBSERVE multiple chunks passes a small `chunkSize` explicitly rather than relying on fixture size alone -- see `tests/images.test.ts`. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

export interface ImagesEndpointInit {
  /** Where image bytes actually live -- see the module comment's "THE SEAM". */
  files: FilesApi;
  /** This provider's own catalogue -- `GET /images`'s exact response, and what `GET /images/{id}` is willing to serve (an id absent here is a 404, never a peek at `files` for anything not listed). */
  images: ImageInfo[];
  /** Bytes requested per `files.read` call while streaming a body. Defaults to `DEFAULT_CHUNK_SIZE`. */
  chunkSize?: number;
}

/** `GET /images` (list) and `GET /images/{id}` (streamed bytes) -- see the module comment. Capability gating is `IMAGES_ACCESS_TREE`'s job, not this handler's (same split `search.ts`'s `createSearchEndpoint` uses against `policy.ts`). */
export function createImagesEndpoint(init: ImagesEndpointInit): FetchHandler {
  const chunkSize = init.chunkSize ?? DEFAULT_CHUNK_SIZE;
  // RESOLVED PER REQUEST, NOT SNAPSHOTTED. `init.images` is the provider's
  // live catalogue and callers append to it -- the image-peer page adds
  // pictures pulled from an image stock, chosen from a file, or just
  // photographed. A Map built here would freeze the catalogue at construction,
  // so a later addition would appear in `GET /images` and 404 on
  // `GET /images/{id}`: the listing and what is servable would disagree, which
  // reads as a corrupt provider rather than a stale index.
  //
  // A linear scan is right for this shape of data -- a gallery is tens of
  // entries, not thousands -- and keeping a Map in sync with an array someone
  // else owns is the kind of bookkeeping that goes wrong quietly.
  const lookup = (id: string): ImageInfo | undefined => init.images.find((img) => img.id === id);
  const app = new Hono();

  app.get("/images", (c) => c.json({ images: init.images }));

  app.get("/images/:id", (c) => {
    const id = c.req.param("id");
    const meta = lookup(id);
    if (meta == null) {
      return c.json({ error: `no such image: ${id}` }, 404);
    }

    const path = imagePath(id);
    let offset = 0;

    // A `ReadableStream` whose `pull` is called again only once the
    // consumer has actually drained what was already enqueued -- backpressure
    // comes for free from the platform's own stream implementation; nothing
    // here needs to track it manually.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= meta.size) {
          controller.close();
          return;
        }
        const remaining = meta.size - offset;
        const length = Math.min(chunkSize, remaining);
        let enqueued = false;
        for await (const part of init.files.read(path, { start: offset, length })) {
          controller.enqueue(part);
          offset += part.length;
          enqueued = true;
        }
        // Defensive only: `files` reported `meta.size` bytes at construction
        // time but the read at `offset` came back empty (the backing store
        // shrank or the entry vanished underneath this stream) -- close
        // rather than spin `pull` forever re-requesting a range that will
        // never yield anything.
        if (!enqueued) controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": meta.contentType,
        "content-length": String(meta.size),
      },
    });
  });

  return app.fetch as FetchHandler;
}

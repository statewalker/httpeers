import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureModel, isUpToDate, pickRemoteFile, resolveUrl } from "../src/download.js";

const TREE = [
  { path: "README.md", size: 12, lfs: null },
  { path: "model-q4_k_m.gguf", size: 1234567, lfs: { oid: "abc123" } },
];

describe("resolveUrl", () => {
  it("builds the Hugging Face resolve URL", () => {
    expect(
      resolveUrl({
        id: "m",
        repo: "Org/Repo-GGUF",
        file: "model-q4_k_m.gguf",
        ctx: 4096,
        fileSize: 1234567,
      }),
    ).toBe("https://huggingface.co/Org/Repo-GGUF/resolve/main/model-q4_k_m.gguf");
  });
});

describe("pickRemoteFile", () => {
  it("reads the size and the LFS oid as the sha256", () => {
    expect(pickRemoteFile(TREE, "model-q4_k_m.gguf")).toEqual({ size: 1234567, sha256: "abc123" });
  });

  it("returns a null sha256 for a non-LFS file rather than inventing one", () => {
    expect(pickRemoteFile(TREE, "README.md").sha256).toBeNull();
  });

  it("throws naming BOTH the repo file and what the tree actually holds", () => {
    expect(() => pickRemoteFile(TREE, "missing.gguf")).toThrow(/missing\.gguf/);
    expect(() => pickRemoteFile(TREE, "missing.gguf")).toThrow(/model-q4_k_m\.gguf/);
  });
});

describe("isUpToDate", () => {
  it("is false when nothing is on disk", () => {
    expect(isUpToDate(null, { size: 10, sha256: "a" })).toBe(false);
  });

  it("is false when the size differs -- a truncated download must not be served", () => {
    expect(isUpToDate({ size: 9, sha256: "a" }, { size: 10, sha256: "a" })).toBe(false);
  });

  it("is false when the sha differs", () => {
    expect(isUpToDate({ size: 10, sha256: "b" }, { size: 10, sha256: "a" })).toBe(false);
  });

  it("is true on an exact match", () => {
    expect(isUpToDate({ size: 10, sha256: "a" }, { size: 10, sha256: "a" })).toBe(true);
  });

  it("falls back to size alone when the remote has no sha", () => {
    expect(isUpToDate({ size: 10, sha256: null }, { size: 10, sha256: null })).toBe(true);
  });
});

describe("ensureModel", () => {
  // The brief's ModelEntry literal predates Task 4's `fileSize` field; it is
  // added here (per controller ruling) so this typechecks against the
  // current ModelEntry. Its value is the fake body's length, matching what
  // the fake tree API below reports.
  const entry = { id: "tiny", repo: "Org/Repo", file: "tiny.gguf", ctx: 4096, fileSize: 5 };

  function fakeFetch(body: string): typeof globalThis.fetch {
    return (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/api/models/")) {
        return new Response(
          JSON.stringify([{ path: "tiny.gguf", size: body.length, lfs: { oid: "deadbeef" } }]),
        );
      }
      return new Response(body, { headers: { "content-length": String(body.length) } });
    }) as unknown as typeof globalThis.fetch;
  }

  it("downloads the file and returns a lock entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-"));
    const lock = await ensureModel(entry, { dir, fetch: fakeFetch("hello"), log: () => {} });
    expect(lock).toMatchObject({ id: "tiny", size: 5, sha256: "deadbeef" });
    expect(await readFile(join(dir, "tiny", "tiny.gguf"), "utf8")).toBe("hello");
  });

  it("does not re-download a file that already matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-"));
    let downloads = 0;
    const counting = ((url: string | URL) => {
      if (!String(url).includes("/api/models/")) downloads += 1;
      return fakeFetch("hello")(url as never);
    }) as unknown as typeof globalThis.fetch;
    const first = await ensureModel(entry, { dir, fetch: counting, log: () => {} });
    // `previous` is what Task 9's CLI would read back from
    // `manifest.lock.json` on a later run and hand to `ensureModel` -- this
    // module never persists it itself. Passing the prior call's own
    // `LockEntry` here is exactly that contract: "the last run recorded
    // this size and sha256 for this model."
    await ensureModel(entry, { dir, fetch: counting, log: () => {}, previous: first });
    expect(downloads).toBe(1);
  });

  it("leaves no partial file behind when the fetch itself fails before streaming starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-"));
    const failing = (async (url: string | URL) => {
      if (String(url).includes("/api/models/")) return fakeFetch("hello")(url as never);
      throw new Error("connection reset");
    }) as unknown as typeof globalThis.fetch;
    await expect(ensureModel(entry, { dir, fetch: failing, log: () => {} })).rejects.toThrow(
      /connection reset/,
    );
    await expect(stat(join(dir, "tiny", "tiny.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dir, "tiny", "tiny.gguf.part"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves no partial file behind when the connection drops mid-stream, after bytes have already landed on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-"));
    // This is the scenario the brief calls out as the one that matters: a
    // `Response` is returned successfully and some bytes are actually
    // written to the `.part` file before the body stream errors out. The
    // earlier "fetch throws" test never reaches `createWriteStream`, so it
    // cannot exercise the cleanup of an ALREADY-PARTIALLY-WRITTEN file --
    // this one does.
    const droppingMidStream = (async (url: string | URL) => {
      if (String(url).includes("/api/models/")) return fakeFetch("hello")(url as never);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("connection reset"));
          },
        }),
        { headers: { "content-length": "5" } },
      );
    }) as unknown as typeof globalThis.fetch;
    await expect(
      ensureModel(entry, { dir, fetch: droppingMidStream, log: () => {} }),
    ).rejects.toThrow(/connection reset/);
    await expect(stat(join(dir, "tiny", "tiny.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dir, "tiny", "tiny.gguf.part"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

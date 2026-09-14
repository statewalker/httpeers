/**
 * Turning a chosen file into something servable.
 *
 * `File` is a platform type, not a DOM one, so these run under plain Node
 * exactly like the page does in a browser — no jsdom, no harness.
 */

import { describe, expect, it } from "vitest";
import { fileToImage } from "../src/shared/local-image.js";

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const file = (name: string, type: string, bytes = BYTES) =>
  new File([bytes as BlobPart], name, { type });

describe("fileToImage", () => {
  it("keeps the bytes exactly, and re-encodes nothing", async () => {
    const { info, bytes } = await fileToImage(file("holiday.jpg", "image/jpeg"));
    expect(bytes).toEqual(BYTES);
    expect(info.size).toBe(BYTES.length);
    expect(info.contentType).toBe("image/jpeg");
  });

  it("titles it by filename, without the extension", async () => {
    expect((await fileToImage(file("a nice photo.png", "image/png"))).info.title).toBe(
      "a nice photo",
    );
    // Only the LAST extension goes; a dotted name keeps the rest of itself.
    expect((await fileToImage(file("2026.09.14.jpeg", "image/jpeg"))).info.title).toBe(
      "2026.09.14",
    );
  });

  it("falls back to a title rather than an empty caption", async () => {
    expect((await fileToImage(file(".gitignore-ish.png", "image/png"))).info.title).toBe(
      ".gitignore-ish",
    );
    expect((await fileToImage(file(".png", "image/png"))).info.title).toBe("Untitled");
  });

  it("accepts a file the browser could not type, as jpeg", async () => {
    // Some Android pickers hand over a File with type "". Refusing it would
    // reject real photographs; guessing jpeg is what the prototype settled on.
    const { info } = await fileToImage(file("DCIM0001", ""));
    expect(info.contentType).toBe("image/jpeg");
  });

  it("refuses a file that declares itself as something other than an image", async () => {
    // Serving a PDF as image/jpeg puts a broken picture in every peer's
    // gallery, with nothing anywhere saying why.
    await expect(fileToImage(file("report.pdf", "application/pdf"))).rejects.toThrow(
      /not an image/,
    );
  });

  it("gives every pick its own id, so the same file twice is two pictures", async () => {
    const a = await fileToImage(file("same.jpg", "image/jpeg"));
    const b = await fileToImage(file("same.jpg", "image/jpeg"));
    // Not a silent replacement: the catalogue is keyed by id, and one
    // overwriting the other would make a picture vanish from a peer mid-session.
    expect(a.info.id).not.toBe(b.info.id);
  });
});

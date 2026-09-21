import { describe, expect, it } from "vitest";
import { bodyOf } from "../src/http-body.js";

describe("bodyOf", () => {
  it("returns null for a GET", async () => {
    expect(await bodyOf(new Request("http://x/"))).toBeNull();
  });

  it("returns null for a HEAD", async () => {
    expect(await bodyOf(new Request("http://x/", { method: "HEAD" }))).toBeNull();
  });

  it("streams where the runtime has Request.body", async () => {
    const post = new Request("http://x/", { method: "POST", body: "ping" });
    const body = await bodyOf(post);
    expect(body).toBeInstanceOf(ReadableStream);
  });

  // FIREFOX HAS NO `Request.prototype.body` (checked against 155). Hiding the
  // property is exactly what that browser's Request looks like, and forwarding
  // `undefined` is what sent every POST on empty.
  it("buffers where the runtime has no Request.body (Firefox)", async () => {
    const post = new Request("http://x/", { method: "POST", body: "ping" });
    Object.defineProperty(post, "body", { value: undefined });
    const body = await bodyOf(post);
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(body as ArrayBuffer)).toBe("ping");
  });

  it("returns null for an empty body where the runtime has none", async () => {
    const post = new Request("http://x/", { method: "POST" });
    Object.defineProperty(post, "body", { value: undefined });
    expect(await bodyOf(post)).toBeNull();
  });
});

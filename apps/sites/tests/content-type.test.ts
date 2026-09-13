import { describe, expect, it } from "vitest";
import { contentTypeFor } from "../src/content-type.js";

describe("contentTypeFor", () => {
  it("adds a charset to text types", () => {
    expect(contentTypeFor("/a.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/a.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("/a.svg")).toBe("image/svg+xml; charset=utf-8");
  });

  it("does not add a charset to binary types", () => {
    expect(contentTypeFor("/a.png")).toBe("image/png");
    expect(contentTypeFor("/a.woff2")).toBe("font/woff2");
  });

  it("is case-insensitive about the extension", () => {
    expect(contentTypeFor("/A.PNG")).toBe("image/png");
  });

  it("falls back to octet-stream for unknown and absent extensions", () => {
    expect(contentTypeFor("/a.unknownext")).toBe("application/octet-stream");
    expect(contentTypeFor("/noextension")).toBe("application/octet-stream");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/cache.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TtlCache", () => {
  it("returns what was stored", () => {
    const c = new TtlCache<string>({ ttlMs: 1000, max: 10 });
    c.set("a", "x");
    expect(c.get("a")).toBe("x");
  });

  it("expires entries after the TTL", () => {
    const c = new TtlCache<string>({ ttlMs: 1000, max: 10 });
    c.set("a", "x");
    vi.advanceTimersByTime(1001);
    expect(c.get("a")).toBeUndefined();
  });

  it("evicts the oldest entry when full, so memory stays bounded", () => {
    const c = new TtlCache<string>({ ttlMs: 1000, max: 2 });
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    expect(c.size).toBe(2);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe("3");
  });

  // ttlMs 0 is the documented way to disable caching while iterating on a
  // site, so it must be a real bypass and not a zero-length TTL.
  it("is a no-op when the TTL is zero", () => {
    const c = new TtlCache<string>({ ttlMs: 0, max: 10 });
    c.set("a", "x");
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });
});

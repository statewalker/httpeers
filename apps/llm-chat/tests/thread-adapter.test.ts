import { describe, expect, it } from "vitest";
import { indexOfId, isRunningFor, messageId, toThreadMessage } from "../src/ui/thread-adapter.js";

describe("thread adapter", () => {
  it("round-trips a message index through its id", () => {
    expect(indexOfId(messageId(0))).toBe(0);
    expect(indexOfId(messageId(12))).toBe(12);
  });

  it("treats anything else as no index", () => {
    expect(indexOfId(null)).toBeNull();
    expect(indexOfId(undefined)).toBeNull();
    expect(indexOfId("abc")).toBeNull();
    expect(indexOfId("m")).toBeNull();
  });

  it("converts an OpenAI-shaped message to one text part with an index id", () => {
    expect(toThreadMessage({ role: "assistant", content: "hi" }, 3)).toEqual({
      id: "m3",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("treats only idle as not running", () => {
    expect(isRunningFor("idle")).toBe(false);
    expect(isRunningFor("waiting")).toBe(true);
    expect(isRunningFor("streaming")).toBe(true);
  });
});

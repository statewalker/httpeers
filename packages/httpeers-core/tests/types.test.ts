import { describe, expect, it } from "vitest";
import { ANONYMOUS } from "../src/types.js";

describe("ANONYMOUS", () => {
  it("is stable across separate lookups via the global symbol registry", () => {
    // Regression for using Symbol.for(...) rather than Symbol(...): two
    // module instances of this package (e.g. one bundled for a browser
    // client, one running under Node in the hub) must still produce a
    // sentinel that is === to each other.
    expect(ANONYMOUS).toBe(Symbol.for("httpeers.anonymous"));
  });
});

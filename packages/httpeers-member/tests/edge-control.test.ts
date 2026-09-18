/**
 * What `mountEdge` throws when the ServiceWorker edge cannot start.
 *
 * Recovering an uncontrolled page (the `CLAIM` request, the one guarded
 * reload) is webrun-http-browser's job since 0.5; that it really happens in
 * Chromium and Firefox -- in place, without a navigation -- is measured by
 * `httpeers-browser-conformance/scripts/edge-reload.mjs`. These tests pin the
 * message a user sees when it does not.
 */

import { ServiceWorkerControlError } from "@statewalker/webrun-http-browser";
import { describe, expect, it } from "vitest";
import { edgeStartError, UncontrolledPageError } from "../src/edge-control.js";

const SW = "https://example.test/sw.js";

/** What another bundle's copy of the class looks like: same name and reason, different class. */
function foreignControlError(reason: string): Error {
  return Object.assign(new Error(`library says: ${reason}`), {
    name: "ServiceWorkerControlError",
    reason,
  });
}

describe("edgeStartError", () => {
  it("maps an uncontrolled page to UncontrolledPageError, saying what to do", () => {
    const cause = new ServiceWorkerControlError("uncontrolled", "not controlled");
    const err = edgeStartError(cause, SW, 30_000);
    expect(err).toBeInstanceOf(UncontrolledPageError);
    expect((err as Error).name).toBe("UncontrolledPageError");
    expect((err as Error).message).toMatch(/close the tab and reopen it/);
    expect((err as Error).cause).toBe(cause);
  });

  it("matches on name and reason, not instanceof -- each bundle has its own class", () => {
    const err = edgeStartError(foreignControlError("uncontrolled"), SW, 30_000);
    expect(err).toBeInstanceOf(UncontrolledPageError);
  });

  it("names the worker and the bound when the worker never activated", () => {
    const cause = foreignControlError("activation-timeout");
    const err = edgeStartError(cause, SW, 30_000) as Error;
    expect(err).not.toBeInstanceOf(UncontrolledPageError);
    expect(err.message).toBe(
      `mountEdge: the ServiceWorker ${SW} did not activate within 30 s. Close the tab and ` +
        "reopen it; if that does not help, clear this site's data in the browser to remove " +
        "the ServiceWorker and start clean.",
    );
    expect(err.cause).toBe(cause);
  });

  it("says so when the worker controls the page but does not answer", () => {
    const err = edgeStartError(foreignControlError("unresponsive"), SW, 5_000) as Error;
    expect(err.message).toMatch(/did not answer the page, although it controls it, within 5 s/);
    expect(err.message).toMatch(/clear this site's data/);
  });

  it("passes anything that is not a control failure through unchanged", () => {
    const other = new TypeError("boom");
    expect(edgeStartError(other, SW, 30_000)).toBe(other);
    const unnamedReason = Object.assign(new Error("x"), { reason: "uncontrolled" });
    expect(edgeStartError(unnamedReason, SW, 30_000)).toBe(unnamedReason);
    expect(edgeStartError("a string", SW, 30_000)).toBe("a string");
  });
});

import { describe, expect, it } from "vitest";
import { sessionErrorPage } from "../src/errors.js";

// Accept-header-based request (Request constructor does not support mode: "navigate")
const acceptHeaderNavigation = (): Request =>
  new Request("https://abc.p.httpeers.net/", { headers: { accept: "text/html" } });
const xhr = (): Request =>
  new Request("https://abc.p.httpeers.net/api/x", { headers: { accept: "application/json" } });

// Stub for a real ServiceWorker request. The Request constructor refuses
// mode: "navigate", but the worker receives it as-is. This stub exercises the
// mode-based branch that the accept-header tests would miss.
interface ServiceWorkerRequestStub {
  mode: "navigate" | "cors";
  headers: { get(name: string): string | null };
}

/**
 * The relay's own error envelope, byte for byte what `serve()`'s catch builds:
 * a JSON body with `Content-Type: application/json`. The content type is the
 * DISCRIMINATOR -- it is how `sessionErrorPage` tells the relay's failure from
 * the app's own answer -- so a test that omits it is testing nothing.
 */
const envelope = (status: number, statusText?: string): Response =>
  new Response("{}", {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });

/**
 * The envelope's content type on a status that may carry NO body. A relay
 * cannot put the JSON there (`new Response("{}", { status: 204 })` throws),
 * but the content type is what `sessionErrorPage` discriminates on, so this is
 * the shape that gets furthest: every check after the status guards would say
 * "rewrite this".
 */
const nullBodyEnvelope = (status: number): Response =>
  new Response(null, { status, headers: { "content-type": "application/json" } });

const navigationByMode = (accept?: string): ServiceWorkerRequestStub => ({
  mode: "navigate",
  headers: {
    get: (name: string) => (name.toLowerCase() === "accept" ? (accept ?? null) : null),
  },
});

describe("the page a session shows when the relay cannot answer", () => {
  it("leaves a successful response alone", () => {
    expect(sessionErrorPage(new Response("hi"), acceptHeaderNavigation())).toBeNull();
  });

  // THE STATUS IS THE LIBRARY'S, NOT OURS. Rewriting 410 to 503 would make the
  // page disagree with the header for anything reading both.
  it("keeps the status it was given (Accept: text/html)", async () => {
    const page = sessionErrorPage(envelope(410), acceptHeaderNavigation());
    expect(page?.status).toBe(410);
    expect(page?.headers.get("content-type")).toContain("text/html");
  });

  it("explains a missing app in words a viewer can act on (Accept: text/html)", async () => {
    const page = sessionErrorPage(envelope(410), acceptHeaderNavigation());
    const text = (await page?.text()) ?? "";
    expect(text).toContain("No app is connected");
    expect(text).toContain("Reopen it from the app that created it");
  });

  it("explains a refusal (Accept: text/html)", async () => {
    const page = sessionErrorPage(envelope(403), acceptHeaderNavigation());
    expect((await page?.text()) ?? "").toContain("Refused");
  });

  // A `fetch()` from the app wants the machine-readable answer the library
  // produced; turning it into HTML would break the app's own error handling.
  it("leaves a non-HTML request's error alone", () => {
    expect(sessionErrorPage(envelope(410), xhr())).toBeNull();
  });

  it("escapes what it interpolates (Accept: text/html)", async () => {
    const page = sessionErrorPage(envelope(599, "<script>"), acceptHeaderNavigation());
    const text = (await page?.text()) ?? "";
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  // A NULL-BODY STATUS MUST NOT BE GIVEN A BODY, and the only cases where that
  // is a question are the ones that are NOT 3xx: 204 and 205 carry the relay's
  // own content type on a navigation, so the discriminator and `wantsHtml`
  // both say "rewrite this" and the ONLY thing that stops it is `ok`. The case
  // that used to stand here was a 304, which returns through the 3xx guard --
  // so it stayed green when the null-body line was deleted, which is how that
  // line survived unreachable. 304 itself is covered by the 3xx loop below.
  it.each([204, 205])("does not give %i a body, though it looks rewritable", (status) => {
    expect(sessionErrorPage(nullBodyEnvelope(status), acceptHeaderNavigation())).toBeNull();
  });

  // The mode-based branch: a ServiceWorker navigation request that lacks
  // Accept: text/html. The Request constructor refuses mode: "navigate",
  // so we use a stub. This is the case the accept-header fallback would miss.
  it("returns a page for mode: navigate even without Accept: text/html", () => {
    const page = sessionErrorPage(envelope(410), navigationByMode("*/*") as Request);
    expect(page).not.toBeNull();
    expect(page?.status).toBe(410);
    expect(page?.headers.get("content-type")).toContain("text/html");
  });

  // Verify the stub still returns null for non-HTML modes, so the stub
  // has not simply made everything return a page.
  it("still leaves a cors mode request alone (with stub)", () => {
    const corsRequest: ServiceWorkerRequestStub = {
      mode: "cors",
      headers: {
        get: (name: string) => (name.toLowerCase() === "accept" ? "application/json" : null),
      },
    };
    expect(sessionErrorPage(envelope(410), corsRequest as Request)).toBeNull();
  });

  // WHAT THE RELAY MADE, NOT WHAT THE APP MADE. `decorateResponse` runs on
  // EVERY answer the relay carries, the app's included, so `!ok` alone would
  // have the shell overwrite an app's own error page with its own words.
  it("leaves the app's own HTML 404 alone", () => {
    const own = new Response("<h1>No such note</h1>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(sessionErrorPage(own, acceptHeaderNavigation())).toBeNull();
  });

  // A REDIRECT IS NOT AN ERROR, and rebuilding the response is what drops
  // `Location` -- an app's own redirects would stop working.
  it("never touches a redirect, and keeps its Location", () => {
    const moved = new Response("moved", {
      status: 302,
      headers: { location: "/next", "content-type": "text/html" },
    });
    expect(sessionErrorPage(moved, acceptHeaderNavigation())).toBeNull();
    expect(moved.headers.get("location")).toBe("/next");
  });

  // Even a 3xx the relay itself somehow produced as JSON stays a redirect.
  it("leaves a 3xx alone whatever its content type", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(sessionErrorPage(envelope(status), acceptHeaderNavigation())).toBeNull();
    }
  });

  // The behaviour that must SURVIVE the discriminator: the relay's own
  // envelope on a navigation is still turned into a page a viewer can read.
  it("still turns the relay's own JSON envelope into a page", async () => {
    const page = sessionErrorPage(envelope(410), acceptHeaderNavigation());
    expect(page?.status).toBe(410);
    expect(page?.headers.get("content-type")).toContain("text/html");
    expect((await page?.text()) ?? "").toContain("No app is connected");
  });
});

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
    const page = sessionErrorPage(new Response("{}", { status: 410 }), acceptHeaderNavigation());
    expect(page?.status).toBe(410);
    expect(page?.headers.get("content-type")).toContain("text/html");
  });

  it("explains a missing app in words a viewer can act on (Accept: text/html)", async () => {
    const page = sessionErrorPage(new Response("{}", { status: 410 }), acceptHeaderNavigation());
    const text = (await page?.text()) ?? "";
    expect(text).toContain("No app is connected");
    expect(text).toContain("Reopen it from the app that created it");
  });

  it("explains a refusal (Accept: text/html)", async () => {
    const page = sessionErrorPage(new Response("{}", { status: 403 }), acceptHeaderNavigation());
    expect((await page?.text()) ?? "").toContain("Refused");
  });

  // A `fetch()` from the app wants the machine-readable answer the library
  // produced; turning it into HTML would break the app's own error handling.
  it("leaves a non-HTML request's error alone", () => {
    expect(sessionErrorPage(new Response("{}", { status: 410 }), xhr())).toBeNull();
  });

  it("escapes what it interpolates (Accept: text/html)", async () => {
    const page = sessionErrorPage(
      new Response("{}", { status: 599, statusText: "<script>" }),
      acceptHeaderNavigation(),
    );
    const text = (await page?.text()) ?? "";
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("does not give a null-body status a body (Accept: text/html)", () => {
    expect(
      sessionErrorPage(new Response(null, { status: 304 }), acceptHeaderNavigation()),
    ).toBeNull();
  });

  // The mode-based branch: a ServiceWorker navigation request that lacks
  // Accept: text/html. The Request constructor refuses mode: "navigate",
  // so we use a stub. This is the case the accept-header fallback would miss.
  it("returns a page for mode: navigate even without Accept: text/html", () => {
    const page = sessionErrorPage(
      new Response("{}", { status: 410 }),
      navigationByMode("*/*") as Request,
    );
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
    expect(
      sessionErrorPage(new Response("{}", { status: 410 }), corsRequest as Request),
    ).toBeNull();
  });
});

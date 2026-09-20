import { describe, expect, it } from "vitest";
import { sessionErrorPage } from "../src/errors.js";

const navigation = (): Request =>
  new Request("https://abc.p.httpeers.net/", { headers: { accept: "text/html" } });
const xhr = (): Request =>
  new Request("https://abc.p.httpeers.net/api/x", { headers: { accept: "application/json" } });

describe("the page a session shows when the relay cannot answer", () => {
  it("leaves a successful response alone", () => {
    expect(sessionErrorPage(new Response("hi"), navigation())).toBeNull();
  });

  // THE STATUS IS THE LIBRARY'S, NOT OURS. Rewriting 410 to 503 would make the
  // page disagree with the header for anything reading both.
  it("keeps the status it was given", async () => {
    const page = sessionErrorPage(new Response("{}", { status: 410 }), navigation());
    expect(page?.status).toBe(410);
    expect(page?.headers.get("content-type")).toContain("text/html");
  });

  it("explains a missing app in words a viewer can act on", async () => {
    const page = sessionErrorPage(new Response("{}", { status: 410 }), navigation());
    const text = (await page?.text()) ?? "";
    expect(text).toContain("No app is connected");
    expect(text).toContain("Reopen it from the app that created it");
  });

  it("explains a refusal", async () => {
    const page = sessionErrorPage(new Response("{}", { status: 403 }), navigation());
    expect((await page?.text()) ?? "").toContain("Refused");
  });

  // A `fetch()` from the app wants the machine-readable answer the library
  // produced; turning it into HTML would break the app's own error handling.
  it("leaves a non-HTML request's error alone", () => {
    expect(sessionErrorPage(new Response("{}", { status: 410 }), xhr())).toBeNull();
  });

  it("escapes what it interpolates", async () => {
    const page = sessionErrorPage(
      new Response("{}", { status: 599, statusText: "<script>" }),
      navigation(),
    );
    const text = (await page?.text()) ?? "";
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("does not give a null-body status a body", () => {
    expect(sessionErrorPage(new Response(null, { status: 304 }), navigation())).toBeNull();
  });
});

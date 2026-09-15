import { describe, expect, it } from "vitest";
import { rewriteLocation, shouldRewriteBody, stripOrigins } from "../src/services/llm/rewrite.js";

const ORIGINS = ["http://127.0.0.1:4100", "http://llm.mesh.invalid", "https://llm.mesh.invalid"];

describe("rewriteLocation", () => {
  it("rewrites a Location at the upstream's raw bind origin to root-relative", () => {
    expect(rewriteLocation("http://127.0.0.1:4100/peers/H/llm/ui/", ORIGINS)).toBe(
      "/peers/H/llm/ui/",
    );
  });

  it("rewrites a Location at the sentinel origin (http and https)", () => {
    expect(rewriteLocation("http://llm.mesh.invalid/peers/H/llm/ui/?login=success", ORIGINS)).toBe(
      "/peers/H/llm/ui/?login=success",
    );
    expect(rewriteLocation("https://llm.mesh.invalid/peers/H/llm/ui/", ORIGINS)).toBe(
      "/peers/H/llm/ui/",
    );
  });

  it("turns a bare origin with nothing after it into /", () => {
    expect(rewriteLocation("http://llm.mesh.invalid", ORIGINS)).toBe("/");
  });

  it("leaves an already root-relative Location untouched", () => {
    expect(rewriteLocation("/peers/H/llm/ui/", ORIGINS)).toBe("/peers/H/llm/ui/");
  });

  it("leaves a Location at an unrelated origin untouched", () => {
    expect(rewriteLocation("https://example.test/elsewhere", ORIGINS)).toBe(
      "https://example.test/elsewhere",
    );
  });
});

describe("shouldRewriteBody", () => {
  it("is true for /v2/login JSON", () => {
    expect(shouldRewriteBody("/llm/v2/login", "application/json")).toBe(true);
  });

  it("is true for /.well-known/litellm-ui-config JSON, content-type with parameters included", () => {
    expect(
      shouldRewriteBody("/llm/.well-known/litellm-ui-config", "application/json; charset=utf-8"),
    ).toBe(true);
  });

  it("is false for the same paths with a non-JSON content-type", () => {
    expect(shouldRewriteBody("/llm/v2/login", "text/html")).toBe(false);
    expect(shouldRewriteBody("/llm/v2/login", null)).toBe(false);
  });

  it("is false for every other path, even with a JSON content-type", () => {
    expect(shouldRewriteBody("/llm/v1/chat/completions", "application/json")).toBe(false);
    expect(shouldRewriteBody("/llm/login", "application/json")).toBe(false);
    expect(shouldRewriteBody("/llm/ui/", "application/json")).toBe(false);
  });
});

describe("stripOrigins", () => {
  it("removes every occurrence of every origin string", () => {
    const body = JSON.stringify({
      redirect_url: "http://llm.mesh.invalid/peers/H/llm/ui/?login=success",
    });
    expect(stripOrigins(body, ORIGINS)).toBe(
      JSON.stringify({ redirect_url: "/peers/H/llm/ui/?login=success" }),
    );
  });

  it("turns a bare sentinel field into an empty string, not a dangling scheme", () => {
    const body = JSON.stringify({ proxy_base_url: "http://llm.mesh.invalid" });
    expect(stripOrigins(body, ORIGINS)).toBe(JSON.stringify({ proxy_base_url: "" }));
  });

  it("touches nothing when no origin occurs", () => {
    const body = JSON.stringify({ ok: true });
    expect(stripOrigins(body, ORIGINS)).toBe(body);
  });
});

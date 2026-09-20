import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEnvFile, planSecrets, shaHtpasswd } from "../src/env.js";

describe("parseEnvFile", () => {
  it("keeps a value containing '=' and '$' verbatim", () => {
    const parsed = parseEnvFile("ADMIN_HTPASSWD=admin:{SHA}aGk=\nX=a=b$c\n");
    expect(parsed.get("ADMIN_HTPASSWD")).toBe("admin:{SHA}aGk=");
    expect(parsed.get("X")).toBe("a=b$c");
  });

  it("ignores comments and blank lines", () => {
    expect([...parseEnvFile("# c\n\nA=1\n").keys()]).toEqual(["A"]);
  });
});

describe("shaHtpasswd", () => {
  it("produces the {SHA} form Traefik accepts", () => {
    const expected = createHash("sha1").update("pw").digest("base64");
    expect(shaHtpasswd("admin", "pw")).toBe(`admin:{SHA}${expected}`);
  });
});

describe("planSecrets", () => {
  const REQUIRED = [
    "LITELLM_MASTER_KEY",
    "LITELLM_SALT_KEY",
    "POSTGRES_PASSWORD",
    "UI_USERNAME",
    "UI_PASSWORD",
    "ADMIN_USER",
    "ADMIN_PASSWORD",
    "ADMIN_HTPASSWD",
    "HUB_DOOR_SECRET",
  ];

  it("generates all nine on a first run", () => {
    const plan = planSecrets(new Map(), { rotate: false });
    for (const key of REQUIRED) expect(plan.values.get(key), key).toBeTruthy();
    expect(plan.generated.sort()).toEqual([...REQUIRED].sort());
  });

  it("PRESERVES an existing secret rather than rotating Postgres out from under its volume", () => {
    const previous = new Map([["POSTGRES_PASSWORD", "already-set"]]);
    const plan = planSecrets(previous, { rotate: false });
    expect(plan.values.get("POSTGRES_PASSWORD")).toBe("already-set");
    expect(plan.preserved).toContain("POSTGRES_PASSWORD");
    expect(plan.generated).not.toContain("POSTGRES_PASSWORD");
  });

  it("rotates everything when asked explicitly", () => {
    const previous = new Map([["POSTGRES_PASSWORD", "already-set"]]);
    expect(planSecrets(previous, { rotate: true }).values.get("POSTGRES_PASSWORD")).not.toBe(
      "already-set",
    );
  });

  it("keeps ADMIN_HTPASSWD consistent with ADMIN_PASSWORD when it generates both", () => {
    const plan = planSecrets(new Map(), { rotate: false });
    const user = plan.values.get("ADMIN_USER") as string;
    const password = plan.values.get("ADMIN_PASSWORD") as string;
    expect(plan.values.get("ADMIN_HTPASSWD")).toBe(shaHtpasswd(user, password));
  });

  it("REGENERATES the hash when a preserved password has no matching hash", () => {
    const previous = new Map([
      ["ADMIN_USER", "admin"],
      ["ADMIN_PASSWORD", "pw"],
    ]);
    const plan = planSecrets(previous, { rotate: false });
    expect(plan.values.get("ADMIN_HTPASSWD")).toBe(shaHtpasswd("admin", "pw"));
  });

  it("HUB_DOOR_SECRET contains only the characters Traefik's guard allows", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(planSecrets(new Map(), { rotate: false }).values.get("HUB_DOOR_SECRET")).toMatch(
        /^[A-Za-z0-9_-]+$/,
      );
    }
  });
});

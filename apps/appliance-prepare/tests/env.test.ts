import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEnvFile, planSecrets, renderEnvFile, shaHtpasswd } from "../src/env.js";

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

// Zero coverage before Task 9 (per the controller ruling on Task 6): this is
// the module that turns the nine planned secrets into an actual file on
// disk, so its three behaviours -- first run, preserving an existing file,
// and a managed key the base text doesn't mention at all -- are pinned here.
describe("renderEnvFile", () => {
  it("on a first run (no previous .env), reproduces .env.example's comment structure", () => {
    const plan = planSecrets(new Map(), { rotate: false });
    const text = renderEnvFile(plan.values, null);

    // Comment scaffolding and section headers survive verbatim.
    expect(text).toContain("# Copy to .env (chmod 600 .env) and fill in real values.");
    expect(text).toContain("# LiteLLM's own master key");
    expect(text).toContain("# Traefik's basic auth in front of everything");

    // Every managed value is substituted after its `=`.
    expect(text).toContain(`LITELLM_MASTER_KEY=${plan.values.get("LITELLM_MASTER_KEY")}`);
    expect(text).toContain(`POSTGRES_PASSWORD=${plan.values.get("POSTGRES_PASSWORD")}`);
    expect(text).toContain(`ADMIN_HTPASSWD=${plan.values.get("ADMIN_HTPASSWD")}`);

    // An optional, commented-out line the tool does not manage is untouched.
    expect(text).toContain("# HUB_DOOR_ALLOWED_HOSTS=127.0.0.1:8080,localhost:8080");
    // A variable this tool never manages, given a real default, is untouched.
    expect(text).toContain("HUB_JOIN_PAGE_URL=https://llm-chat.httpeers.net/mesh.html");
  });

  it("preserves an existing .env's untouched lines and ordering, substituting only managed keys", () => {
    const previous = [
      "# my own note at the top, not in the template at all",
      "LITELLM_MASTER_KEY=old-master-key",
      "",
      "# a custom section an operator added",
      "OPENROUTER_API_KEY=sk-or-something",
      "POSTGRES_PASSWORD=old-postgres-password",
    ].join("\n");
    const values = new Map([
      ["LITELLM_MASTER_KEY", "new-master-key"],
      ["POSTGRES_PASSWORD", "old-postgres-password"],
    ]);

    const text = renderEnvFile(values, previous);
    const lines = text.split("\n");

    expect(lines).toContain("# my own note at the top, not in the template at all");
    expect(lines).toContain("# a custom section an operator added");
    expect(lines).toContain("OPENROUTER_API_KEY=sk-or-something");
    expect(lines).toContain("LITELLM_MASTER_KEY=new-master-key");
    expect(lines).toContain("POSTGRES_PASSWORD=old-postgres-password");
    // Order is preserved: the substituted key stays where it was.
    expect(lines.indexOf("LITELLM_MASTER_KEY=new-master-key")).toBe(1);
  });

  it("appends a managed key that is absent from both the template and the previous file", () => {
    const text = renderEnvFile(new Map([["FUTURE_SECRET", "xyz"]]), "# just a comment\n");
    expect(text).toContain("FUTURE_SECRET=xyz");
    expect(text.trim().endsWith("FUTURE_SECRET=xyz")).toBe(true);
  });

  it("same append behaviour applies on a first run, for a key .env.example doesn't mention", () => {
    const text = renderEnvFile(new Map([["FUTURE_SECRET", "xyz"]]), null);
    expect(text).toContain("FUTURE_SECRET=xyz");
  });
});

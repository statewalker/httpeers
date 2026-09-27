/**
 * `.env` rendering for the local-model appliance, with secrets preserved.
 *
 * Today an operator fills nine values by hand into `.env` (see
 * `deploy/llm-appliance/.env.example`); this module generates them instead.
 * Two rules bind everything here:
 *
 * 1. Re-running prepare is the normal way to pick up a new model tier or a
 *    changed backend, and it must not rotate a secret that is already set.
 *    If it rotated POSTGRES_PASSWORD, the existing Postgres volume would be
 *    orphaned (wrong password against data initialized with the old one)
 *    and the appliance would not start, with a cause that looks nothing
 *    like "prepare regenerated a password". Only an explicit `rotate: true`
 *    (the tool's `--rotate-secrets` flag) may replace a value that is
 *    already present.
 * 2. HUB_DOOR_SECRET must be [A-Za-z0-9_-] only, because compose.yml's
 *    Traefik entrypoint has a shell guard that refuses to start on any other
 *    character — the failure surfaces as a Traefik crash loop with no
 *    obvious cause. `randomSecret` uses hex, which satisfies that guard by
 *    construction (hex digits are a subset of it), so nothing downstream
 *    needs to re-check it.
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * Parses a `.env`-format text into a Map, ignoring comment (`#`) and blank
 * lines. Only the FIRST `=` on a line splits key from value — everything
 * after it, including further `=` and `$` characters, is kept verbatim as
 * the value. This matters because generated secrets (hex) never collide with
 * these characters, but a hand-entered or htpasswd-produced value (like
 * ADMIN_HTPASSWD's `{SHA}...base64...=` padding) does contain them, and a
 * naive split would truncate or corrupt it on the next run.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    values.set(key, value);
  }
  return values;
}

/**
 * Renders a `.env` file. When `previousText` is null (no prior `.env`
 * exists), this reproduces `.env.example`'s comment structure verbatim,
 * substituting each variable's generated/preserved value after its `=` —
 * so the file a human opens after the very first run still reads like the
 * documented template, not a bare KEY=VALUE dump. When `previousText` is
 * given, the SAME substitution is applied to it in place, preserving
 * whatever comments and ordering the operator already has, plus any
 * variables this tool does not manage (e.g. HUB_JOIN_PAGE_URL,
 * APPLIANCE_DATA_DIR) untouched.
 */
export function renderEnvFile(values: Map<string, string>, previousText: string | null): string {
  const base = previousText ?? ENV_EXAMPLE_TEMPLATE;
  const seen = new Set<string>();
  const lines = base.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return line;
    const eq = line.indexOf("=");
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (!values.has(key)) return line;
    seen.add(key);
    return `${key}=${values.get(key)}`;
  });
  // Any managed key not already present as a line (a variable this tool
  // knows about that the template/previous file lacks) is appended, so a
  // future new secret never silently fails to reach the file.
  for (const [key, value] of values) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  return lines.join("\n");
}

// Kept in sync with deploy/llm-appliance/.env.example, which is READ-ONLY
// for this tool (it documents the manual procedure this tool replaces).
// This is the comment scaffold rendered around generated values on a
// first run, when there is no previous .env to preserve structure from.
const ENV_EXAMPLE_TEMPLATE = `# Copy to .env (chmod 600 .env) and fill in real values. .env and data/ are
# gitignored — never commit either. See README.md's "Secrets" section for how
# to generate each of these. Every secret below is required: compose refuses
# to start with one unset or empty.

# LiteLLM's own master key (calls the hub makes to LiteLLM's admin API use
# this) and the key LiteLLM uses to encrypt stored credentials.
#   LITELLM_MASTER_KEY="sk-$(openssl rand -hex 32)"
#   LITELLM_SALT_KEY="sk-$(openssl rand -hex 32)"
LITELLM_MASTER_KEY=
LITELLM_SALT_KEY=

# Postgres's password for the "litellm" user/database (compose.yml sets the
# user and db name; only the password is a secret).
#   openssl rand -hex 24
POSTGRES_PASSWORD=

# The LiteLLM dashboard's own login (separate from ADMIN_USER/ADMIN_PASSWORD
# below — this is LiteLLM's login, not Traefik's).
UI_USERNAME=admin
#   openssl rand -hex 16
UI_PASSWORD=

# Traefik's basic auth in front of everything (the local door's only way in).
# ADMIN_USER/ADMIN_PASSWORD are the plaintext pair a human (or
# scripts/health.sh) authenticates with; ADMIN_HTPASSWD is the htpasswd hash
# of that SAME pair, which is what Traefik itself is actually configured
# with — see README.md for the exact commands to generate both together.
ADMIN_USER=admin
ADMIN_PASSWORD=
ADMIN_HTPASSWD=

# The shared secret between Traefik and the hub's local door: Traefik sends it
# as x-hub-door-secret on every request it forwards (after basic auth), and the
# door refuses every request without it. The hub will not start without it.
# Only [A-Za-z0-9_-] characters.
#   openssl rand -hex 32
HUB_DOOR_SECRET=

# Optional: the Host values the door answers (comma-separated host:port). The
# default is Traefik's published address; change both together.
# HUB_DOOR_ALLOWED_HOSTS=127.0.0.1:8080,localhost:8080

# Optional: how many members may hold a relay reservation on the hub at once
# (a member that cannot reserve cannot join). Default 4096. It does not change
# how much data may cross the hub.
# HUB_MAX_RESERVATIONS=4096

# Where an invitation link opens. Defaults to the real llm-chat page if unset.
HUB_JOIN_PAGE_URL=https://llm-chat.httpeers.net/mesh.html

# Optional: where the durable data lives (default ./data). The server sets an absolute path so
# that a release directory change does not recreate Postgres; see README "On the httpeers.net
# server".
# APPLIANCE_DATA_DIR=/opt/httpeers-llm/data
`;

/**
 * Traefik's htpasswd basic-auth format: `user:{SHA}<base64(sha1(password))>`.
 *
 * Deliberately SHA1, not bcrypt: bcrypt is not in Node's stdlib and this
 * tool takes no dependencies (stock node:22-alpine, no npm install). That
 * is acceptable ONLY because Traefik's basic auth here guards a narrow
 * surface — the hub's admin UI, its admin REST API, and /llm/keys (see
 * traefik/dynamic.yml's middleware chain). LiteLLM's own paths bypass basic
 * auth entirely: the `litellm` router in dynamic.yml carries only the
 * door-secret middleware, not this one. Do not "upgrade" this to a
 * stronger hash without first adding a dependency and re-checking that
 * tradeoff — it was chosen, not overlooked.
 */
export function shaHtpasswd(user: string, password: string): string {
  const digest = createHash("sha1").update(password).digest("base64");
  return `${user}:{SHA}${digest}`;
}

/**
 * `bytes` random bytes, hex-encoded. Hex digits are a subset of
 * [A-Za-z0-9_-], so this satisfies Traefik's HUB_DOOR_SECRET guard (see the
 * module comment) by construction — no separate validation is needed
 * wherever this is used to generate a secret that guard applies to.
 */
export function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export interface SecretPlan {
  values: Map<string, string>;
  generated: string[];
  preserved: string[];
}

/**
 * Fills in the nine values `.env.example` documents as manual today, from
 * `previous` (an already-parsed prior `.env`, or an empty Map on a first
 * run). A value already present in `previous` is kept verbatim (rule 1
 * above) unless `opts.rotate` is true, in which case every secret below is
 * regenerated regardless of what was already set.
 *
 * ADMIN_HTPASSWD is the one field never simply "preserved or generated" —
 * it is always RECOMPUTED from the final ADMIN_USER/ADMIN_PASSWORD pair,
 * after that pair itself has been resolved (preserved or generated). This
 * is what keeps a preserved password and a stale (or absent, or from a
 * previous username) hash from ever disagreeing: whichever of the pair
 * came from `previous` and whichever was freshly generated, the hash below
 * is derived from the values actually being written, never from a stored
 * ADMIN_HTPASSWD.
 */
export function planSecrets(previous: Map<string, string>, opts: { rotate: boolean }): SecretPlan {
  const values = new Map<string, string>();
  const generated: string[] = [];
  const preserved: string[] = [];

  // Resolve one key: keep the previous value unless it's absent or a
  // rotation was requested, in which case generate a fresh one with `make`.
  function resolve(key: string, make: () => string): void {
    const existing = previous.get(key);
    if (existing !== undefined && existing !== "" && !opts.rotate) {
      values.set(key, existing);
      preserved.push(key);
    } else {
      values.set(key, make());
      generated.push(key);
    }
  }

  // LiteLLM's own key material, prefixed sk- per LiteLLM's convention (it
  // is what the tool's README/.env.example examples show being built with
  // `openssl rand -hex 32` under an `sk-` prefix).
  resolve("LITELLM_MASTER_KEY", () => `sk-${randomSecret(32)}`);
  resolve("LITELLM_SALT_KEY", () => `sk-${randomSecret(32)}`);

  resolve("POSTGRES_PASSWORD", () => randomSecret(24));

  // UI_USERNAME defaults to "admin" like ADMIN_USER, but the two logins are
  // independent (LiteLLM's dashboard vs Traefik's basic auth) — see the
  // comment on ADMIN_USER below and in .env.example. It is generated the
  // same way as any other secret (preserved unless absent/rotated); "admin"
  // is simply the value `make` returns on a first run or a rotation, since
  // there is no reason to randomize a username.
  resolve("UI_USERNAME", () => "admin");
  resolve("UI_PASSWORD", () => randomSecret(16));

  resolve("ADMIN_USER", () => "admin");
  resolve("ADMIN_PASSWORD", () => randomSecret(16));

  // HUB_DOOR_SECRET: see the module-level comment — hex by construction
  // satisfies Traefik's [A-Za-z0-9_-] shell guard.
  resolve("HUB_DOOR_SECRET", () => randomSecret(32));

  // ADMIN_HTPASSWD is deliberately NOT run through `resolve` — it is always
  // recomputed from the final pair above, never preserved or independently
  // generated, so it can never disagree with ADMIN_USER/ADMIN_PASSWORD.
  // Whether that recomputed value differs from whatever `previous` held is
  // exactly what decides generated-vs-preserved for reporting purposes: if
  // the pair it was derived from was entirely preserved AND the previous
  // hash already matches, nothing has effectively changed; otherwise it is
  // reported as (re)generated.
  const finalUser = values.get("ADMIN_USER") as string;
  const finalPassword = values.get("ADMIN_PASSWORD") as string;
  const recomputedHash = shaHtpasswd(finalUser, finalPassword);
  values.set("ADMIN_HTPASSWD", recomputedHash);
  const previousHash = previous.get("ADMIN_HTPASSWD");
  if (!opts.rotate && previousHash !== undefined && previousHash === recomputedHash) {
    preserved.push("ADMIN_HTPASSWD");
  } else {
    generated.push("ADMIN_HTPASSWD");
  }

  return { values, generated, preserved };
}

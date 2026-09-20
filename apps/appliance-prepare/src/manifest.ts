/**
 * The model manifest.
 *
 * `deploy/llm-appliance/models.json` names the models Task 5 downloads and
 * Task 7 wires into Compose, two per tier. An `id` here doubles as a Compose
 * service name suffix (`serviceNameOf`), so it is constrained to the
 * characters Compose accepts for a service name — this is checked at parse
 * time, not left for `docker compose` to reject later with a less legible
 * error.
 *
 * `minUsableBytes` and `fileSize` exist because spec §3.5 runs one
 * `llama-server` per model, BOTH resident at once — a tier's real memory
 * cost is the sum of its two models plus per-process overhead (see
 * `tierBudget` in `tier.ts`), not just the larger file's size. `fileSize` is
 * the exact byte count read from the live Hugging Face tree API for the
 * `file` named alongside it (never recalled from memory), and
 * `minUsableBytes` is the floor this tier promises to fit under — Task 9's
 * CLI is expected to compare `tierBudget` against it before committing to a
 * tier.
 */

export type Tier = "small" | "medium" | "large";

export interface ModelEntry {
  id: string;
  repo: string;
  file: string;
  ctx: number;
  fileSize: number;
}

export interface Manifest {
  schemaVersion: 1;
  tiers: Record<Tier, ModelEntry[]>;
  /** The usable-memory floor each tier promises `tierBudget(tiers[tier])` fits under. */
  minUsableBytes: Record<Tier, number>;
  /**
   * The date the repos and files below were last checked against the live
   * Hugging Face API (not recalled from memory). Optional because it is a
   * provenance note, not part of the schema's structural contract.
   */
  verifiedOn?: string;
}

const TIERS: Tier[] = ["small", "medium", "large"];

// A model id must be a legal Compose service name component once prefixed
// with "llamacpp-": lowercase alphanumerics, dot and dash, starting with an
// alphanumeric.
const VALID_ID = /^[a-z0-9][a-z0-9.-]*$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Parses and validates a `models.json` document. Throws, naming the
 * offending id, when:
 * - an id would not survive `serviceNameOf` as a legal Compose service name;
 * - two models in the *same tier* share an id (which would collide as the
 *   same Compose service once that tier is selected — the same id CAN
 *   appear in more than one tier, e.g. a mid-size model offered as both a
 *   small tier's "larger/better" pick and a medium tier's "smaller/faster"
 *   pick, since only one tier's models are ever compiled into a Compose
 *   file at a time);
 * - an entry's `fileSize` is missing or not a positive integer.
 *
 * Also throws, naming the tier, when that tier's `minUsableBytes` is
 * missing or not a positive integer.
 *
 * Checks run shape-first, policy-second, across the whole manifest before
 * moving to the next check: every id and duplicate is validated first (the
 * basic "is this a legal set of models" question), then every `fileSize`,
 * then every `minUsableBytes`. That ordering is why an id problem is always
 * the error a malformed manifest reports, even when it is also missing the
 * newer `fileSize`/`minUsableBytes` fields entirely.
 */
export function parseManifest(text: string): Manifest {
  const raw = JSON.parse(text) as Manifest;

  for (const tier of TIERS) {
    // Duplicate-id detection is scoped to this tier, not the whole manifest:
    // the same verified model legitimately straddles two tiers as one
    // tier's "larger/better" pick and the next tier's "smaller/faster" pick.
    const seenIds = new Set<string>();
    for (const entry of raw.tiers[tier] ?? []) {
      if (!VALID_ID.test(entry.id)) {
        throw new Error(
          `Model id "${entry.id}" is not a legal Compose service name (must match ${VALID_ID.source})`,
        );
      }
      if (seenIds.has(entry.id)) {
        throw new Error(`duplicate model id "${entry.id}" in tier "${tier}"`);
      }
      seenIds.add(entry.id);
    }
  }

  for (const tier of TIERS) {
    for (const entry of raw.tiers[tier] ?? []) {
      if (!isPositiveInteger(entry.fileSize)) {
        throw new Error(`Model "${entry.id}" is missing a positive integer fileSize`);
      }
    }
  }

  for (const tier of TIERS) {
    if (!isPositiveInteger(raw.minUsableBytes?.[tier])) {
      throw new Error(`Tier "${tier}" is missing a positive integer minUsableBytes`);
    }
  }

  return raw;
}

/**
 * Derives the Compose service name for a model id: `llamacpp-` prefix, with
 * every `.` replaced by `-` because Compose service names may not contain
 * dots.
 */
export function serviceNameOf(id: string): string {
  return `llamacpp-${id.replace(/\./g, "-")}`;
}

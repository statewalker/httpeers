/**
 * The model manifest.
 *
 * `deploy/llm-appliance/models.json` names the models Task 5 downloads and
 * Task 7 wires into Compose, two per tier. An `id` here doubles as a Compose
 * service name suffix (`serviceNameOf`), so it is constrained to the
 * characters Compose accepts for a service name — this is checked at parse
 * time, not left for `docker compose` to reject later with a less legible
 * error.
 */

export type Tier = "small" | "medium" | "large";

export interface ModelEntry {
  id: string;
  repo: string;
  file: string;
  ctx: number;
}

export interface Manifest {
  schemaVersion: 1;
  tiers: Record<Tier, ModelEntry[]>;
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

/**
 * Parses and validates a `models.json` document. Throws, naming the
 * offending id, when an id would not survive `serviceNameOf` as a legal
 * Compose service name, or when two models in the manifest share an id
 * (which would collide as the same Compose service).
 */
export function parseManifest(text: string): Manifest {
  const raw = JSON.parse(text) as Manifest;
  const seenIds = new Set<string>();
  for (const tier of TIERS) {
    for (const entry of raw.tiers[tier] ?? []) {
      if (!VALID_ID.test(entry.id)) {
        throw new Error(
          `Model id "${entry.id}" is not a legal Compose service name (must match ${VALID_ID.source})`,
        );
      }
      if (seenIds.has(entry.id)) {
        throw new Error(`duplicate model id "${entry.id}"`);
      }
      seenIds.add(entry.id);
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

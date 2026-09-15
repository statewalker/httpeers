/**
 * Revocations that outlive a restart.
 *
 * `createHub` builds its `RevocationRegistry` in memory and offers no storage
 * hook for it, so a restarted hub forgets every revocation and honours a
 * revoked member's still-valid token again until it expires. This wraps the
 * registry the hub already has:
 *
 *   - ON START, each unexpired entry in the file is re-applied through the
 *     registry's own `changeRoles`.
 *   - ON EVERY CHANGE, the entry is recorded and the file rewritten
 *     (write-then-rename, serialised). Wrapping the INSTANCE's `changeRoles`
 *     covers `revoke` too, which calls it, and any caller -- the admin API,
 *     `/admin/members/:id` -- persists without knowing this exists.
 *
 * THE FILE KEEPS THE ORIGINAL CHANGE TIME. Re-applying stamps the registry's
 * entry with the restart time (there is no public way to set it), which only
 * makes the check stricter: a token minted between the change and the restart
 * is refused once more and the member's next heartbeat mints a fresh one. The
 * file's own time is what decides when an entry ages out, so a hub restarted
 * every hour does not keep an entry alive forever.
 *
 * Members, invitations and spent invitation ids need none of this:
 * `createHub` persists them through its `storage` (`fileStorage`).
 */

import { readFile } from "node:fs/promises";
import type { ChangeEntry } from "@statewalker/httpeers-access";
import type { RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { writeFileAtomic } from "./fs-atomic.js";

export const REVOCATIONS_FILE = "revocations.json";

interface RevocationsDocument {
  version: 1;
  entries: ChangeEntry[];
}

export interface PersistentRevocationsInit {
  /** The hub's longest token life: an entry older than this protects nothing and is dropped. */
  maxTokenTtlMs: number;
  now?: () => number;
}

export interface PersistentRevocations {
  /** Resolves when every change so far is on disk. */
  flushed(): Promise<void>;
}

async function readEntries(file: string): Promise<ChangeEntry[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  try {
    const doc = JSON.parse(text) as Partial<RevocationsDocument>;
    if (!Array.isArray(doc.entries)) throw new Error("no entries array");
    return doc.entries.filter(
      (e): e is ChangeEntry =>
        typeof e?.peerId === "string" &&
        typeof e.changedAt === "number" &&
        Array.isArray(e.roles) &&
        e.roles.every((r) => typeof r === "string"),
    );
  } catch (error) {
    // Refuse to start rather than forget: a hub that dropped an unreadable
    // file would re-admit every revoked token.
    throw new Error(`revocations: ${file} is unreadable: ${(error as Error).message}`);
  }
}

export async function persistentRevocations(
  file: string,
  registry: RevocationRegistry,
  init: PersistentRevocationsInit,
): Promise<PersistentRevocations> {
  const now = init.now ?? Date.now;
  const known = new Map<string, ChangeEntry>();
  const change = registry.changeRoles.bind(registry);

  const horizon = () => now() - init.maxTokenTtlMs;
  for (const entry of await readEntries(file)) {
    if (entry.changedAt < horizon()) continue;
    known.set(entry.peerId, entry);
    change(entry.peerId, entry.roles);
  }

  let writes: Promise<void> = Promise.resolve();
  let failure: unknown;
  const persist = () => {
    for (const [peerId, entry] of known) if (entry.changedAt < horizon()) known.delete(peerId);
    const doc: RevocationsDocument = { version: 1, entries: [...known.values()] };
    const content = `${JSON.stringify(doc, null, 2)}\n`;
    writes = writes
      .then(() => writeFileAtomic(file, content))
      .catch((error: unknown) => {
        failure = error;
        console.log(`revocations: could not write ${file}: ${(error as Error).message}`);
      });
  };

  registry.changeRoles = (peerId, roles) => {
    change(peerId, roles);
    // Delete first, so a re-changed peer moves to the end: the file lists
    // changes in the order they happened.
    known.delete(peerId);
    known.set(peerId, { peerId, changedAt: now(), roles: [...roles] });
    persist();
  };

  return {
    async flushed() {
      await writes;
      if (failure != null) {
        const error = failure;
        failure = undefined;
        throw error;
      }
    },
  };
}

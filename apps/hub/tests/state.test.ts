/**
 * Revocations outlive a restart.
 *
 * `createHub` keeps its `RevocationRegistry` in memory, so a hub that restarts
 * forgets every revocation -- and a revoked member's still-valid token is
 * honoured again until it expires. `persistentRevocations` writes each change
 * to a file and re-applies the file on start.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { afterEach, describe, expect, it } from "vitest";
import { persistentRevocations } from "../src/state.js";

const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-state-"));
  dirs.push(dir);
  return join(dir, "revocations.json");
}

describe("persistentRevocations", () => {
  it("writes a revocation to the file, and a fresh registry refuses the old token after restart", async () => {
    const file = await tempFile();
    let clock = 1_000_000;
    const now = () => clock;

    const before = new RevocationRegistry({ maxTokenTtlMs: HOUR, now });
    const persisted = await persistentRevocations(file, before, { maxTokenTtlMs: HOUR, now });
    clock += 10;
    before.revoke("peer-a");
    await persisted.flushed();

    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.entries).toEqual([{ peerId: "peer-a", changedAt: clock, roles: [] }]);

    // "Restart": a registry that knows nothing, restored from the file.
    clock += 1_000;
    const after = new RevocationRegistry({ maxTokenTtlMs: HOUR, now });
    await persistentRevocations(file, after, { maxTokenTtlMs: HOUR, now });
    expect(after.check({ sub: "peer-a", iat: 1_000_000 })).toBe("membership revoked");
    expect(after.check({ sub: "peer-b", iat: 1_000_000 })).toBeNull();
    expect(after.list().map((e) => e.peerId)).toEqual(["peer-a"]);
  });

  it("keeps the original change time across restarts, so an entry still ages out", async () => {
    const file = await tempFile();
    let clock = 5_000_000;
    const now = () => clock;

    const first = new RevocationRegistry({ maxTokenTtlMs: HOUR, now });
    const p1 = await persistentRevocations(file, first, { maxTokenTtlMs: HOUR, now });
    first.changeRoles("peer-a", ["member"]);
    await p1.flushed();

    clock += HOUR / 2;
    const second = new RevocationRegistry({ maxTokenTtlMs: HOUR, now });
    const p2 = await persistentRevocations(file, second, { maxTokenTtlMs: HOUR, now });
    second.revoke("peer-b");
    await p2.flushed();
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.entries).toEqual([
      { peerId: "peer-a", changedAt: 5_000_000, roles: ["member"] },
      { peerId: "peer-b", changedAt: clock, roles: [] },
    ]);

    // Past the horizon for peer-a (not for peer-b): only peer-b comes back.
    clock = 5_000_000 + HOUR + 1;
    const third = new RevocationRegistry({ maxTokenTtlMs: HOUR, now });
    await persistentRevocations(file, third, { maxTokenTtlMs: HOUR, now });
    expect(third.list().map((e) => e.peerId)).toEqual(["peer-b"]);
  });

  it("starts empty with no file, and leaves no temp file behind", async () => {
    const file = await tempFile();
    const registry = new RevocationRegistry({ maxTokenTtlMs: HOUR });
    const persisted = await persistentRevocations(file, registry, { maxTokenTtlMs: HOUR });
    expect(registry.list()).toEqual([]);
    registry.revoke("x");
    registry.revoke("y");
    await persisted.flushed();
    const dir = join(file, "..");
    expect(await readdir(dir)).toEqual(["revocations.json"]);
  });

  it("refuses an unreadable file rather than forgetting what it held", async () => {
    const file = await tempFile();
    await writeFile(file, "{ not json");
    const registry = new RevocationRegistry({ maxTokenTtlMs: HOUR });
    await expect(persistentRevocations(file, registry, { maxTokenTtlMs: HOUR })).rejects.toThrow(
      /revocations\.json/,
    );
  });
});

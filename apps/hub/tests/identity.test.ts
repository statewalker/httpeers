/**
 * The hub's identity survives a restart, and the peerId is published beside it.
 *
 * A key regenerated on a second start would silently re-found the mesh: every
 * member's token names the old peerId, and LiteLLM's `SERVER_ROOT_PATH` (read
 * from `hub.env`) would point at a hub that no longer exists.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "../src/identity.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-identity-"));
  dirs.push(dir);
  return dir;
}

describe("loadOrCreateIdentity", () => {
  it("creates a key on first call and reads the same one on the second", async () => {
    const dir = await tempDir();
    const first = await loadOrCreateIdentity(dir);
    const second = await loadOrCreateIdentity(dir);

    expect(first.peerId).toMatch(/^12D3Koo/);
    expect(second.peerId).toBe(first.peerId);
    expect(second.privateKey.raw).toEqual(first.privateKey.raw);
  });

  it("writes hub.env with the peerId on every call", async () => {
    const dir = await tempDir();
    const { peerId } = await loadOrCreateIdentity(dir);
    expect(await readFile(join(dir, "hub.env"), "utf8")).toBe(`HUB_PEER_ID=${peerId}\n`);

    // Rewritten, not only created: an operator who deleted or edited it gets it back.
    await rm(join(dir, "hub.env"));
    await loadOrCreateIdentity(dir);
    expect(await readFile(join(dir, "hub.env"), "utf8")).toBe(`HUB_PEER_ID=${peerId}\n`);
  });

  it("creates the directory and leaves only hub.key and hub.env in it", async () => {
    const dir = join(await tempDir(), "nested", "hub");
    await loadOrCreateIdentity(dir);
    await loadOrCreateIdentity(dir);
    expect((await readdir(dir)).sort()).toEqual(["hub.env", "hub.key"]);
  });
});

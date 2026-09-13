/**
 * The filesystem store, and the crash it is shaped around.
 *
 * A key file is not ordinary data. If `identityStore.loadOrCreate` cannot read
 * it, it generates a new one — silently, by design, because that is what makes
 * first start work. So a half-written key file does not surface as a corrupt
 * file somebody notices; it surfaces as a mesh that re-founded itself, where
 * every token the old identity issued has stopped verifying and nothing
 * reported an error.
 *
 * Write-then-rename is what prevents that: the file is either the old key or
 * the new one, never half of either.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey, identityStore, peerIdOf } from "../src/identity.js";
import { fileBytesStore } from "../src/node.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "httpeers-keys-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("fileBytesStore", () => {
  it("round-trips bytes", async () => {
    const store = fileBytesStore(scratch());
    const value = new Uint8Array([1, 2, 3, 250]);

    await store.set("identity", value);

    expect(await store.get("identity")).toEqual(value);
  });

  it("reports a missing entry as undefined, not as an error", async () => {
    // `identityStore.read()` distinguishes "no key yet" from "something went
    // wrong", and it can only do that if this one does.
    expect(await fileBytesStore(scratch()).get("nothing")).toBeUndefined();
  });

  it("creates the directory rather than requiring one", async () => {
    const dir = join(scratch(), "deep/er/still");
    const store = fileBytesStore(dir);

    await store.set("identity", new Uint8Array([7]));

    expect(await store.get("identity")).toEqual(new Uint8Array([7]));
  });

  it("leaves no staging file behind", async () => {
    // The write-then-rename is only safe if the rename actually happens. A
    // leftover `.tmp` means the move did not, and the next crash is the one
    // that loses the key.
    const dir = scratch();
    const store = fileBytesStore(dir);

    await store.set("identity", new Uint8Array([1]));
    await store.set("identity", new Uint8Array([2]));

    expect(readdirSync(dir)).toEqual(["identity"]);
    expect(await store.get("identity")).toEqual(new Uint8Array([2]));
  });

  it("deletes without complaining about an absent entry", async () => {
    const store = fileBytesStore(scratch());
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });

  it("carries a real identity across a restart", async () => {
    // The property that matters, stated end to end: a hub that restarts is the
    // same mesh. Two stores over one directory stand in for two processes.
    const dir = scratch();

    const first = await identityStore({ backend: fileBytesStore(dir) }).loadOrCreate();
    const second = await identityStore({ backend: fileBytesStore(dir) }).loadOrCreate();

    expect(peerIdOf(second)).toBe(peerIdOf(first));
  });

  it("a key that already exists is never overwritten", async () => {
    const dir = scratch();
    const store = fileBytesStore(dir);
    const planted = await generateKey();
    const identity = identityStore({ backend: store });

    await identity.loadOrCreate();
    const before = peerIdOf(await identity.read() as NonNullable<Awaited<ReturnType<typeof identity.read>>>);
    void planted;

    await identity.loadOrCreate();
    await identity.loadOrCreate();

    expect(peerIdOf((await identity.read()) as NonNullable<Awaited<ReturnType<typeof identity.read>>>)).toBe(
      before,
    );
  });
});

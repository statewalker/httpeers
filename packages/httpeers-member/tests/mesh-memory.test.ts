/**
 * `src/browser/mesh-memory.ts` -- the mesh a page last joined, over the
 * injected key/value backend rather than a real IndexedDB.
 *
 * SMALL, BUT NOT TRIVIAL, because everything it stores was pasted by a
 * person one hop upstream: a join blob's `relayAddrs`/`hubPeerId`. A stored
 * value that is truncated, half-written or left over from an older shape
 * must leave the page in its "no remembered mesh" state -- which it already
 * knows how to render -- rather than take the page out with a parse error,
 * taking the reset control with it.
 */
import { describe, expect, it, vi } from "vitest";
import type { AsyncKeyValueBackend } from "../src/kv.js";
import { createMeshMemory, MESH_STORAGE_KEY } from "../src/mesh-memory.js";

function memoryBackend(values = new Map<string, string>()): {
  values: Map<string, string>;
  backend: AsyncKeyValueBackend;
} {
  return {
    values,
    backend: {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
  };
}

const MESH = {
  relayAddrs: ["/ip4/127.0.0.1/tcp/9090/ws"],
  hubPeerId: "12D3KooWHubHubHubHubHubHubHubHubHubHubHubHubHubHubHu",
};

describe("the remembered mesh", () => {
  it("is null before anything has been joined", async () => {
    const { backend } = memoryBackend();
    expect(await createMeshMemory({ backend }).read()).toBeNull();
  });

  it("round-trips what a join produced, at the documented storage key", async () => {
    const { values, backend } = memoryBackend();
    const memory = createMeshMemory({ backend });

    await memory.write(MESH);

    expect(await memory.read()).toEqual(MESH);
    expect(values.has(MESH_STORAGE_KEY)).toBe(true);
  });

  it("forgets on clear", async () => {
    const { backend } = memoryBackend();
    const memory = createMeshMemory({ backend });

    await memory.write(MESH);
    await memory.clear();

    expect(await memory.read()).toBeNull();
  });

  it("treats an unreadable or incomplete value as no memory at all, rather than throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const stored of [
        "{not json",
        "null",
        JSON.stringify({ hubPeerId: MESH.hubPeerId }), // no relay to dial
        JSON.stringify({ relayAddrs: [] }), // ...nor any addresses in it
        JSON.stringify({ relayAddrs: MESH.relayAddrs }), // no mesh to name
      ]) {
        const { backend } = memoryBackend(new Map([[MESH_STORAGE_KEY, stored]]));
        expect(await createMeshMemory({ backend }).read()).toBeNull();
      }
    } finally {
      warn.mockRestore();
    }
  });
});

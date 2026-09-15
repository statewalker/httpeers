import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { idbConfigStore, idbSessionStore } from "../src/core/idb.js";
import { describeConfigStoreContract } from "./contracts/config-store.contract.js";
import { describeSessionStoreContract } from "./contracts/session-store.contract.js";

// A fresh factory per store: every test starts from an empty database.
describeSessionStoreContract("IndexedDB", (clock) =>
  idbSessionStore({ factory: new IDBFactory(), ...clock }),
);
describeConfigStoreContract("IndexedDB", () =>
  idbConfigStore("standalone", { factory: new IDBFactory() }),
);

describe("IndexedDB layout", () => {
  it("keeps one config per profile in the same database", async () => {
    const factory = new IDBFactory();
    const standalone = idbConfigStore("standalone", { factory });
    const mesh = idbConfigStore("mesh", { factory });
    await standalone.set({ baseUrl: "http://a/v1", models: [] });
    expect(await mesh.get()).toBeNull();
    await mesh.set({ baseUrl: "http://b/v1", models: [] });
    expect((await standalone.get())?.baseUrl).toBe("http://a/v1");
  });

  it("shares sessions between stores on the same database", async () => {
    const factory = new IDBFactory();
    const created = await idbSessionStore({ factory }).create({ title: "shared" });
    expect((await idbSessionStore({ factory }).get(created.id))?.title).toBe("shared");
  });
});

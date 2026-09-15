/** What every `ConfigStore` must do. */

import { describe, expect, it } from "vitest";
import type { ChatConfig, ConfigStore } from "../../src/core/config.js";

const sample: ChatConfig = {
  baseUrl: "http://llm.test/v1",
  apiKey: "k",
  models: ["a", "b"],
  defaultModel: "a",
};

export function describeConfigStoreContract(name: string, make: () => ConfigStore): void {
  describe(`ConfigStore contract: ${name}`, () => {
    it("starts empty", async () => {
      expect(await make().get()).toBeNull();
    });

    it("returns what was set, as a copy", async () => {
      const store = make();
      await store.set(sample);
      const read = await store.get();
      expect(read).toEqual(sample);
      read?.models.push("mutated");
      expect((await store.get())?.models).toEqual(["a", "b"]);
    });

    it("replaces on set and empties on clear", async () => {
      const store = make();
      await store.set(sample);
      await store.set({ ...sample, models: ["c"] });
      expect((await store.get())?.models).toEqual(["c"]);
      await store.clear();
      expect(await store.get()).toBeNull();
    });
  });
}

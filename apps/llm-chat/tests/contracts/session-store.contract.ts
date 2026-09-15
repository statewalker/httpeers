/**
 * What every `SessionStore` must do. A new implementation passes this suite or it is not one.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TITLE,
  SessionNotFoundError,
  type SessionStore,
  type StoreClock,
} from "../../src/core/sessions.js";
import { testClock } from "../helpers.js";

export function describeSessionStoreContract(
  name: string,
  make: (clock: Required<StoreClock>) => SessionStore,
): void {
  describe(`SessionStore contract: ${name}`, () => {
    it("creates a session with defaults", async () => {
      const store = make(testClock());
      const session = await store.create();
      expect(session).toMatchObject({ id: "s1", title: DEFAULT_TITLE, messages: [] });
      expect(session.createdAt).toBe(session.updatedAt);
    });

    it("keeps what create was given", async () => {
      const store = make(testClock());
      const messages = [{ role: "user" as const, content: "hi" }];
      const session = await store.create({ title: "T", model: "m", messages });
      expect(await store.get(session.id)).toEqual(session);
      expect(session).toMatchObject({ title: "T", model: "m", messages });
    });

    it("returns null for an unknown id", async () => {
      expect(await make(testClock()).get("nope")).toBeNull();
    });

    it("returns copies that do not alias the stored row", async () => {
      const store = make(testClock());
      const { id } = await store.create();
      const first = await store.get(id);
      first?.messages.push({ role: "user", content: "mutated" });
      expect((await store.get(id))?.messages).toEqual([]);
    });

    it("merges an update, bumps updatedAt, and keeps id and createdAt", async () => {
      const store = make(testClock());
      const created = await store.create({ title: "old" });
      const updated = await store.update(created.id, { title: "new" });
      expect(updated).toMatchObject({ id: created.id, title: "new", createdAt: created.createdAt });
      expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
      expect(await store.get(created.id)).toEqual(updated);
    });

    it("rejects an update of an unknown id", async () => {
      await expect(make(testClock()).update("nope", { title: "x" })).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });

    it("lists newest updatedAt first, without messages", async () => {
      const store = make(testClock());
      const a = await store.create({ title: "a" });
      await store.create({ title: "b" });
      await store.update(a.id, { title: "a2" });
      const list = await store.list();
      expect(list.map((s) => s.title)).toEqual(["a2", "b"]);
      expect(list[0]).not.toHaveProperty("messages");
    });

    it("deletes, and deleting an unknown id resolves", async () => {
      const store = make(testClock());
      const { id } = await store.create();
      await store.delete(id);
      await store.delete("nope");
      expect(await store.get(id)).toBeNull();
      expect(await store.list()).toEqual([]);
    });
  });
}

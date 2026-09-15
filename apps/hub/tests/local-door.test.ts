/**
 * The door binds where it is told. On a host-networked hub (`compose.host.yml`)
 * `0.0.0.0` would put the unauthenticated door on every host interface, so the
 * address must be settable and must actually be the one bound.
 */

import { describe, expect, it } from "vitest";
import { type LocalDoor, startLocalDoor } from "../src/local-door.js";

async function withDoor(hostname: string | undefined, check: (door: LocalDoor) => void) {
  const door = await startLocalDoor({ port: 0, hostname, hubPeerId: "12D3KooWHub", modules: [] });
  try {
    check(door);
  } finally {
    await door.stop();
  }
}

describe("startLocalDoor", () => {
  it("binds the configured address", async () => {
    await withDoor("127.0.0.1", (door) => {
      expect(door.address).toBe("127.0.0.1");
      expect(door.port).toBeGreaterThan(0);
    });
  });

  it("binds every interface by default", async () => {
    await withDoor(undefined, (door) => expect(door.address).toBe("0.0.0.0"));
  });
});

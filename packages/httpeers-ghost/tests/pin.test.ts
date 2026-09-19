/**
 * The pin, in Node.
 *
 * Rung 06's four Node claims, moved with the code. The interesting assertions
 * are about what does NOT get through: a pin whose only evidence is that the
 * happy path works has not been tested at all.
 *
 * The browser half of that rung — a host page rendered in an iframe through a
 * real ServiceWorker edge — belongs to the extraction's browser harness and is
 * not here. What IS here is the property that makes the pin a pin rather than
 * a filter, and it is claim 4's shape: not "the check rejects these inputs"
 * but "there is no code path from a request to a peer id".
 */

import { describe, expect, it } from "vitest";
import { PIN_REFUSED, pinnedPeer } from "../src/pin.js";
import { createHostApp, type HostLog, OTHER_PEER } from "./host-app.js";

const PINNED_PEER = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";

describe("06 — the ghost's pin, in Node", () => {
  function build_() {
    const log: HostLog = { seen: [], lastAuth: null };
    const reached: string[] = [];
    const handler = pinnedPeer({
      landing: { peerId: PINNED_PEER, appPath: "/app" },
      basePath: "/ghost/",
      token: () => "VIEWER-TOKEN",
      remote: async (peerId, request) => {
        reached.push(peerId);
        return createHostApp(log, false)(request);
      },
    });
    return { handler, log, reached };
  }

  it("CLAIM 1 — a request through the ghost reaches the pinned peer, under the host's own mount", async () => {
    const { handler, log, reached } = build_();
    const res = await handler(new Request("http://viewer.local/ghost/asset.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset-from-host");
    expect(reached).toEqual([PINNED_PEER]);
    // The host sees its own path, never the viewer's mount.
    expect(log.seen).toEqual(["/app/asset.txt"]);
  });

  it("CLAIM 2 — the viewer's token is attached for the pinned peer", async () => {
    const { handler, log } = build_();
    await handler(new Request("http://viewer.local/ghost/asset.txt"));
    expect(log.lastAuth).toBe("VIEWER-TOKEN");
  });

  it("CLAIM 3 — a path naming ANOTHER peer is refused, not forwarded", async () => {
    const { handler, reached } = build_();
    const res = await handler(new Request(`http://viewer.local/ghost/${OTHER_PEER}/anything`));
    expect(res.status).toBe(403);
    expect(res.headers.get(PIN_REFUSED)).toBe("pinned");
    // The decisive part: nothing was dialled at all.
    expect(reached).toEqual([]);
  });

  it("CLAIM 4 — there is no input that makes the pin name a different peer", async () => {
    const { handler, reached } = build_();
    for (const path of [
      `/ghost/${OTHER_PEER}`,
      `/ghost/../${OTHER_PEER}/x`,
      `/ghost/%2e%2e/${OTHER_PEER}/x`,
      `/ghost/x?peer=${OTHER_PEER}`,
      `/ghost/x#${OTHER_PEER}`,
    ]) {
      await handler(new Request(`http://viewer.local${path}`)).catch(() => undefined);
    }
    // Every call either refused or went to the pinned peer; none named another.
    expect(reached.every((p) => p === PINNED_PEER)).toBe(true);
    expect(reached).not.toContain(OTHER_PEER);
  });
});

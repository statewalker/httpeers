import { registerPeer } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { stampGuest } from "../src/stamp-guest.js";
import { BRIDGE_GUEST_HEADER } from "../src/upstreams.js";

const echoGuest = stampGuest(
  async (req) => new Response(req.headers.get(BRIDGE_GUEST_HEADER) ?? "none"),
);

describe("stampGuest", () => {
  it("names the Guest the mesh proved, overwriting the one the Guest sent", async () => {
    const req = new Request("http://sharer/s/app/", {
      headers: { [BRIDGE_GUEST_HEADER]: "12D3KooWClaudia" },
    });
    registerPeer(req, "12D3KooWMarta");
    expect(await (await echoGuest(req)).text()).toBe("12D3KooWMarta");
  });

  it("names nobody for a request with no proven peer", async () => {
    const req = new Request("http://sharer/s/app/", {
      headers: { [BRIDGE_GUEST_HEADER]: "12D3KooWClaudia" },
    });
    expect(await (await echoGuest(req)).text()).toBe("none");
  });
});

describe("stampGuest, streaming bodies", () => {
  it("passes a streaming request body on (a live connection's frames, an upload)", async () => {
    const echo = stampGuest(async (req) => new Response(req.body));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("frames"));
        c.close();
      },
    });
    const req = new Request("http://sharer/s/app/", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(await (await echo(req)).text()).toBe("frames");
  });
});

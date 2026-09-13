/**
 * What the ghost sends onward carries no identity of the viewer's.
 *
 * The rendered page is somebody else's HTML running in the viewer's browser,
 * so every header it can set is attacker-controlled. The proven-peer header is
 * stripped on the way out for the same reason the pin exists: the host peer
 * must learn nothing about the viewer that the viewer did not choose to send,
 * and must not receive a claim it might be tempted to believe.
 */
import { describe, expect, it } from "vitest";
import { lookupPeer, PEER_ID_HEADER, registerPeer } from "@statewalker/httpeers-core";
import { pinnedPeer } from "../src/pin.js";

const HOST = `12D3KooW${"H".repeat(44)}`;

describe("the ghost forwards identity-free", () => {
  it("strips a peer header the rendered page supplied", async () => {
    let forwarded: Request | null = null;
    const ghost = pinnedPeer({
      landing: { peerId: HOST, appPath: "/app" },
      basePath: "/ghost/",
      token: () => "VIEWER-TOKEN",
      remote: async (_peerId, req) => {
        forwarded = req;
        return new Response("ok");
      },
    });

    const req = new Request("http://viewer.example/ghost/index.html", {
      headers: { [PEER_ID_HEADER]: `12D3KooW${"M".repeat(44)}` },
    });
    registerPeer(req, `12D3KooW${"V".repeat(44)}`);
    await ghost(req);

    expect(forwarded).not.toBeNull();
    expect(lookupPeer(forwarded as unknown as Request)).toBeUndefined();
    // The viewer's own token still goes, which is what authorises the call.
    expect((forwarded as unknown as Request).headers.get("authorization")).toBe(
      "Bearer VIEWER-TOKEN",
    );
  });
});

/**
 * What the ghost sends onward carries no identity of the viewer's.
 *
 * The rendered page is somebody else's HTML running in the viewer's browser,
 * so every header it can set is attacker-controlled. The proven-peer header is
 * stripped on the way out for the same reason the pin exists: the host peer
 * must learn nothing about the viewer that the viewer did not choose to send,
 * and must not receive a claim it might be tempted to believe.
 */

import {
  lookupPeer,
  MESH_TOKEN_HEADER,
  PEER_ID_HEADER,
  registerPeer,
} from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
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
    expect((forwarded as unknown as Request).headers.get(MESH_TOKEN_HEADER)).toBe("VIEWER-TOKEN");
  });

  it("replaces a membership token the page supplied, and leaves its Authorization alone", async () => {
    // The page may not choose the mesh credential -- the viewer's token is the
    // one that authorises the call, whatever the page wrote. `Authorization`
    // is the page's own header for its own app and is not the mesh's to touch.
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

    await ghost(
      new Request("http://viewer.example/ghost/api", {
        headers: { [MESH_TOKEN_HEADER]: "PAGE-FORGED", authorization: "Bearer app-session" },
      }),
    );

    const out = forwarded as unknown as Request;
    expect(out.headers.get(MESH_TOKEN_HEADER)).toBe("VIEWER-TOKEN");
    expect(out.headers.get("authorization")).toBe("Bearer app-session");
  });
});

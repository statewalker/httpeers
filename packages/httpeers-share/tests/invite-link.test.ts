/**
 * 06 — Does one link format survive QR, chat apps and the join?
 */

import { decodeQr, type Pixels, qrModules } from "@statewalker/httpeers-qr";
import { describe, expect, it } from "vitest";
import { decodeInvite, encodeInvite, type InviteLink } from "../src/invite-link.js";

const PAGE = "https://tools.sandclaw.ai/peer-share/invite";
const INVITE: InviteLink = {
  relayAddrs: [
    "/dns4/relay.httpeers.net/tcp/443/wss/p2p/12D3KooWRelayRelayRelayRelayRelayRelayRelayRelay12",
  ],
  sharerPeerId: "12D3KooWDirkDirkDirkDirkDirkDirkDirkDirkDirkDirkDir",
  invitationId: "a41d07b9c3e24f6f8e0d5b1a2c3d4e5f",
  sharerName: "Dirk",
};

describe("06 — the Invite link", () => {
  it("round-trips everything a Guest needs to join", () => {
    expect(decodeInvite(encodeInvite(PAGE, INVITE))).toEqual(INVITE);
  });

  it("keeps the invitation in the fragment: the page's server never receives it", () => {
    const url = new URL(encodeInvite(PAGE, INVITE));
    // What a browser actually sends when the Guest opens the link.
    const sent = `${url.origin}${url.pathname}${url.search}`;

    expect(sent).toBe(PAGE);
    expect(url.hash).toContain("join=");
  });

  it("names no Service: an Invite admits to all of the Sharer's Services", () => {
    expect(encodeInvite(PAGE, INVITE)).not.toMatch(/fooService|\/s\//);
  });

  it("survives a QR code, pixel for pixel", () => {
    const link = encodeInvite(PAGE, INVITE);
    expect(decodeQr(render(qrModules(link)))).toBe(link);
  });

  it("survives chat apps: no characters that need escaping, short enough to paste", () => {
    const link = encodeInvite(PAGE, INVITE);
    expect(link).toMatch(/^[A-Za-z0-9:/.#=&%_~+-]+$/);
    expect(link.length).toBeLessThan(400);
  });

  it("tells a person what is wrong with a link that is not an Invite", () => {
    expect(() => decodeInvite(PAGE)).toThrow(/not a PeerShare invite link/);
  });
});

/** QR modules to RGBA pixels: 4 px per module, a 4-module quiet zone, as a screen shows it. */
function render(modules: boolean[][], scale = 4, quiet = 4): Pixels {
  const size = (modules.length + 2 * quiet) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const [y, row] of modules.entries()) {
    for (const [x, dark] of row.entries()) {
      if (!dark) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

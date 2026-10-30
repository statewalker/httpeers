/**
 * The Invite link: what the Sharer copies, and what the QR code holds.
 *
 * `https://tools.sandclaw.ai/peer-share/invite#join=<blob>&from=Dirk`
 *
 * The join blob is httpeers' own (`encodeJoinBlob`), so the existing join
 * tooling can read it. But it travels in the FRAGMENT, not in httpeers'
 * `?join=` query: a fragment never leaves the browser, so the page's server
 * (and its logs, and any proxy) never sees an Invite, which is a bearer
 * credential until it is spent.
 */

import { decodeJoinBlob, encodeJoinBlob } from "@statewalker/httpeers-member";

export interface InviteLink {
  relayAddrs: string[];
  sharerPeerId: string;
  invitationId: string;
  /** Shown before joining: "Dirk invited you". */
  sharerName: string;
}

export function encodeInvite(pageUrl: string, invite: InviteLink): string {
  const url = new URL(pageUrl);
  const fragment = new URLSearchParams({
    join: encodeJoinBlob({
      relayAddrs: invite.relayAddrs,
      hubPeerId: invite.sharerPeerId,
      invitationId: invite.invitationId,
    }),
    from: invite.sharerName,
  });
  url.hash = fragment.toString();
  return url.toString();
}

export function decodeInvite(link: string): InviteLink {
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  const join = fragment.get("join");
  if (join == null) throw new Error("This is not a PeerShare invite link: it has no #join=… part.");
  const blob = decodeJoinBlob(join);
  return {
    relayAddrs: blob.relayAddrs,
    sharerPeerId: blob.hubPeerId,
    invitationId: blob.invitationId,
    sharerName: fragment.get("from") ?? "Someone",
  };
}

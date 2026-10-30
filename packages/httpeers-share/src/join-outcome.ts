/**
 * The Guest's side of a membership: join, come back, Close session.
 */

export type JoinOutcome = "joined" | "invite-used" | "invite-expired" | "machine-offline";

/**
 * What a failed join means to the Guest, for the Join screen.
 *
 * Measured against httpeers-member 0.1.6: a used and an expired Invite are
 * both `MemberJoinError("invitation-refused")`, told apart only by the hub's
 * answer quoted inside the message (`{"error":"invitation already-redeemed"}`
 * / `{"error":"invitation expired"}`). An offline Sharer is a plain `Error`:
 * the relay holds no reservation for it (`NO_RESERVATION`). Reading text is
 * fragile; httpeers should carry the hub's reason as a field (see README).
 */
export function joinOutcome(error: unknown): JoinOutcome {
  const text = describe(error);
  if (/already-redeemed/.test(text)) return "invite-used";
  if (/invitation expired/.test(text)) return "invite-expired";
  // Everything else is the Sharer not being reachable: offline, tab closed,
  // or the relay unable to find it. The Guest's next step is the same: wait.
  return "machine-offline";
}

function describe(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e != null; e = (e as { cause?: unknown }).cause) {
    parts.push(e instanceof Error ? e.message : String(e));
    if (parts.length > 5) break;
  }
  return parts.join(" | ");
}

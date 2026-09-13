/**
 * Turn anything thrown into something a person can act on.
 *
 * WHY THIS EXISTS. Every "could not reach the relay" message in this app ended
 * with `Cause: ${String(err)}`, and a failed WebSocket does not reject with an
 * `Error` -- it rejects with a DOM `Event`. `String(event)` is
 * **"[object Event]"**. A phone that could not reach the relay reported exactly
 * that, and it named nothing: not the URL, not whether the socket ever opened,
 * not whether it was closed or refused. The one message whose entire job was to
 * explain a connection failure discarded every fact about it.
 *
 * The event carries what is needed -- `type`, `target.url`, `target.readyState`
 * and, for a close event, `code` and `reason`. This reads them defensively,
 * because an object that is not what we assume must not turn a bad error message
 * into a second exception thrown while reporting the first.
 */

/** WebSocket.readyState, in words. The bare number tells a reader nothing. */
const READY_STATE = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const;

function pick(obj: unknown, key: string): unknown {
  try {
    return obj != null && typeof obj === "object"
      ? (obj as Record<string, unknown>)[key]
      : undefined;
  } catch {
    // A getter that throws must not take the error report down with it.
    return undefined;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause == null || cause === err) return err.message;
    // Compare the DESCRIPTIONS, not the objects. libp2p wraps a WebSocket
    // error event in an Error whose `cause` is a different object describing
    // the same failure, so identity comparison lets it print twice --
    // "socket CLOSED (cause: ... socket CLOSED)" -- which reads like two
    // problems.
    const described = describeError(cause);
    return err.message.includes(described) ? err.message : `${err.message} (cause: ${described})`;
  }

  const type = pick(err, "type");
  if (typeof type === "string") {
    const target = pick(err, "target");
    const parts: string[] = [`${type} event`];

    const url = pick(target, "url");
    if (typeof url === "string" && url !== "") parts.push(url);

    const state = pick(target, "readyState");
    if (typeof state === "number" && READY_STATE[state] != null) {
      parts.push(`socket ${READY_STATE[state]}`);
    }

    const code = pick(err, "code");
    if (typeof code === "number") parts.push(`code ${code}`);

    const reason = pick(err, "reason");
    if (typeof reason === "string" && reason !== "") parts.push(`reason "${reason}"`);

    // A `error` event on a socket still CONNECTING means the connection was
    // never established -- DNS, TLS, a proxy or a blocked port -- rather than
    // anything the peers said to each other. That distinction is the whole
    // value of printing the state.
    return parts.join(", ");
  }

  try {
    return String(err);
  } catch {
    return "an error that could not be converted to a string";
  }
}

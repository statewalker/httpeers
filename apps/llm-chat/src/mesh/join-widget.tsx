/**
 * `@statewalker/httpeers-join`'s widget, in React: the join form, the link status and the leaving
 * controls that every page joining a hub shows the same way.
 *
 * THE WIDGET IS PLAIN DOM, so this is the whole adapter: mount it once per session (and per
 * `compact`), hand it every state React already holds, destroy it on unmount. The session and its
 * state stay here in React; the widget holds neither.
 *
 * Lives in `mesh/`, not `ui/`: it imports httpeers, and the boundary test keeps everything the
 * standalone page reaches free of that.
 */

import { type JoinWidget, mountJoinWidget } from "@statewalker/httpeers-join";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { useEffect, useRef } from "react";

export function JoinWidgetView({
  session,
  state,
  compact = false,
}: {
  session: PeerSession;
  state: SessionState | null;
  compact?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<JoinWidget | null>(null);
  /** The latest state, for a remount: the mount effect must not re-run on every state. */
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (host.current == null) return;
    const mounted = mountJoinWidget(host.current, { session, compact, state: latest.current });
    widget.current = mounted;
    return () => {
      mounted.destroy();
      widget.current = null;
    };
  }, [session, compact]);

  useEffect(() => {
    widget.current?.update(state);
  }, [state]);

  return <div ref={host} className={compact ? "contents" : undefined} />;
}

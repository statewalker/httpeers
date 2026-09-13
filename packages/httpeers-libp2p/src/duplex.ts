/**
 * 09 — the second altitude: duplex streams over the same mesh.
 *
 * WHY THIS EXISTS. `Handler = (Request) => Promise<Response>` cannot express a
 * WebSocket, an A2UI message stream, or anything else where both ends keep
 * talking. It never could: `fetch` is not the foundation of this stack but a
 * NARROWING of it. `@statewalker/webrun-http-streams` builds fetch semantics on
 * a `Duplex`, and `httpeers.core`'s transport performs that narrowing at two
 * call sites. So adding duplex REMOVES a restriction rather than adding a
 * layer — webrun-wire's ADR-0004 calls `Duplex` "the canonical adapter seam".
 *
 *   Duplex = (input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *   1. IDENTITY IS AN ARGUMENT, NOT A LOOKUP. The fetch path carries the
 *      proven peer in a `WeakMap<Request, …>` written inside the per-stream
 *      closure. A duplex has no `Request` to key on, so `DuplexContext.peerId`
 *      is passed to the handler. `serveConnections` gives us the only claim
 *      that cannot be forged by the payload: `ConnectionContext.remotePeer`.
 *   2. A SEPARATE PROTOCOL ID. `/httpeers-duplex/1.0.0` lives beside
 *      `/httpeers/1.0.0`, so the fetch path is untouched and cannot regress.
 *   3. THE OPEN FRAME IS THE EXISTING ENVELOPE. `encodeMessage`/`decodeMessage`
 *      from webrun-http-streams — JSON line, then body bytes. Nothing new on
 *      the wire.
 */

import type { Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { decodeMessage, encodeMessage } from "@statewalker/webrun-http-streams";
import type { Duplex } from "@statewalker/webrun-streams";
import {
  type ConnectionContext,
  connect,
  serveConnections,
} from "@statewalker/webrun-streams-libp2p";

export const DUPLEX_PROTOCOL = "/httpeers-duplex/1.0.0";

/** What a duplex handler is told. The peer is an argument because there is no Request to key a map on. */
export interface DuplexContext {
  /** Proven by the Noise handshake. Never read from the payload. */
  readonly peerId: string;
  readonly path: string;
  /** Whatever the caller put in the open frame. A CLAIM, never proof — see `peerId`. */
  readonly token?: string;
}

export type DuplexHandler = (
  input: AsyncIterable<Uint8Array>,
  ctx: DuplexContext,
) => AsyncIterable<Uint8Array>;

export interface DuplexMounts {
  /** Longest-prefix on segment boundaries, like the fetch router. */
  provide(prefix: string, handler: DuplexHandler): () => void;
  match(path: string): { handler: DuplexHandler; prefix: string } | null;
  list(): string[];
}

export function createDuplexMounts(): DuplexMounts {
  const table: { prefix: string; handler: DuplexHandler }[] = [];
  const norm = (p: string): string => (p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p);

  return {
    provide(prefix, handler) {
      const entry = { prefix: norm(prefix), handler };
      table.push(entry);
      table.sort((a, b) => b.prefix.length - a.prefix.length);
      return () => {
        const at = table.indexOf(entry);
        if (at >= 0) table.splice(at, 1);
      };
    },
    match(path) {
      const target = norm(path);
      const hit = table.find(
        (m) => m.prefix === "/" || target === m.prefix || target.startsWith(`${m.prefix}/`),
      );
      return hit == null ? null : { handler: hit.handler, prefix: hit.prefix };
    },
    list: () => table.map((m) => m.prefix),
  };
}

/** Thrown into the caller's stream when no mount claims the path. */
export const NO_MOUNT = "httpeers-duplex: no mount for ";

export interface ServeDuplexInit {
  node: Libp2p;
  mounts: DuplexMounts;
  protocol?: string;
  /** Left unset, libp2p's default (32) applies — the ceiling on concurrent inbound streams. */
  maxInboundStreams?: number;
  /** A relayed circuit is a limited connection; libp2p refuses this protocol on one unless told otherwise. */
  runOnLimitedConnection?: boolean;
}

/** Register the duplex protocol. Returns the teardown `serveConnections` gives us. */
export async function serveDuplex(init: ServeDuplexInit): Promise<() => Promise<void>> {
  return await serveConnections(
    {
      node: init.node,
      protocol: init.protocol ?? DUPLEX_PROTOCOL,
      ...(init.maxInboundStreams == null ? {} : { maxInboundStreams: init.maxInboundStreams }),
      ...(init.runOnLimitedConnection == null
        ? {}
        : { runOnLimitedConnection: init.runOnLimitedConnection }),
    },
    // Called ONCE PER INBOUND STREAM, which is what keeps the proven peer in
    // the closure and out of the payload.
    (context: ConnectionContext): Duplex => {
      const peerId = context.remotePeer.toString();
      return async function* (input): AsyncGenerator<Uint8Array> {
        const { envelope, body } = await decodeMessage<{ path: string; token?: string }>(input);
        const found = init.mounts.match(envelope.path);
        if (found == null) throw new Error(`${NO_MOUNT}${envelope.path}`);
        yield* found.handler(body, {
          peerId,
          path: envelope.path,
          ...(envelope.token == null ? {} : { token: envelope.token }),
        });
      };
    },
  );
}

export interface OpenDuplexInit {
  node: Libp2p;
  peerId: string;
  path: string;
  token?: string;
  protocol?: string;
  runOnLimitedConnection?: boolean;
}

export interface PeerDuplex {
  readonly peerId: string;
  readonly path: string;
  /** Feed it outbound bytes, iterate the inbound ones. */
  readonly call: Duplex;
  close(): Promise<void>;
}

/**
 * Open a duplex stream to `(peerId, path)`.
 *
 * ADDRESSED BY A PAIR, NEVER BY A URL. A URL is the fetch layer's addressing
 * scheme and a duplex stream has no request-line; reusing `peer://…` here
 * would also re-open the URL-derived-peer hole the ghost's pin exists to
 * close (`new URL("peer://a@b/x").host === "b"`, measured in rung 06).
 */
export async function openDuplex(init: OpenDuplexInit): Promise<PeerDuplex> {
  const conn = await connect({
    node: init.node,
    peer: peerIdFromString(init.peerId),
    protocol: init.protocol ?? DUPLEX_PROTOCOL,
    ...(init.runOnLimitedConnection == null
      ? {}
      : { runOnLimitedConnection: init.runOnLimitedConnection }),
  });

  const call: Duplex = (input) =>
    conn.call(
      encodeMessage(
        { path: init.path, ...(init.token == null ? {} : { token: init.token }) },
        input,
      ),
    );

  return { peerId: init.peerId, path: init.path, call, close: conn.close };
}

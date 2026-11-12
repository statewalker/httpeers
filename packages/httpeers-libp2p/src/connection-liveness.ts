/**
 * A connection monitor that does not kill a busy, healthy connection (#56).
 *
 * THE PROBLEM. libp2p 3's own connection monitor pings every connection every
 * 10 s, with an adaptive timeout of 1.2 x the average ping time clamped to
 * 5-60 s, and by default ABORTS THE WHOLE CONNECTION when one ping fails. Its
 * ping is a new stream on the same connection, so under a bulk download on a
 * slow or lossy link it waits behind everything the other side has already
 * buffered. Once that is more than ~5 s of data, the healthy connection is torn
 * down and every exchange on it fails, on either exchange path. On the
 * emulated bad link (2 Mbit/s, 200 ms, 3% loss) every TCP run failed that way;
 * see `docs/mux-per-peer-network-bench.md`, "The connection dies".
 *
 * THE RULE HERE: a failed ping aborts the connection only when NOTHING WAS
 * RECEIVED on it since that ping was sent. Bytes arriving prove the remote is
 * alive and the path delivers; a ping stuck behind them proves nothing. A
 * connection that went silent (a peer that vanished without FIN or RST: a
 * crashed machine, a dropped NAT mapping, a pulled cable) receives nothing,
 * so its next failed ping still aborts it.
 *
 * Why the receiving side is enough on both ends of a bulk transfer: the side
 * that downloads receives the data itself; the side that sends receives the
 * yamux window updates the reader returns for every data frame it takes (and
 * the reader's own pings), on the direction that is NOT congested.
 *
 * DETECTION BOUND, unchanged from libp2p's on an idle connection: a silent
 * peer is aborted at the first ping that starts after it vanished and times
 * out, i.e. within `pingIntervalMs` + the ping timeout (10 s + 5 s with the
 * defaults, the timeout growing with slow measured pings, at most
 * `maxTimeout`). On a busy connection the clock starts when the last bytes
 * the peer sent before vanishing have arrived (what was still queued in the
 * network or its socket), then the same bound applies, plus at most one more
 * interval if those last bytes arrived during a ping.
 *
 * HOW BYTES ARE SEEN. libp2p exposes no per-connection byte counter. Its
 * `Connection` keeps the raw transport connection (`maConn`, a message
 * stream that dispatches every chunk read from the socket as a `message`
 * event); libp2p's own metrics (`trackMultiaddrConnection`) count bytes the
 * same way, by listening to it. This adds one more listener that records a
 * timestamp, nothing else: no copy, no buffering, no change to what the
 * encrypter above it reads. A connection whose `maConn` cannot be observed
 * (another libp2p, another transport shape) is treated as never receiving,
 * which is libp2p's own behaviour: a failed ping aborts it.
 *
 * The ping itself is libp2p's, byte for byte: `/ipfs/ping/1.0.0`, 32 random
 * bytes echoed, an `UnsupportedProtocolError` counting as an answer (the
 * peer ran multistream-select, so it is alive). Peers that run either monitor
 * or none interoperate.
 */
import type {
  ComponentLogger,
  Connection,
  Libp2pEvents,
  Logger,
  Startable,
  TypedEventTarget,
} from "@libp2p/interface";
import { AdaptiveTimeout, type AdaptiveTimeoutInit, byteStream } from "@libp2p/utils";

/** libp2p's ping protocol, which its own connection monitor also uses. */
export const LIVENESS_PING_PROTOCOL = "/ipfs/ping/1.0.0";

/** The service name `createNode` registers {@link connectionLiveness} under. */
export const CONNECTION_LIVENESS_SERVICE = "connectionLiveness";

/** How often every connection is pinged (libp2p's default). */
export const DEFAULT_LIVENESS_PING_INTERVAL_MS = 10_000;

/** The ping's payload length (libp2p's). */
const PING_LENGTH = 32;

/**
 * What a failed ping does to its connection.
 *
 * - `"when-silent"` (the default): abort only when nothing was received on
 *   the connection since the ping was sent.
 * - `"always"`: libp2p's default behaviour; a busy connection on a slow link
 *   can be killed by its own queue.
 * - `"never"`: only measure. A silent dead peer is then left to TCP and to
 *   whatever times out above it (requests, the mux keepalive), which on an
 *   idle connection can be minutes or never.
 */
export type AbortOnPingFailure = "when-silent" | "always" | "never";

/** Tuning for {@link connectionLiveness}. Every field is optional. */
export interface ConnectionLivenessOptions {
  /** How often to ping every connection, in ms. Default {@link DEFAULT_LIVENESS_PING_INTERVAL_MS}. */
  pingIntervalMs?: number;
  /**
   * The ping's adaptive timeout (`@libp2p/utils`' `AdaptiveTimeout`):
   * `minTimeout` (default 5 000 ms), `maxTimeout` (default 60 000 ms),
   * `timeoutMultiplier` (default 1.2 x the moving average of past pings).
   */
  pingTimeout?: Pick<
    AdaptiveTimeoutInit,
    "minTimeout" | "maxTimeout" | "timeoutMultiplier" | "failureMultiplier" | "interval"
  >;
  /** Default `"when-silent"`. See {@link AbortOnPingFailure}. */
  abortOnPingFailure?: AbortOnPingFailure;
}

/** The standard libp2p components this service reads; `createLibp2p` hands every service all of them. */
export interface ConnectionLivenessComponents {
  connectionManager: { getConnections(): Connection[] };
  events: TypedEventTarget<Libp2pEvents>;
  logger: ComponentLogger;
}

/** The running service; `lastReceivedAt` is exposed for tests and diagnostics. */
export interface ConnectionLiveness extends Startable {
  /** When bytes last arrived on `connection` (ms since the epoch), or `undefined` if it is not observed. */
  lastReceivedAt(connection: Connection): number | undefined;
}

/**
 * A libp2p service that replaces libp2p's connection monitor; pass it beside
 * `connectionMonitor: { enabled: false }` so the connection is not pinged
 * twice. `createNode` does both unless told otherwise; a node built by hand
 * should too:
 *
 *   createLibp2p({
 *     ...,
 *     connectionMonitor: { enabled: false },
 *     services: { identify: identify(), connectionLiveness: connectionLiveness() },
 *   })
 */
export function connectionLiveness(
  options: ConnectionLivenessOptions = {},
): (components: ConnectionLivenessComponents) => ConnectionLiveness {
  return (components) => new LivenessMonitor(components, options);
}

/** A raw transport connection, as far as this needs it: something that emits `message` per chunk read. */
interface ObservableMaConn {
  addEventListener(type: "message", listener: () => void): void;
}

class LivenessMonitor implements ConnectionLiveness {
  readonly [Symbol.toStringTag] = "@statewalker/httpeers-libp2p/connection-liveness";
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly abortMode: AbortOnPingFailure;
  private readonly timeout: AdaptiveTimeout;
  private readonly received = new WeakMap<Connection, number>();
  /** Connections already looked at, observable or not, so each gets one listener at most. */
  private readonly attached = new WeakSet<Connection>();
  private readonly inFlight = new WeakSet<Connection>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopper: AbortController | undefined;

  constructor(
    private readonly components: ConnectionLivenessComponents,
    options: ConnectionLivenessOptions,
  ) {
    this.log = components.logger.forComponent("httpeers:connection-liveness");
    this.intervalMs = options.pingIntervalMs ?? DEFAULT_LIVENESS_PING_INTERVAL_MS;
    this.abortMode = options.abortOnPingFailure ?? "when-silent";
    this.timeout = new AdaptiveTimeout({ ...(options.pingTimeout ?? {}) });
  }

  private readonly onConnectionOpen = (event: CustomEvent<Connection>): void => {
    this.observe(event.detail);
  };

  start(): void {
    this.stopper = new AbortController();
    this.components.events.addEventListener("connection:open", this.onConnectionOpen);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    this.components.events.removeEventListener("connection:open", this.onConnectionOpen);
    this.stopper?.abort();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  lastReceivedAt(connection: Connection): number | undefined {
    return this.received.get(connection);
  }

  private observe(connection: Connection): void {
    if (this.attached.has(connection)) return;
    this.attached.add(connection);
    const maConn = (connection as unknown as { maConn?: Partial<ObservableMaConn> }).maConn;
    if (typeof maConn?.addEventListener !== "function") {
      this.log("connection %s exposes no transport stream; a failed ping aborts it", connection.id);
      return;
    }
    this.received.set(connection, Date.now());
    (maConn as ObservableMaConn).addEventListener("message", () => {
      this.received.set(connection, Date.now());
    });
  }

  private tick(): void {
    for (const connection of this.components.connectionManager.getConnections()) {
      this.observe(connection);
      // One ping per connection at a time: a slow one is not stacked on.
      if (this.inFlight.has(connection)) continue;
      this.inFlight.add(connection);
      void this.check(connection).finally(() => this.inFlight.delete(connection));
    }
  }

  private async check(connection: Connection): Promise<void> {
    const sentAt = Date.now();
    try {
      await this.ping(connection);
    } catch (error) {
      if (this.stopper?.signal.aborted === true || connection.status !== "open") return;
      const last = this.received.get(connection);
      const progressed = last !== undefined && last >= sentAt;
      if (this.abortMode === "always" || (this.abortMode === "when-silent" && !progressed)) {
        this.log.error(
          "aborting connection %s to %p: ping failed and nothing arrived for %d ms - %e",
          connection.id,
          connection.remotePeer,
          Date.now() - (last ?? sentAt),
          error,
        );
        connection.abort(error as Error);
      } else {
        this.log(
          "ping on connection %s failed, keeping it (%s) - %e",
          connection.id,
          progressed ? "bytes arrived meanwhile" : "abortOnPingFailure is never",
          error,
        );
      }
    }
  }

  /** libp2p's connection-monitor ping, unchanged. */
  private async ping(connection: Connection): Promise<void> {
    const signal = this.timeout.getTimeoutSignal({ signal: this.stopper?.signal });
    let start = Date.now();
    let stream: Awaited<ReturnType<Connection["newStream"]>> | undefined;
    try {
      stream = await connection.newStream(LIVENESS_PING_PROTOCOL, {
        signal,
        runOnLimitedConnection: true,
      });
      const bytes = byteStream(stream);
      start = Date.now();
      await Promise.all([
        bytes.write(crypto.getRandomValues(new Uint8Array(PING_LENGTH)), { signal }),
        bytes.read({ bytes: PING_LENGTH, signal }),
      ]);
      connection.rtt = Date.now() - start;
      await stream.close({ signal });
    } catch (error) {
      stream?.abort(error as Error);
      if ((error as Error).name !== "UnsupportedProtocolError") throw error;
      // The peer answered multistream-select (two round trips): alive.
      connection.rtt = (Date.now() - start) / 2;
    } finally {
      this.timeout.cleanUp(signal);
    }
  }
}

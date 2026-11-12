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
 * so its failed pings still abort it.
 *
 * Why the receiving side is enough on both ends of a bulk transfer: the side
 * that downloads receives the data itself; the side that sends receives the
 * yamux window updates the reader returns for every data frame it takes (and
 * the reader's own pings), on the direction that is NOT congested.
 *
 * A SHARED, CONGESTED ACCESS LINK. An idle connection that shares a congested
 * link with a busy one (a member's relay reservation while it downloads from
 * another peer) waits as long for its pings and receives nothing meanwhile.
 * So when the NODE as a whole received a real amount of data (at least
 * 64 KiB, far above ping and keepalive chatter) during a silent connection's
 * failed ping, that is read as congestion rather than death once: the
 * connection is aborted at its second silent failure in a row
 * (`silentFailuresWhenBusy`, default 2), not its first. A queue that delays
 * pings past two intervals still costs such a connection; that is the limit
 * of a mitigation that keeps the dead-peer bound short.
 *
 * DETECTION BOUND for a peer that vanishes silently, with I the ping interval
 * and T that connection's ping timeout (10 s and 5 s by default): I + T
 * (15 s) while the node receives nothing else, 2 I + T (25 s) while it is
 * busy elsewhere. On a connection that was itself busy the clock starts once
 * the last bytes the peer sent before vanishing have arrived (what was still
 * queued in the network or its socket), plus at most one more interval if
 * they arrived during a ping.
 *
 * ONE TIMEOUT ESTIMATOR PER CONNECTION, FED ONLY BY ANSWERED PINGS. A shared
 * estimator lets one connection's slow or failing pings raise every other
 * connection's timeout toward its 60 s ceiling, and with it every other
 * connection's detection time. A failed ping is not a round-trip sample
 * either: feeding it (libp2p doubles it into the average) only lengthens the
 * next timeout of the very connection most likely to be failing, the opposite
 * of what detection needs. Answered pings, however slow, are real samples and
 * still adapt the timeout to a slow link.
 *
 * HOW BYTES ARE SEEN. libp2p exposes no per-connection byte counter.
 *
 * - TCP, WebSockets, relayed circuits: the `Connection` keeps the raw transport
 *   connection (`maConn`), a message stream that dispatches every chunk read as
 *   a `message` event; libp2p's own metrics count bytes by listening to it.
 *   This adds one listener that records a timestamp, nothing else (no copy, no
 *   buffering, no change to what the encrypter above reads), and removes it on
 *   stop. Never a listener on a muxed stream: that would start delivery before
 *   the stream's real reader attaches.
 * - WebRTC: its `maConn` wraps an `RTCPeerConnection` and never dispatches
 *   `message` (the data travels on data channels). The byte count comes from
 *   `getStats()` instead (`transport` stats, else the candidate pairs'
 *   `bytesReceived`; browsers and node-datachannel both report them), sampled
 *   when a ping starts and when it fails.
 * - Anything else is treated as never receiving, which is libp2p's own rule:
 *   a failed ping aborts it.
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
  MetricGroup,
  Metrics,
  Startable,
  TypedEventTarget,
} from "@libp2p/interface";
import {
  AdaptiveTimeout,
  type AdaptiveTimeoutInit,
  type AdaptiveTimeoutSignal,
  byteStream,
} from "@libp2p/utils";

/** libp2p's ping protocol, which its own connection monitor also uses. */
export const LIVENESS_PING_PROTOCOL = "/ipfs/ping/1.0.0";

/** The service name `createNode` registers {@link connectionLiveness} under. */
export const CONNECTION_LIVENESS_SERVICE = "connectionLiveness";

/** How often every connection is pinged (libp2p's default). */
export const DEFAULT_LIVENESS_PING_INTERVAL_MS = 10_000;

/** Silent failed pings in a row that abort a connection while the node receives elsewhere. */
export const DEFAULT_SILENT_FAILURES_WHEN_BUSY = 2;

/**
 * Bytes the whole node must receive during a silent connection's failed ping
 * for it to count as busy (a congested shared link) rather than quiet. Far
 * above what pings and keepalives of many idle connections add up to.
 */
export const NODE_BUSY_BYTES = 64 * 1024;

/** The ping's payload length (libp2p's). */
const PING_LENGTH = 32;

/** libp2p's connection-monitor metric, recorded here in its place. */
const PING_METRIC = "libp2p_connection_monitor_ping_time_milliseconds";

/**
 * What a failed ping does to its connection.
 *
 * - `"when-silent"` (the default): abort only when nothing was received on
 *   the connection since the ping was sent (at the second such failure in a
 *   row while the node receives on other connections).
 * - `"always"`: libp2p's default behaviour; a busy connection on a slow link
 *   can be killed by its own queue.
 * - `"never"`: only measure. A silent dead peer is then left to TCP and to
 *   whatever times out above it (requests, the mux keepalive), which on an
 *   idle connection can be minutes or never.
 */
export type AbortOnPingFailure = "when-silent" | "always" | "never";

/** How the monitor sees a connection's received bytes. */
export type ByteSource = "transport-events" | "webrtc-stats" | "none";

/** Tuning for {@link connectionLiveness}. Every field is optional. */
export interface ConnectionLivenessOptions {
  /** How often to ping every connection, in ms. Default {@link DEFAULT_LIVENESS_PING_INTERVAL_MS}. */
  pingIntervalMs?: number;
  /**
   * The ping's adaptive timeout (`@libp2p/utils`' `AdaptiveTimeout`, one per
   * connection): `minTimeout` (default 5 000 ms), `maxTimeout` (default
   * 60 000 ms), `timeoutMultiplier` (default 1.2 x the moving average of that
   * connection's answered pings).
   */
  pingTimeout?: Pick<
    AdaptiveTimeoutInit,
    "minTimeout" | "maxTimeout" | "timeoutMultiplier" | "interval"
  >;
  /** Default `"when-silent"`. See {@link AbortOnPingFailure}. */
  abortOnPingFailure?: AbortOnPingFailure;
  /**
   * Under `"when-silent"`: how many silent failed pings in a row abort a
   * connection while the node receives data on other connections (read as
   * congestion of a shared link). Default
   * {@link DEFAULT_SILENT_FAILURES_WHEN_BUSY}; `1` aborts at the first, as on
   * an idle node.
   */
  silentFailuresWhenBusy?: number;
}

/** The standard libp2p components this service reads; `createLibp2p` hands every service all of them. */
export interface ConnectionLivenessComponents {
  connectionManager: { getConnections(): Connection[] };
  events: TypedEventTarget<Libp2pEvents>;
  logger: ComponentLogger;
  metrics?: Metrics;
}

/** The running service; the accessors are for tests and diagnostics. */
export interface ConnectionLiveness extends Startable {
  /** When bytes were last seen arriving on `connection` (ms since the epoch), if ever. */
  lastReceivedAt(connection: Connection): number | undefined;
  /** How received bytes are seen on `connection`, or `undefined` if it is not watched. */
  byteSource(connection: Connection): ByteSource | undefined;
  /** The timeout the next ping on `connection` gets, in ms, or `undefined` if it is not watched. */
  nextTimeoutMs(connection: Connection): number | undefined;
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
 *     services: { identify: identify(), [CONNECTION_LIVENESS_SERVICE]: connectionLiveness() },
 *   })
 */
export function connectionLiveness(
  options: ConnectionLivenessOptions = {},
): (components: ConnectionLivenessComponents) => ConnectionLiveness {
  return (components) => new LivenessMonitor(components, options);
}

/** The part of an `RTCPeerConnection` this reads. */
interface StatsSource {
  getStats(): Promise<{ forEach(callback: (stat: Record<string, unknown>) => void): void }>;
}

/**
 * Bytes received on a peer connection, from its stats: the `transport`
 * entries when there are any, else the candidate pairs. `undefined` when
 * neither reports `bytesReceived`.
 */
export async function statsBytesReceived(source: StatsSource): Promise<number | undefined> {
  const report = await source.getStats();
  let transport: number | undefined;
  let pairs: number | undefined;
  report.forEach((stat) => {
    const bytes = stat.bytesReceived;
    if (typeof bytes !== "number") return;
    if (stat.type === "transport") transport = (transport ?? 0) + bytes;
    else if (stat.type === "candidate-pair") pairs = (pairs ?? 0) + bytes;
  });
  return transport ?? pairs;
}

interface Watch {
  readonly source: ByteSource;
  readonly timeout: AdaptiveTimeout;
  lastReceivedAt: number | undefined;
  /** The last stats sample (WebRTC). */
  statsBytes: number | undefined;
  silentFailures: number;
  inFlight: boolean;
  detach: () => void;
  stats?: StatsSource;
}

class LivenessMonitor implements ConnectionLiveness {
  readonly [Symbol.toStringTag] = "@statewalker/httpeers-libp2p/connection-liveness";
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly abortMode: AbortOnPingFailure;
  private readonly silentFailuresWhenBusy: number;
  private readonly timeoutInit: ConnectionLivenessOptions["pingTimeout"];
  private readonly metric: MetricGroup | undefined;
  private readonly watches = new Map<Connection, Watch>();
  /** Bytes received on all watched connections: the congestion signal. */
  private nodeBytes = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopper: AbortController | undefined;

  constructor(
    private readonly components: ConnectionLivenessComponents,
    options: ConnectionLivenessOptions,
  ) {
    this.log = components.logger.forComponent("httpeers:connection-liveness");
    this.intervalMs = options.pingIntervalMs ?? DEFAULT_LIVENESS_PING_INTERVAL_MS;
    this.abortMode = options.abortOnPingFailure ?? "when-silent";
    this.silentFailuresWhenBusy = Math.max(
      1,
      options.silentFailuresWhenBusy ?? DEFAULT_SILENT_FAILURES_WHEN_BUSY,
    );
    this.timeoutInit = options.pingTimeout;
    this.metric = components.metrics?.registerMetricGroup(PING_METRIC);
  }

  private readonly onConnectionOpen = (event: CustomEvent<Connection>): void => {
    this.watch(event.detail);
  };

  private readonly onConnectionClose = (event: CustomEvent<Connection>): void => {
    this.unwatch(event.detail);
  };

  start(): void {
    this.stopper = new AbortController();
    this.components.events.addEventListener("connection:open", this.onConnectionOpen);
    this.components.events.addEventListener("connection:close", this.onConnectionClose);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    this.components.events.removeEventListener("connection:open", this.onConnectionOpen);
    this.components.events.removeEventListener("connection:close", this.onConnectionClose);
    this.stopper?.abort();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const connection of [...this.watches.keys()]) this.unwatch(connection);
  }

  lastReceivedAt(connection: Connection): number | undefined {
    return this.watches.get(connection)?.lastReceivedAt;
  }

  byteSource(connection: Connection): ByteSource | undefined {
    return this.watches.get(connection)?.source;
  }

  nextTimeoutMs(connection: Connection): number | undefined {
    const watch = this.watches.get(connection);
    if (watch === undefined) return undefined;
    const signal = watch.timeout.getTimeoutSignal();
    signal.clear();
    return signal.timeout;
  }

  private watch(connection: Connection): Watch {
    const existing = this.watches.get(connection);
    if (existing !== undefined) return existing;
    const timeout = new AdaptiveTimeout({ ...(this.timeoutInit ?? {}) });
    const maConn = (connection as unknown as { maConn?: Record<string, unknown> }).maConn;
    const peerConnection = maConn?.peerConnection as Partial<StatsSource> | undefined;
    let watch: Watch;
    if (typeof peerConnection?.getStats === "function") {
      watch = this.newWatch("webrtc-stats", timeout, () => {});
      watch.stats = peerConnection as StatsSource;
    } else if (typeof maConn?.addEventListener === "function") {
      const listener = (event: Event) => {
        watch.lastReceivedAt = Date.now();
        this.nodeBytes +=
          (event as Event & { data?: { byteLength?: number } }).data?.byteLength ?? 0;
      };
      const target = maConn as unknown as EventTarget;
      target.addEventListener("message", listener);
      watch = this.newWatch("transport-events", timeout, () =>
        target.removeEventListener("message", listener),
      );
    } else {
      this.log("connection %s exposes no byte count; a failed ping aborts it", connection.id);
      watch = this.newWatch("none", timeout, () => {});
    }
    this.watches.set(connection, watch);
    return watch;
  }

  private newWatch(source: ByteSource, timeout: AdaptiveTimeout, detach: () => void): Watch {
    return {
      source,
      timeout,
      lastReceivedAt: undefined,
      statsBytes: undefined,
      silentFailures: 0,
      inFlight: false,
      detach,
    };
  }

  private unwatch(connection: Connection): void {
    const watch = this.watches.get(connection);
    if (watch === undefined) return;
    this.watches.delete(connection);
    watch.detach();
  }

  private tick(): void {
    for (const connection of this.components.connectionManager.getConnections()) {
      const known = this.watches.has(connection);
      const watch = this.watch(connection);
      // Seen for the first time here (opened before start): no byte history
      // yet, so it is pinged from the next tick on, not judged on nothing.
      if (!known) continue;
      // One ping per connection at a time: a slow one is not stacked on.
      if (watch.inFlight) continue;
      watch.inFlight = true;
      void this.check(connection, watch).finally(() => {
        watch.inFlight = false;
      });
    }
    for (const connection of [...this.watches.keys()]) {
      if (connection.status !== "open") this.unwatch(connection);
    }
  }

  /** Sample a WebRTC connection's byte count; record progress like a `message` event would. */
  private async sample(watch: Watch): Promise<void> {
    if (watch.stats === undefined) return;
    try {
      const bytes = await statsBytesReceived(watch.stats);
      if (bytes === undefined) return;
      if (watch.statsBytes !== undefined && bytes > watch.statsBytes) {
        watch.lastReceivedAt = Date.now();
        this.nodeBytes += bytes - watch.statsBytes;
      }
      watch.statsBytes = bytes;
    } catch (error) {
      this.log("getStats failed - %e", error);
    }
  }

  private async check(connection: Connection, watch: Watch): Promise<void> {
    await this.sample(watch);
    const sentAt = Date.now();
    const nodeBytesAtSend = this.nodeBytes;
    try {
      await this.ping(connection, watch);
      watch.silentFailures = 0;
      return;
    } catch (error) {
      if (this.stopper?.signal.aborted === true || connection.status !== "open") return;
      await this.sample(watch);
      const nodeBusy = this.nodeBytes - nodeBytesAtSend >= NODE_BUSY_BYTES;
      this.judge(connection, watch, sentAt, nodeBusy, error as Error);
    }
  }

  private judge(
    connection: Connection,
    watch: Watch,
    sentAt: number,
    nodeBusy: boolean,
    error: Error,
  ): void {
    const last = watch.lastReceivedAt;
    const progressed = last !== undefined && last >= sentAt;
    let abort: boolean;
    let reason: string;
    if (this.abortMode === "always") {
      abort = true;
      reason = "abortOnPingFailure is always";
    } else if (this.abortMode === "never") {
      abort = false;
      reason = "abortOnPingFailure is never";
    } else if (progressed) {
      watch.silentFailures = 0;
      abort = false;
      reason = "bytes arrived meanwhile";
    } else {
      watch.silentFailures++;
      abort = !nodeBusy || watch.silentFailures >= this.silentFailuresWhenBusy;
      reason = nodeBusy
        ? `silent failure ${watch.silentFailures} of ${this.silentFailuresWhenBusy} while the node receives elsewhere`
        : "nothing arrived";
    }
    const silence =
      last === undefined
        ? "nothing seen since it was watched"
        : `last bytes ${Date.now() - last} ms ago`;
    if (abort) {
      this.log.error(
        "aborting connection %s to %p: ping failed (%s, %s, via %s) - %e",
        connection.id,
        connection.remotePeer,
        reason,
        silence,
        watch.source,
        error,
      );
      connection.abort(error);
    } else {
      this.log(
        "ping on connection %s failed, keeping it (%s, %s) - %e",
        connection.id,
        reason,
        silence,
        error,
      );
    }
  }

  /** libp2p's connection-monitor ping; the timeout learns only from answers. */
  private async ping(connection: Connection, watch: Watch): Promise<void> {
    const signal: AdaptiveTimeoutSignal = watch.timeout.getTimeoutSignal({
      signal: this.stopper?.signal,
    });
    let start = Date.now();
    let stream: Awaited<ReturnType<Connection["newStream"]>> | undefined;
    let answered = false;
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
      answered = true;
      await stream.close({ signal });
    } catch (error) {
      stream?.abort(error as Error);
      if (answered) return;
      if ((error as Error).name !== "UnsupportedProtocolError") {
        this.metric?.update({ failure: Date.now() - signal.start });
        throw error;
      }
      // The peer answered multistream-select (two round trips): alive.
      connection.rtt = (Date.now() - start) / 2;
      answered = true;
    } finally {
      if (answered) {
        this.metric?.update({ success: Date.now() - signal.start });
        watch.timeout.cleanUp(signal);
      } else {
        signal.clear();
      }
    }
  }
}

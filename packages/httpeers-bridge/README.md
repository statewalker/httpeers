# @statewalker/httpeers-bridge

## What it is

HTTP between peers over any duplex stream, in both directions, with **no
transport in it**. A transport supplies a `PeerLink` — "open a duplex to this
peer" and "accept duplexes, telling me who is on the other end". This package
serves a `FetchHandler` over that link and calls other peers through it: a
`Request` in, a `Response` out, one duplex per call.

## Why it exists

Carrying HTTP over a duplex is done by `@statewalker/webrun-http-streams`. A
mesh needs two more things that neither the streams layer nor the transport
knows about: the transport-proven caller bound to every inbound request, and
outbound calls that are bounded in number and time. Keeping both here, behind
the two-method `PeerLink`, means libp2p, `MessagePort`s or a WebSocket all get
the same behaviour, and the mesh logic can be tested without a relay, a hub or
WebRTC.

## How to use

```sh
pnpm add @statewalker/httpeers-bridge
```

No peer dependencies. Runs in Node, workers and browsers.

| Import | Gives |
|---|---|
| `.` | `serveFetchOverLink`, `createRemoteOverLink`, the `PeerLink` / `PeerConnection` types, `DEFAULT_MAX_CONCURRENT_OUTBOUND` (64), `DEFAULT_REQUEST_TIMEOUT_MS` (30 000) |
| `./ports` | `pairedLinks` — two links joined back to back over `MessageChannel` |

```ts
interface PeerLink {
  open(peerId: PeerIdStr): Promise<PeerConnection>;                        // a duplex to that peer
  serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<() => Promise<void>>; // accept duplexes
}
```

## Examples

Two peers in one process, over `MessageChannel`:

```ts
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import { lookupPeer } from "@statewalker/httpeers-core";

const [linkA, linkB] = pairedLinks(peerA, peerB);

const stop = await serveFetchOverLink({
  link: linkB,
  dispatch: async (req) => new Response(`hello, ${String(lookupPeer(req))}`),
});

const call = createRemoteOverLink({ link: linkA }); // options: maxConcurrentOutbound, requestTimeoutMs, mapError
const res = await call(peerB, new Request("http://peer.local/hello"));
await res.text(); // "hello, <peerA>"
await stop();
```

A transport-specific error mapping:

```ts
import { PeerUnreachableError } from "@statewalker/httpeers-core";

const call = createRemoteOverLink({
  link,
  mapError: (error, target) =>
    String(error).includes("All multiaddr dials failed") ? new PeerUnreachableError(target) : undefined,
});
```

## Internals

### The caller's identity is overwritten on arrival

`serveFetchOverLink` calls `registerPeer(req, peer)` on every inbound request
before dispatch, with the peer the **link** proved. `registerPeer` deletes
`x-httpeers-peer` before setting it, so a request that arrives with a hand-set
value is corrected here rather than believed downstream. That one line is why a
peer cannot lie about who it is.

### Outbound calls are bounded, because unbounded calls fail somewhere else

`createRemoteOverLink` holds a concurrency permit (64 by default) across all
targets and a per-call timeout (30 s, dial included), and cleans up even when
the timeout fires mid-dial. Without the permit, a page that fires a hundred
calls opens a hundred streams, the far side's inbound limit refuses some of
them, and the symptom is *unrelated* calls failing.

### The duplex is closed only on the error path

The call resolves as soon as the response head is parsed, while the body is
still streaming over the same duplex. Closing it in a `finally` would yield a
`Response` whose `.text()` never resolves — and a test suite that times out
instead of failing, which is what duplex bugs look like.

### Error mapping belongs to the transport

`mapError` is a caller option because error text is transport-specific: libp2p
says "All multiaddr dials failed", a WebSocket says something else. A bridge
that matched one transport's wording would mis-classify every other. Return
`undefined` to let the original error through.

### A `MessagePort` proves nothing, so `./ports` asserts identity

| Link | Where | Proves identity by |
|---|---|---|
| libp2p | `@statewalker/httpeers-libp2p` (`servePeer`) | the Noise handshake |
| MessagePorts | `./ports` (`pairedLinks`) | **assertion at construction** |

Whoever holds a port is whoever holds the port. `pairedLinks(peerA, peerB)`
asserts the two identities when it is built, which is honest for a test harness
and for an in-process or same-origin transport where the channel *is* the trust
boundary. That is why it has its own entry point. Each `open()` creates a fresh
channel, so "one duplex per call" holds exactly as it does over libp2p. Pass a
`channel` factory to run over something other than the global `MessageChannel`.
A link that cannot establish identity should pass `ANONYMOUS`, never a guess.

### Dependencies

`@statewalker/httpeers-core` (headers, types), `@statewalker/webrun-http-streams`
(HTTP over a duplex), `@statewalker/webrun-streams` (the `Duplex` type),
`@statewalker/webrun-rpc` (a duplex over a `MessagePort`, for `./ports`).

Tests run over MessagePorts — a request and a response in both directions, a
forged `x-httpeers-peer` overwritten by what the link proved, and a 256 KiB
body that streams: `pnpm --filter @statewalker/httpeers-bridge test`. The libp2p
path is tested in `@statewalker/httpeers-libp2p`.

## License

MIT

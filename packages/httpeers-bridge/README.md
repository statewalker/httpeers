# @statewalker/httpeers-bridge

HTTP over a duplex, both directions, with **no transport in it**.

```ts
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";

const stop = await serveFetchOverLink({ link, dispatch: myRouter });
const call = createRemoteOverLink({ link });

await call(otherPeerId, new Request("http://peer.local/hello"));
```

A peer call is a `Request` in and a `Response` out, carried over one duplex
stream. `@statewalker/webrun-http-streams` does the carrying; this adds the two
things a **mesh** needs and neither half of that knows about.

## One: identity on arrival

The peer the transport proved is bound to every inbound request *before*
dispatch, replacing whatever the caller sent:

```ts
registerPeer(req, peer);   // strips first, then writes
```

That line is the reason a peer cannot lie about who it is. `registerPeer`
deletes `x-httpeers-peer` before setting it, so a request arriving with a
hand-set value is corrected here rather than believed downstream.

## Two: one stream per call, bounded

A concurrency permit, a per-call timeout, and cleanup that survives the timeout
firing mid-dial. Without the permit, a page that fires a hundred calls opens a
hundred streams and the far side's inbound limit starts refusing them — which
surfaces as *unrelated* calls failing.

**The connection is closed only on the error path.** `fetchOverDuplex` resolves
as soon as the response HEAD is parsed, while the body is still streaming over
that very duplex; closing it in a `finally` yields a `Response` whose `.text()`
never resolves. That is not hypothetical — it is what the first version of this
file did, and every test in the package timed out rather than failed, which is
what duplex bugs look like.

## `PeerLink` is the whole of what a transport must answer

```ts
interface PeerLink {
  open(peerId): Promise<PeerConnection>;                       // a duplex to that peer
  serve(handlerFor: (peer: ProvenPeer) => Duplex): Promise<Stop>;  // accept duplexes
}
```

Two questions. Everything else runs over anything.

| Implementation | Where | Proves identity by |
|---|---|---|
| libp2p | `httpeers-libp2p`'s `libp2pLink` | the Noise handshake (`context.remotePeer`) |
| MessagePorts | `./ports`'s `pairedLinks` | **assertion at construction** |

## `./ports` — and what a MessagePort cannot prove

`pairedLinks(a, b)` joins two peers back to back over a `MessageChannel`, so a
mesh runs in one process with no relay, no WebRTC and no key generation. Each
`open()` makes a fresh channel, so "one duplex per call" holds exactly as it
does over libp2p.

**A raw MessagePort establishes nothing** — whoever holds the port is whoever
holds the port. So the two identities are asserted at construction. That is
honest for a test harness and for an in-process or same-origin transport where
the channel *is* the trust boundary, and it is why this sits behind its own
entry point rather than looking like something you could deploy across a
network. A link that cannot establish identity should pass `ANONYMOUS` rather
than a guess: the whole authorization layer reads this value.

## Why it is a package

All of this lived inside `httpeers-libp2p`, welded to `connect` and
`serveConnections`. Only the two `PeerLink` questions were ever
libp2p-specific, so the rest could not be exercised without standing up a
relay, a hub and a WebRTC upgrade. Now a WebSocket or worker transport is a
~40-line adapter instead of a fork of this logic — and `httpeers-libp2p` runs
on this same code, so there is one implementation rather than two.

Error mapping stays with the transport (`mapError`): libp2p says "All multiaddr
dials failed", a WebSocket says something else, and a bridge that pattern-matched
one transport's wording would mis-classify every other one.

## Tests

**3**, over MessagePorts: a request and a response both ways, a forged
`x-httpeers-peer` overwritten by what the link proved, and a 256 KiB body
streamed rather than a token-sized one. The libp2p path is covered by
`httpeers-libp2p` and by the live mesh in `httpeers-conformance`.

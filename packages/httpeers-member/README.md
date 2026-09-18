# @statewalker/httpeers-member

Everything a participant does: hold an identity, redeem or resume, connect,
keep the link, advertise, discover, call, and serve.

```ts
import { startMember } from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";

const member = await startMember({
  key: "peers",
  mounts,                 // what this peer serves
  rules,                  // the mesh's policy
  config: { relayAddrs, hubPeerId },
  platform: nodePlatform,
  invitationId,           // omit to resume an existing membership
});

await member.fetch(new Request(`http://local/peers/${otherPeer}/hello`));
```

## One lifecycle, and a platform object with three methods

The prototype had **two** lifecycles — a 644-line `startBrowserPeer` and a Node
equivalent — that agreed on every step and diverged on three. `startMember` is
both of them, with the three differences injected:

```ts
interface MemberPlatform {
  createNode(init): Promise<Libp2p>;                  // required
  mountEdge?(init): Promise<MemberEdge>;              // a page only
  watchWake?(onWake): () => void;                     // a page only
}
```

That is the extraction's central claim, so `browser/peer-runtime.ts` was
deliberately **not ported**: porting it would have walked the duplication back
in through the front door. There is no browser peer runtime in this package,
only `browserPlatform()`.

| Import | Holds |
|---|---|
| `.` | `startMember`, the session, the join blob, the gateway, the edge dispatch, identity, mesh memory |
| `./node` | `nodePlatform` — a value, because a Node member has nothing per-instance to build |
| `./browser` | `browserPlatform()`, `createSession()`, `mountEdge`, `watchPageWake`, the IndexedDB backends |

## `MemberHandle.fetch` IS the edge, on both platforms

A Node caller writes `member.fetch(...)`; a page writes
`fetch(`${baseUrl}${peer}/x`)` and the ServiceWorker hands it to the same
handler. `baseUrl` is the browser-only extra, which is why it is optional.

**The edge is a local ingress and strips the proven-peer header.** A page
builds the requests that enter its own edge, so a header there is a claim, not
a fact. `createEdgeDispatch` used to branch on "does this already have a
binding" to mean "it arrived from the network" — safe while that binding was a
WeakMap no page could write, and a forgery hole the moment it became a header.
The branch is gone: a network request never reaches the edge, because
`serveTransport` dispatches to `peer.dispatch` directly.

**A member must be told it may route its own traffic.** The edge hands
`/{peerId}/{path}` to the peer's router, and that router refuses to forward
unless asked — relaying is its own capability, deny by default. `startMember`
passes `forwardLocalOnly` (from `httpeers-core`), which allows what originated
at this edge and refuses anything that arrived from the network. Omitting it
does not fail to compile; it fails at runtime with `403 this peer does not
relay for you`, from the **caller's own** router. That was a real defect here,
found by standing up a live mesh.

## `mountEdge` never waits for a controller that cannot come

The edge is `webrun-http-browser`'s `SwHttpAdapter` (`^0.5.0`). A **hard
reload** (Ctrl+Shift+R; Firefox's `location.reload(true)`) loads the page
bypassing its ServiceWorker, while that worker is already active and claimed its
clients long ago — so no `controllerchange` ever comes. Up to 0.4 `start()`
then waited forever, and llm-chat's `mesh.html` shipped sitting at "Joining…
(mounting-edge)" for good after one.

Since 0.5 the library recovers it, and `mountEdge` relies on that:

- uncontrolled under an active worker → `start()` sends a `CLAIM` request, the
  stock `sw-worker` (every app's `/sw.js`) answers with `clients.claim()`, and
  the page is taken over **in place, without a reload**;
- a worker that does not answer `CLAIM` (an older `/sw.js` still installed in a
  returning visitor's browser, or a custom `serviceWorkerUrl`) → after the
  bound, **one reload** (`reloadIfUncontrolled`, kept as the last resort; the
  library guards it with a `sessionStorage` marker, so it cannot loop);
- still uncontrolled after that, or no usable `sessionStorage` → throw
  `UncontrolledPageError` ("close the tab and reopen it").

Every wait is bounded (`controlTimeoutMs`, default `DEFAULT_CONTROL_TIMEOUT_MS`
= 30 s, passed to the adapter as its `timeout`); a worker that never activates
or never answers fails with an `Error` that says what to do. `edge-control.ts`
maps the library's `ServiceWorkerControlError` onto those errors, matching on
`name`/`reason` rather than `instanceof`. `tests/edge-control.test.ts` pins the
mapping; `httpeers-browser-conformance`'s `pnpm run test:reload` runs first
visit, reload, a hard reload (asserting it recovers with no extra navigation) and
a second tab, then — against a worker that ignores `CLAIM` — the fallback reload
and a spent guard, in real Chromium and Firefox.

## Direct or relay: how a member reaches its hub

`MemberHandle.hubLink()` is `"direct"` or `"relay"`, decided once per join.
**Direct** is a WebRTC upgrade to the hub plus a reservation on it, which is
what lets other members reach this one. **Relay** is a kept, limited circuit
through the public relay: the member calls the hub over it and nothing else
can reach the member. A member lands in relay mode when

- the WebRTC upgrade fails (a hub in Docker on a bridge network), or
- the upgrade works but the hub **refuses the reservation for want of capacity**
  (`RESERVATION_REFUSED`, `RESOURCE_LIMIT_EXCEEDED`) or does not answer. The
  WebRTC link is then closed and the member continues exactly as in the first
  case. `MemberHandle.hubLinkNote` says why, and the session shows it as the
  live phase's note (the join widget: `Connected (relay)` plus the reason).

Before this, a full reservation store on the hub failed the whole join while a
relay-mode member worked. Any other refusal — `PERMISSION_DENIED` from a hub
that has just accepted this peer, a hub with no relay service — still fails the
join: those are faults to report, not conditions to route around
(`fallsBackToRelay` in `start-member.ts`). Relay mode does not retry the
upgrade; a reconnect decides again.

## `createGateway` — the mesh as ordinary HTTP

```ts
const gateway = createGateway({ source: member, basePath: "", edgeKey: "peers" });
```

A `FetchHandler` dispatching `/{peerId}/{path}`, so a client with no peer
object, no token and no knowledge of libp2p can `fetch()` a mesh resource.
`GatewaySource` is structurally a subset of `MemberHandle`, so **a member is
one** — no adapter.

## Joining: a blob, a bare id, and one rule that must not bend

| What someone supplies | Which mesh |
|---|---|
| a join **blob** (`eyJ…`) | the one the blob names — a hub page's |
| a **bare invitation id** | the one the deployment's `httpeers.json` names |
| nothing (a resume) | the one this origin remembers, else the deployment's |

Only a **resume** consults the remembered mesh. A bare id still means the
deployment's, because that is the contract a Node-hub invitation travels under;
reversing it would silently point those joins at whatever mesh the page last
saw. `tests/session.test.ts` pins all three.

`invitationFromQrText` lives here rather than in `@statewalker/httpeers-qr`,
because it is entirely about the join format — a QR package that knew it could
not be used for anything else. It is a **predicate, never a parser**: it cannot
throw, because a live scanner that died on a malformed URL would die on the
first poster.

## The session, and why it is isomorphic

`createPeerSession` holds the four operator controls — join, disconnect,
reconnect, reset identity — and the state a page renders. It has **no DOM and
no browser imports**, so all fifteen of its branches are tested under Node with
no browser, no relay and no ServiceWorker.

That is load-bearing rather than tidy: `browserPlatform` reaches
`@libp2p/webrtc`, whose Node build loads a native module, so a browser default
inside the session would have made importing it a browser-only act. The
defaults live in `./browser`'s `createSession` instead.

**Disconnect is not leaving.** `stop()` drops presence and keeps membership, so
reconnecting needs no new invitation. `resetIdentity` is the destructive one,
named separately and documented with what it costs.

## The two "cannot resume" states are different, and say so

A page with no saved identity has never joined; a page whose identity the hub
does not recognise has had its membership revoked, or is talking to a hub that
was reset. Both would otherwise render as "please paste an invitation", and an
operator could not tell which had happened. When a resume fails *and* the
deployment now names a different hub, the session says so — that is almost
always a re-run of `pnpm bootstrap`, and saying it is the difference between a
two-minute fix and an hour.

## Isomorphism, measured by reachability

`tests/boundary.test.ts` walks the import closure of `index.ts` and fails if it
reaches `node:`, `@libp2p/tcp`, `@libp2p/webrtc`, `idb-keyval`, a ServiceWorker
adapter or a DOM-only global. It does **not** exempt filenames: `edge.ts` and
`page-wake.ts` are browser-only by construction and simply are not reachable
from the root, which the test asserts explicitly. Verified non-vacuous by
re-exporting `mountEdge` from `index.ts` and watching three named tests fail.

## Tests

**116.** `tests/edge-control.test.ts` pins the error `mountEdge` throws when
its ServiceWorker cannot take control. `tests/reservation-fallback.test.ts` pins which refused reservations
drop a join to relay mode and which fail it. `tests/consumer.test.ts` compiles a real dependent against all three
entry points under three tsconfig shapes — the `NodeNext` row is the only one
that honours the `exports` map, and for a subpath there is no legacy `types`
field to fall back to.

A member is also exercised for real in `@statewalker/httpeers-conformance`:
two live members redeem invitations from a live hub over a relay, call each
other, and the far side reports back a subject read out of a verified Biscuit
that matches the peer its handshake proved. `member-relay-fallback.test.ts` and
`member-reservation-fallback.test.ts` there run the two ways into relay mode
against a live hub: an upgrade that fails, and a hub whose reservation store is
full.

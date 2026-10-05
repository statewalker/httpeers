# @statewalker/httpeers-member

## What it is

Everything a mesh participant does: hold an identity, redeem an invitation or
resume a membership, connect to the hub, keep the link, advertise, discover,
call other members and serve its own mounts. It runs in Node and in pages; in a
page it also mounts a ServiceWorker edge, so `fetch("/peers/<peerId>/…")` from
ordinary page code reaches another member.

## Why it exists

A Node member and a browser member do the same thing in the same order and
differ in three places: how the libp2p node is built, whether there is a
ServiceWorker edge, and whether the page can be woken from sleep. `startMember`
is the one lifecycle, and those three differences are a `MemberPlatform`
object. A page-specific copy of the lifecycle would drift from the Node one, so
there is none.

## How to use

```sh
pnpm add @statewalker/httpeers-member
```

The libp2p stack is a set of **optional peer dependencies**, so the root entry
stays free of it. Install what your entry point imports:

- `./node`: `libp2p`, `@libp2p/tcp`, `@libp2p/websockets`, `@libp2p/webrtc`,
  `@libp2p/circuit-relay-v2`, `@libp2p/identify`, `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`.
- `./browser`: the same minus `@libp2p/tcp`, plus `idb-keyval` and
  `@statewalker/webrun-http-browser` (the ServiceWorker edge).

Under Node, `@libp2p/webrtc` needs the native `node-datachannel` module; see the
repository root README for the pnpm 10 `onlyBuiltDependencies` setting.

| Import | Gives |
|---|---|
| `.` | `startMember`, `createPeerSession`, the join blob (`encodeJoinBlob`, `decodeJoinBlob`, `joinUrl`, `invitationFromQrText`), `createGateway`, `createEdgeDispatch`, `peerRequest`, identity and mesh memory |
| `./node` | `nodePlatform` (a value: a Node member has nothing per-instance to build), `createNodeMemberNode` |
| `./browser` | `browserPlatform()`, `createSession()`, `mountEdge`, `watchPageWake`, `idbBackend`, `idbBytesBackend`, `resetBrowserState`, `UncontrolledPageError` |
| `./reset` | `resetBrowserState()` alone, with no imports, for a rescue page |

```ts
interface MemberPlatform {
  createNode(init: { privateKey?: Ed25519PrivateKey }): Promise<Libp2p>;  // required
  mountEdge?(init: { key: string; dispatch: FetchHandler }): Promise<MemberEdge>; // a page only
  watchWake?(onWake: () => void): () => void;                               // a page only
}
```

## Examples

A Node member:

```ts
import { startMember } from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";

const member = await startMember({
  key: "peers",
  mounts,                        // what this peer serves
  rules,                         // the mesh's RuleSet
  config: { relayAddrs, hubPeerId },
  platform: nodePlatform,
  invitationId,                  // omit to resume an existing membership
});

await member.fetch(new Request(`http://local/peers/${otherPeer}/hello`));
member.hubLink();                // "direct" | "relay"
```

A page, with the operator controls a join widget drives:

```ts
import { createSession } from "@statewalker/httpeers-member/browser";

const session = createSession({
  key: "peers",
  mounts,
  rules,
  onChange: (state) => render(state),
});
await session.start();           // resumes, or waits for an invitation
await session.join(pastedText);  // a join blob, a bare invitation id, or a join URL
// later: session.disconnect(), session.reconnect(), session.resetIdentity()
```

The mesh as plain HTTP, for a client that knows nothing about peers:

```ts
import { createGateway } from "@statewalker/httpeers-member";

const gateway = createGateway({ source: member, basePath: "", edgeKey: "peers" });
// gateway is a FetchHandler serving /{peerId}/{path}
```

A rescue page that returns the origin to a first visit:

```ts
import { resetBrowserState } from "@statewalker/httpeers-member/reset";

const { serviceWorkers, databases } = await resetBrowserState();
location.reload();
```

## Internals

### `MemberHandle.fetch` is the edge on both platforms

A Node caller writes `member.fetch(...)`; a page writes
`fetch(`${baseUrl}${peer}/x`)` and the ServiceWorker hands the request to the
same handler. `baseUrl` is the browser-only extra.

**The edge is a local ingress and strips the proven-peer header.** A page builds
the requests that enter its own edge, so a header there is a claim, not a fact.
A request from the network never reaches the edge: the transport dispatches it
to `peer.dispatch` directly.

**A member must be told it may route its own traffic.** The edge hands
`/{peerId}/{path}` to the peer's router, which refuses to forward by default.
`startMember` passes `forwardLocalOnly` from `@statewalker/httpeers-core`, which
forwards what originated at this edge and nothing from the network. A router
without it answers `403 {"error":"this peer does not relay for you"}` from the
caller's **own** router.

### `mountEdge` never waits for a controller that cannot come

The edge is `SwHttpAdapter` from `@statewalker/webrun-http-browser`. A hard
reload (Ctrl+Shift+R) loads the page past its ServiceWorker while that worker is
already active, so no `controllerchange` event ever fires. `mountEdge` handles
each case:

- uncontrolled under an active worker: the adapter sends a `CLAIM` request, the
  stock worker (`/sw.js`, `DEFAULT_SERVICE_WORKER_URL`) answers with
  `clients.claim()`, and the page is taken over in place, without a reload;
- a worker that does not answer `CLAIM` (an older `/sw.js`, or a custom
  `serviceWorkerUrl`): after the bound, **one** reload, guarded by a
  `sessionStorage` marker so it cannot loop;
- still uncontrolled after that, or no usable `sessionStorage`: it throws
  `UncontrolledPageError` — "This page isn't controlled by its ServiceWorker, so
  the mesh cannot be reached through it — close the tab and reopen it."

Every wait is bounded by `controlTimeoutMs` (default
`DEFAULT_CONTROL_TIMEOUT_MS`, 30 s). The library's `ServiceWorkerControlError`
is matched by `name` and `reason`, not `instanceof`, because every bundle of the
adapter carries its own copy of the class. `tests/edge-control.test.ts` pins the
mapping; `httpeers-browser-conformance` runs the reload cases in real Chromium
and Firefox.

### Direct or relay: how a member reaches its hub

`member.hubLink()` is decided once per join:

- **direct** — a WebRTC upgrade to the hub plus a reservation on it, which lets
  other members reach this one;
- **relay** — a kept, limited circuit through the public relay. The member
  calls the hub over it, and nothing can reach the member.

A member falls back to relay when the WebRTC upgrade fails (for example, a hub
in Docker on a bridge network) or when the hub refuses the reservation for lack
of capacity (`RESERVATION_REFUSED`, `RESOURCE_LIMIT_EXCEEDED`) or does not
answer. `member.hubLinkNote` says why, and the join widget shows
`Connected (relay)` with that note. Any other refusal — `PERMISSION_DENIED`
from a hub that has just accepted this peer, a hub with no relay service —
fails the join, because it is a fault rather than a condition to route around
(`fallsBackToRelay` in `start-member.ts`). Relay mode does not retry the
upgrade; a reconnect decides again.

### Which mesh an invitation joins

| What someone supplies | Which mesh |
|---|---|
| a join **blob** (`eyJ…`) | the one the blob names |
| a **bare invitation id** | the one the deployment's `/httpeers.json` names |
| nothing (a resume) | the one this origin remembers, else the deployment's |

Only a resume consults the remembered mesh. A bare id always means the
deployment's mesh; otherwise it would silently point at whatever mesh the page
last saw. `tests/session.test.ts` pins all three.

`invitationFromQrText` lives here, not in `@statewalker/httpeers-qr`, because
it is entirely about the join format. It is a predicate, never a parser: a live
scanner must not die on the first malformed QR code it sees.

### The session is isomorphic, so it is tested without a browser

`createPeerSession` holds the four operator controls — join, disconnect,
reconnect, reset identity — and the state a page renders. It has no DOM and no
browser imports, so all its branches run under Node with no relay and no
ServiceWorker. The browser defaults live in `./browser`'s `createSession`.

**Disconnect is not leaving.** `disconnect()` drops presence and keeps
membership, so `reconnect()` needs no new invitation. `resetIdentity()` forgets
the identity and is the destructive one.

### The two "cannot resume" states say which one happened

A page with no saved identity has never joined. A page whose identity the hub
does not recognise was revoked, or is talking to a reset hub. When a resume
fails and the deployment names a different hub, the session adds: "This
deployment's httpeers.json now names a different hub (…), which is a different
mesh -- so a membership in the old one cannot carry over."

### `./reset` imports nothing

A rescue page has to work when the app does not start, so `./reset` has no
imports at all. `resetBrowserState()` unregisters every ServiceWorker on the
origin, deletes its IndexedDB databases and clears `localStorage` and
`sessionStorage`. It never throws, and reports what it removed. Reload the page
afterwards: `unregister()` does not evict a worker already controlling the
page.

### The root never reaches a platform module

`tests/boundary.test.ts` walks the import closure of `index.ts` and fails if it
reaches `node:`, `@libp2p/tcp`, `@libp2p/webrtc`, `idb-keyval`, a ServiceWorker
adapter or a DOM-only global. It does not exempt filenames: browser-only files
are simply unreachable from the root.

### Dependencies

`@statewalker/httpeers-core`, `@statewalker/httpeers-access` and
`@statewalker/httpeers-libp2p`, a few `@libp2p/*` helpers for keys and
addresses, plus the optional peers above. `tests/consumer.test.ts` compiles a
real dependent against all entry points under three tsconfig shapes; the
`NodeNext` one is what checks the `exports` map.

Tests: `pnpm --filter @statewalker/httpeers-member test`. Live members redeem
invitations and call each other over a relay in `httpeers-conformance`.

## License

MIT

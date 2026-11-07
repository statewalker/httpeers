# @statewalker/httpeers-share

## What it is

Sharing an HTTP service with the members of an httpeers mesh. It covers:
- how the Sharer reaches the service (upstream kinds);
- what may be shared (policy);
- whether it works for Guests (probe);
- how Guests see it (service table);
- how they are invited (invite links);
- what a failed join means (join outcome).

`./bridge` is the PeerShare Bridge, for Node, Bun and Deno.

## Why it exists

PeerShare (a SandClaw app: share a local HTTP service with invited Guests) needs the same
rules in the Sharer's browser tab, in the Bridge and in tests. Everything here was proven in
a prototype rung first (`statewalker-sandbox`, `apps/peershare-protos`, whose rung READMEs
say why each rule is the way it is) and moved here with its tests.

## How to use

```sh
pnpm add @statewalker/httpeers-share
```

| Import | Gives | Runs in | Rung |
|---|---|---|---|
| `.` | `createUpstream`, `unreachable`, the `BRIDGE_*` header contract | anywhere | 01 |
| `.` | `checkServiceTarget` (v1 policy), `checkTarget`, `isPrivateAddress` | anywhere | 04, 02 |
| `.` | `probe` | anywhere | 04 |
| `.` | `serviceTable` (catalog at `/s/`, Pause, routing) | anywhere | 07 |
| `.` | `encodeInvite`, `decodeInvite` | anywhere | 06 |
| `.` | `joinOutcome`, `revokeGuest`, `isSharerOffline`, `stampGuest` | anywhere | 09, 10, 16 |
| `.` | `openTunnel`, `sharerSocket`, `encodeFrame`/`decodeFrames`: a WebSocket inside one full-duplex mesh request | anywhere | 15 |
| `./bridge` | `createBridge` (HTTP and its WebSocket gate), `originAllowed`, `listenLoopback`, `connectApp`/`relaySocket` (for another server) | Node, Bun, Deno | 02, 03, 16 |

## Examples

```ts
import { createUpstream, serviceTable, checkServiceTarget } from "@statewalker/httpeers-share";

checkServiceTarget("direct", "http://api.example.com"); // { ok: false, reason: "needs-https" }

const upstream = createUpstream({
  kind: "bridged",
  target: "http://localhost:5173",
  bridge: { base: "http://127.0.0.1:9090", token },
});
const mount = serviceTable(
  () => [{ id: "foo", name: "fooService", upstream, enabled: true, isDefault: true }],
  { sharerName: "Dirk" },
); // the Sharer's `/s` mount
```

```ts
import { createBridge, listenLoopback } from "@statewalker/httpeers-share/bridge";

const bridge = await listenLoopback(
  createBridge({
    token: "", // no key: any allowed page may use it
    allowedOrigins: ["https://peershare.httpeers.net", "http://localhost:*", "http://127.0.0.1:*"],
  }),
  9090,
);
bridge.origin; // "http://127.0.0.1:9090"
```

## Internals

- The root entry point is isomorphic. `tests/boundary.test.ts` fails if any file under `src/`
  (other than `src/bridge/`) imports a `node:` module.
- Tests run against real ports and the real Bridge. `tests/fixtures.ts` includes a stand-in
  Bridge, kept on purpose: it proves the upstream depends only on the wire contract.
- `service-table`, `join-outcome` and `stamp-guest` were tested over the mesh in the rungs.
  Their unit tests here characterise code that moved, and passed on their first run.

- **Who may call the Bridge.** It listens on 127.0.0.1 only, but a loopback port that answers
  cross-origin requests is reachable from every website the Sharer visits. So a request whose
  `Origin` is not in `allowedOrigins` gets `403` with `x-peershare-bridge: origin-forbidden` and
  no CORS grant, on HTTP and WebSocket alike. A pattern is an exact origin, `scheme://host:*`
  (that host on any port; compared as a parsed URL, so `http://localhost.evil.com` does not
  match `http://localhost:*`) — on any port, or none — or `*`, every site (`Origin: null`,
  sandboxed frames and `file://` pages, included). A request with no `Origin` is a local
  process, admitted by the token alone.
- **Only loopback names.** A request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]`
  gets `403` `host-forbidden`. That is DNS rebinding: a website rebinds its own name to
  127.0.0.1, its requests become same-origin and carry no `Origin`, and without this check an
  empty token would let it relay anywhere and read the answers.
- **The token is optional.** `token: ""` checks no token, so the origin list is the only guard:
  any allowed page can relay to this machine and the private network. With a token, a missing
  or wrong one gets `401` `bad-token` (on a WebSocket, the subprotocol `peershare.<token>`),
  which a page should report as "wrong key", not as "no Bridge running". A WebSocket must offer
  a `peershare.` subprotocol even with no token (`peershare.` will do), or it gets `401`.
- **Node, Bun and Deno** run `listenLoopback` unchanged: Bun and Deno serve `@hono/node-server`
  and `ws` upgrades through their `node:http` compatibility. `pnpm test:e2e` starts the Bridge
  under each (all three must be installed; a missing one fails with "deno is not installed").
- `./bridge` serves with `@hono/node-server`'s `overrideGlobalObjects: false`. By default that
  server replaces the process's global `Request`/`Response`, which stalls streaming fetches
  (the mesh member's full-duplex requests) everywhere else in the process.

```sh
pnpm --filter @statewalker/httpeers-share test
```

## License

MIT

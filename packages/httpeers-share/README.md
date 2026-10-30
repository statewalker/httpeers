# @statewalker/httpeers-share

## What it is

Sharing an HTTP service with the members of an httpeers mesh. It covers:
- how the Sharer reaches the service (upstream kinds);
- what may be shared (policy);
- whether it works for Guests (probe);
- how Guests see it (service table);
- how they are invited (invite links);
- what a failed join means (join outcome).

`./bridge` is the PeerShare Bridge, for Node and Bun only.

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
| `./bridge` | `createBridge` (HTTP and its WebSocket gate), `listenLoopback` (Node), `connectApp`/`relaySocket` (for a Bun host) | Node, Bun | 02, 03, 16 |

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

## Internals

- The root entry point is isomorphic. `tests/boundary.test.ts` fails if any file under `src/`
  (other than `src/bridge/`) imports a `node:` module.
- Tests run against real ports and the real Bridge. `tests/fixtures.ts` includes a stand-in
  Bridge, kept on purpose: it proves the upstream depends only on the wire contract.
- `service-table`, `join-outcome` and `stamp-guest` were tested over the mesh in the rungs.
  Their unit tests here characterise code that moved, and passed on their first run.

- `./bridge` serves with `@hono/node-server`'s `overrideGlobalObjects: false`. By default that
  server replaces the process's global `Request`/`Response`, which stalls streaming fetches
  (the mesh member's full-duplex requests) everywhere else in the process.

```sh
pnpm --filter @statewalker/httpeers-share test
```

## License

MIT

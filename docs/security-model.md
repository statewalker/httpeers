# The trust model: the mesh is a mount

> **In one line.** The mesh mounts every member's HTTP surface into each peer's
> own local URL namespace, and calls carry that peer's proven identity
> automatically — so a remote resource behaves exactly like a local one *for the
> code running on the peer*. That is the whole ergonomic case for the design and
> the whole security risk, because they are the same mechanism. **Data may cross
> this boundary freely; code may not — unless it is trusted or isolated.**

This document defines what "everything is a `fetch()`" actually grants, which
uses of it are safe, and which are dangerous. It is the frame the individual
packages sit inside; read it before building an app, a provider, or a shell that
hosts other peers' apps.

---

## 1. What "mounted" means — three things, kept separate

The word *mount* blurs three distinct facts. Keeping them apart is the whole
model.

- **Addressing is universal and symmetric.** Every member peer's HTTP surface is
  reachable from every other member through a *local* URL on your own origin —
  `fetch(`${baseUrl}${peerId}/path`)` — resolved by your ServiceWorker edge and
  carried over the mesh. In the plan9/NFS sense the entire mesh is mounted into
  each peer's local namespace: a remote resource is *addressed* exactly like a
  local one.

- **Authority is ambient — it belongs to the origin, not to the code.** The edge
  **attaches this peer's membership token automatically** to whatever it
  forwards. So a remote resource is not merely addressable like a local one; it
  is *called with your credentials automatically*, exactly like a local one. Any
  code running on your origin inherits that authority without asking for it.
  The token rides in its own header, `x-httpeers-token`, which the edge adds to
  every request that does not already carry one; the page's `Authorization` is
  left alone and reaches the target application. A proxy that re-issues a
  request *outside* the mesh strips the token and the proven-peer header
  (`MESH_CREDENTIAL_HEADERS`), so a third-party origin never sees either.

- **Authorization is remote.** What actually gets served is decided by the
  **target** peer's Biscuit/Datalog policy at *its* ingress, where the caller's
  identity is re-proven from the transport and cannot be forged (`x-httpeers-peer`
  is stripped and rewritten at every ingress). This is the real boundary
  *between* peers.

The consequence that runs through everything below: **access between peers is
gated by the target's policy; access *within* a peer's origin is gated by
nothing.** An origin is one trust domain.

## 2. The one axis: data crosses safely, code does not

Everything reduces to what crosses the mesh boundary.

- **Data in, data out — safe.** A request goes out, a response comes back. The
  serving peer reads an HTTP request and never executes the caller's code; the
  calling peer parses bytes (JSON, an image) and — this is the condition —
  **never executes the response as code**. Peer identity here is an *extra* axis
  layered on top of the endpoint's normal token/role checks, verified on the
  server side where it is trustworthy. Identity strengthens the boundary; it
  never crosses it.

- **Code across the boundary, running on your origin — dangerous.** If the
  response is HTML or script that you *execute in your own origin*, that foreign
  code now runs in your trust domain: your storage, your identity key, your DOM,
  your ambient mesh authority. This is the confused-deputy problem — code you did
  not write, wielding authority you did not grant it, on your behalf.

> The sharp line: a response is safe as **data** and dangerous as **code**.
> Treating a response as data means never turning it into code — no `eval`, no
> `innerHTML` / `dangerouslySetInnerHTML`, no template engine that runs it.

## 3. Advantages and risks are the same mechanism

Ambient authority — authority attached to the origin rather than to the code — is
one property seen from two sides:

- **Advantage:** a bare `fetch()` just works. No SDK, no client object, no
  credential plumbing. The mesh *is* the platform. This is the entire ergonomic
  argument for the design, and it is real.
- **Risk:** any code on the origin — a foreign app, an injected script, a
  compromised dependency — wields your full mesh authority and can read anything
  else on the origin and call the mesh as you. This is the same family as browser
  cookies (→ CSRF), a Unix process running as you, or a mounted network drive.

You do not get one without the other. The design decision is not "how do we
remove the risk" but "where do we allow the convenience, and where do we refuse
it."

## 4. The ServiceWorker constraint that forces the architecture

The mount is delivered by a ServiceWorker, and **a ServiceWorker controls only
same-origin clients.** This single fact decides the safe shapes.

- A **cross-origin iframe** (a real domain B inside a domain A page) is
  controlled by B's worker or the network — **never by A's**. A fetch from the
  B-frame to A's mesh URL goes over the real network to whatever serves A, not to
  A's edge. The mount is not there.
- A **sandboxed, opaque-origin iframe** matches *no* registration and is
  controlled by **no** ServiceWorker at all.

Therefore: **isolation and the SW-mount are mutually exclusive for the same
frame.** The moment you move code off your origin to isolate it, it loses the
mount. There is deliberately no "isolate it elsewhere but let it fetch through my
edge" — that is physically impossible, and it is a *feature*: isolated code has
no ambient path to the mesh.

This reframes the ghost's abandoned `sandbox` mode. `sandbox` was not the wrong
*isolation* — it was incompatible with the ghost's *delivery mechanism* (serve
the frame through the SW). The fix is not to fall back to same-origin `csp`; it
is to change the delivery mechanism (see §6).

## 5. Advantages and risks, itemised

**Advantages**

- Remote endpoints are ordinary URLs; the whole client API is `fetch()`.
- Identity is free and unforgeable at the serving side — an *extra* authorization
  axis on top of ordinary REST authN/authZ, not a replacement for it.
- A provider decides exactly what it advertises and serves; its Datalog policy is
  the gate.
- No ambient trust *between* peers: the receiver always decides.

**Risks**

- Ambient authority on the origin: any on-origin code acts as the peer.
- No boundary *within* an origin: two apps on one origin are one trust domain —
  shared storage, identity key, DOM.
- A rendered foreign response is code with your authority (the dangerous case).
- Secrets in origin storage are readable by any on-origin code and exfiltrable
  through any allowed mount.
- "Advertised" is not "safe to render" — a malicious provider serves hostile
  bytes; the risk lands on the *consumer* that executes them.

## 6. The safe shapes for running code

Executing remote code is not categorically forbidden — it is forbidden
**untrusted *and* unisolated on your own origin**. There are exactly two ways to
make it acceptable, and §4 dictates their mechanics.

1. **Trusted (install-time).** The code was installed with deliberate consent and
   provenance — the VS Code *extension* model. Same-origin ambient authority is
   then the bargain you knowingly accepted. Gate installation on a signed landing
   / provenance and explicit consent; treat any containment (e.g. the ghost's
   CSP) as *hardening*, not as the trust boundary.

2. **Isolated (off-origin) + a broker.** The code runs in a sandboxed
   opaque-origin iframe with no `allow-same-origin`, so it has no SW, no mount,
   and no ambient authority. Its *only* path to the mesh is a `postMessage`
   bridge to the shell (the trusted, SW-holding origin), which performs each mesh
   call, applies the pin and capability policy, and returns **data**. The broker
   is required, not decoration — the mount cannot reach the frame. This is the VS
   Code *webview* model.

   A heavier variant: give the app its **own** real origin (a subdomain) where it
   is a peer in its own right, with its own edge and its own identity. The
   browser's same-origin policy isolates it from you; it carries its own ambient
   authority on its own origin (fine — isolated from yours). Needs origin
   provisioning (DNS/TLS or partitioned origin).

   **Session origins are the provisioned form of this, and they keep `fetch()`.**
   `apps/session-shell` serves every `<name>.p.httpeers.net` as an empty origin
   with its own ServiceWorker; the shell (the ghost app) hands it a `MessagePort`,
   and that worker answers every request the app makes — `index.html` included —
   over the port. So the app gets plain `fetch()` and root-absolute URLs, *and*
   its own storage, cookies and worker; the port's handlers are the broker, and
   they decide, per mount, what the app reaches — the pin (`pinnedPeer`) at the
   root, and in this deployment the whole mesh under `/peers/`, which is a
   deliberately wider grant than a pin and is spelled out below. The app has no
   mount on the shell's origin and no identity of its own. The name is not a
   secret; authority is the port, never the name.

### A session is a mesh window, pinned at the root

A session no longer serves one handler. It serves **the services its app
registers**, each at a path the app chooses, all over that one port — because
`webrun-http-browser` 0.6.0 routes a `CONNECT` to the service its key names. The
demo registers two, and the pair is the whole boundary:

- **`/` is pinned.** `pinnedPeer` holds the peer id in the handler, not in the
  URL, so the app's own root — `/index.html`, `/app.js`, `/api/hello` — resolves
  to the one peer that serves it and cannot be steered anywhere else.
- **`/peers/` is the mesh.** `createGateway` takes `/peers/<peerId>/<path>` and
  dispatches it through the ghost app's member. An app in a session may
  therefore call **any peer the parent can see** — and `GET /peers/` is that
  gateway's own listing, answering with whether the mesh view is ready, this
  peer's own id, the view's version, every member with its roles, and every
  advertisement with the peer offering it and its `id`, `kind` and `title`
  (never a URL — the mesh view carries no service paths). **So an app in a
  session does not have to be told which peers exist: it can ask.**

State that plainly, because it is a real widening and it is intended:

1. **The app calls as the viewer, and the bound is the callee.** Every call
   carries the ghost app's membership, so the thing that decides whether a call
   is allowed is the **target peer's own ingress policy** (its Datalog rules) —
   not the session, which is a window and not a firewall. A session hands an app
   the same reach its host page already has.
2. **Enumeration is part of the widening, not a separate future feature.** The
   listing above ships in `createGateway` and `session-frame.ts` wires that same
   gateway into every session, so a hostile app's first move can be to read the
   membership and the advertised kinds and then choose what to call. Discovery
   was never the boundary here — the callee's policy is — but a provider that
   assumed nobody would learn its peer id from inside a session assumed wrong.
3. **The app never sees the membership token, and never chooses it.** The ghost
   app's edge attaches it after the request has left the session
   (`createEdgeDispatch`), so an app can spend the viewer's authority on a call
   but cannot carry it away, replay it elsewhere, or read it out of its own
   request. It cannot *supply* one either: the edge deliberately leaves a token
   a caller already set alone, so the session's mesh handler strips
   `MESH_CREDENTIAL_HEADERS` off every request entering `/peers/`
   (`session-frame.ts`'s `withoutMeshCredentials`) — exactly as `pinnedPeer`
   overwrites them on the root route. Without that strip the app picked the
   credential its call travelled under, which is a self-DoS at best and a
   mis-attributed call at worst.
4. **One origin per app still holds.** The widening is about *reach*, not about
   containment: a hostile app in a session still cannot read another app's
   storage, cookies, IndexedDB or DOM, because each session is its own origin
   (§10). What it can do is talk to peers — and a peer that must not be talked
   to by a member's app has to say so **in its own policy**, because it cannot
   rely on not being reachable by name or on not being found.
5. **`/peers/` is reserved, and the key space with it.** An app cannot own
   `/peers/`, and `openSession` holds every allowlisted service key it is not
   using: a session name is not a secret, so a second ghost is free to frame a
   live session's relay, and an unheld key mounted at `/index.html` would
   outrank the app's `/` on longest-prefix. See `apps/session-shell/README.md`.

## 7. Valid use cases

| Use case | Why it is safe |
|---|---|
| **Your own first-party app** calling the mesh | You wrote it; it *should* act as you |
| **Serving your resources to the mesh** (provider side) | You choose what to advertise; your Datalog policy gates callers |
| **Member-to-member API calls**, request/response | Data crosses; the *target's* policy is the boundary; identity strengthens it |
| **Installed, consented bundles** (VS Code *extension* model) | Trust decided once, at install, with provenance |
| **Untrusted code behind a broker** (VS Code *webview* model) | Isolated off-origin; reaches the mesh only through a mediator, with no ambient authority |
| **A peer's app in a session origin** (`<name>.p.httpeers.net`) | Its own origin, storage and worker; its root is the shell's pinned handler, and its `/peers/` calls are bounded by each target peer's own policy |
| **`fetch()`-as-the-API ergonomics** for trusted code | The whole point of the design; keep it there |

## 8. Use cases to avoid

| Use case | Why to avoid |
|---|---|
| **Running ad-hoc / untrusted foreign code on your origin** | It inherits your identity key and full mesh authority — measured, not theoretical (§10) |
| **Treating the client-side mount as a boundary *between apps on one peer*** | Same origin = one trust domain: shared authority, storage, DOM |
| **Relying on the pin or a same-origin CSP to contain a hostile app** | They stop mesh-walking and accidental egress, not storage/DOM theft |
| **Treating a session as a bound on *which peers* an app may call, or on which it can discover** | `/peers/` is a window onto the whole mesh the host page can see, and `GET /peers/` lists it; the bound is the target peer's own ingress policy (§6) |
| **Keeping secrets or capabilities in origin storage** next to untrusted code | Any on-origin code reads them and exfiltrates through an allowed mount |
| **Executing a mesh response** (`eval`, `innerHTML`, a running template) | Turns data into code — crosses the one line that must not be crossed |
| **"Advertised ⇒ safe to render blindly"** | A malicious provider serves hostile content; the consumer that renders it pays |
| **One origin for both your privileged edge and rendered foreign content** | Collapses the two trust domains that most need separating |

## 9. The governing rules (quotable)

1. **An origin is one trust domain.** Everything mounted into it, and every line
   of code running in it, acts with that peer's full authority.
2. **Data crosses the mesh safely; code does not** — unless it runs somewhere
   already trusted or fully isolated.
3. **The SW-mount is same-origin only, so isolation ⇒ no mount ⇒ a broker.**
   Untrusted code gets a different origin and reaches the mesh only through a
   mediator that supplies authority per call — never by inheriting the origin's.
4. **Mount freely; run only already-trusted code on the origin that holds the
   mount.**

## 10. What is measured, and what is not

This model is grounded in a browser measurement, not opinion.

**Measured (real Chromium, real ServiceWorker, the extracted `httpeers-ghost`
`pinnedPeer` + `contain`, a deliberately hostile host app):**

- `csp` mode *does* close the accidental escape it was built for — a root-absolute
  `fetch`, `<img>` and `<link>` to the viewer's origin, and a cross-origin
  beacon, are all blocked. The pin's `403` holds.
- **But** the ghost iframe is same-origin with the viewer, so the hostile app
  read `localStorage`, enumerated the IndexedDB identity-key store, and read
  `parent.document` — in **both** `none` and `csp` modes — and exfiltrated
  through the ghost's own allowed mount. **Nothing in the ghost contains a
  hostile app.** The pin only prevents mesh-walking.
- ServiceWorker takeover fails robustly: a registration script fetch bypasses the
  controller, so a host peer cannot install a worker on the viewer's origin.

**Measured for session origins (2026-09-18, Chromium and Firefox, the real
`*.p.httpeers.net` domain, a mesh app served by the hub through `pinnedPeer`;
`apps/demos/scripts/session-smoke.mjs`):** two sessions opened by the same
viewer have different origins and separate workers; a `localStorage` marker, a
cookie and an IndexedDB database written in one are invisible to the other and
to the viewer; the viewer's `localStorage` is invisible to both; reading
`parent.document` and navigating `top` from a session both throw
`SecurityError`; a session opened top-level with no referrer is refused by its
worker; another session cannot hand a session's relay its port
(`apps/session-shell/scripts/live-check.mjs`).

**Measured for the two-service session (2026-09-21, Chromium and Firefox, the
BUILT shell served on two localhost origins, a real ServiceWorker and a real
relay port, with a stand-in mesh handler rather than libp2p;
`apps/session-shell/scripts/browser-test.mjs`):** an app at `/` and a mesh
service at `/peers/` are served over ONE relay connection; `/` and
`/index.html` go to the app and a path under `/peers/` goes to the mesh
service, never to the root mount; the mesh handler receives the **un-stripped**
`/peers/<peerId>/...`; a POST under `/peers/` arrives **with its body** in both
engines — the case that used to arrive empty in Firefox, which has no
`Request.prototype.body`; both mounts survive the worker being stopped and
restarted; and a second ghost asking for a key outside
`SESSION_SERVICE_KEYS` is refused while `/index.html` stays the app's. One
local origin serves every session name there, so it measures the protocol and
the routing, not the per-name isolation (that is the 2026-09-18 run above).

**Measured (2026-09-26, Chromium and Firefox, the real `*.p.httpeers.net`
domains, a mesh app served by the hub over libp2p;
`apps/demos/scripts/session-smoke.mjs`, 48/48):** an explicit
`GET /peers/<peerId>/...` from inside a session origin reaches that peer, and a
`POST /peers/<peerId>/...` arrives **with its body** — `76 bytes of 76` in BOTH
engines. A `/peers/` path naming a peer that is not in the mesh is refused
promptly (401 in 137 ms in Chromium, 3.4 s in Firefox), not hung.

That POST is the case this file previously recorded as unverified, and running
it is what found the defect: on 2026-09-21 the same check reported
`0 bytes of 76 sent`, Firefox only, with a passing GET beside it. **Firefox has
no `Request.prototype.body`**, so every forwarder that rebuilt a request with
`body: request.body` — or with the init-from-`Request` form `new Request(url,
req)`, which reads the same property — dropped the payload silently. Five sites
carried it: `httpeers-member/src/edge-dispatch.ts`, both
`httpeers-core/src/router.ts` sites, the demos proxy page's own rewrite, and
`urlUpstream` in `@statewalker/webrun-http-proxy` (fixed in 0.2.1). None of them
was caught by a local suite: the browser harness serves the mesh with a
stand-in, so a POST there never crosses the gateway-and-edge chain where this
breaks. Treat a green local run as saying nothing about this path.

**Not yet verified (each a distinct future probe):** CSP relaxation across a
redirect; whether a hostile ghost app can reach the viewer's *own* edge when both
mounts share one origin; top-navigation / popups from a *same-origin* ghost
frame; `appPath` injection; the currently unsigned landing; cookie tossing from
a session onto `.httpeers.net` (sessions share the registrable domain with
every other site — see `apps/session-shell/README.md`).

**Known gap for any live "run a foreign app" feature:** `MemberHandle`
exposes `fetch` but no addressed `call(peerId, request)` / `ensureRoute`.
Building a broker's `remote` from `member.fetch` reintroduces the
path-derived-peer hazard the pin exists to close *if the peer is read from the
request*. The session demo (`apps/demos/src/shared/session-frame.ts`) builds
the edge URL for the **pinned root** from the pinned peer id alone — `/<edge
key>/<pinned peer>/<app path>/...` — so on that mount the first segment the edge
routes on is never the app's to choose. Under `/peers/` the peer *is* read from
the request, and that is the point rather than the hazard: `createGateway` is
the party whose contract is "the peer is in the path", and the widening it
grants is §6's, bounded by the callee. An addressed call on the member handle
would still be the cleaner primitive for both.

## 11. Guidance by role

- **App author (first-party).** Use `fetch()` freely against the mesh; you are
  trusted on your own origin. Treat every *response* as untrusted data — parse
  it, never execute it.
- **Provider author.** Advertise only what you mean to serve; your Datalog policy
  is the boundary. Assume callers are hostile and rely on identity + policy, not
  on the caller behaving.
- **Shell / host author (running other peers' apps).** This is where the model
  bites. Never render an untrusted app on your edge's origin. Trusted/installed
  apps may share the origin only after a real install-time trust decision;
  everything else goes in an isolated frame behind a `postMessage` broker that
  holds the pin and the capability policy (§6). The broker, not the frame, is
  where authority lives.

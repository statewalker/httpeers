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

## 7. Valid use cases

| Use case | Why it is safe |
|---|---|
| **Your own first-party app** calling the mesh | You wrote it; it *should* act as you |
| **Serving your resources to the mesh** (provider side) | You choose what to advertise; your Datalog policy gates callers |
| **Member-to-member API calls**, request/response | Data crosses; the *target's* policy is the boundary; identity strengthens it |
| **Installed, consented bundles** (VS Code *extension* model) | Trust decided once, at install, with provenance |
| **Untrusted code behind a broker** (VS Code *webview* model) | Isolated off-origin; reaches the mesh only through a mediator, with no ambient authority |
| **`fetch()`-as-the-API ergonomics** for trusted code | The whole point of the design; keep it there |

## 8. Use cases to avoid

| Use case | Why to avoid |
|---|---|
| **Running ad-hoc / untrusted foreign code on your origin** | It inherits your identity key and full mesh authority — measured, not theoretical (§10) |
| **Treating the client-side mount as a boundary *between apps on one peer*** | Same origin = one trust domain: shared authority, storage, DOM |
| **Relying on the pin or a same-origin CSP to contain a hostile app** | They stop mesh-walking and accidental egress, not storage/DOM theft |
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

**Not yet verified (each a distinct future probe):** CSP relaxation across a
redirect; whether a hostile ghost app can reach the viewer's *own* edge when both
mounts share one origin; top-navigation / popups; `appPath` injection; the
currently unsigned landing.

**Known blocking gap for any live "run a foreign app" feature:** `MemberHandle`
exposes `fetch` but no addressed `call(peerId, request)` / `ensureRoute`.
Building a broker's `remote` from `member.fetch` reintroduces the
path-derived-peer hazard the pin exists to close — so an addressed call on the
member handle is a prerequisite.

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

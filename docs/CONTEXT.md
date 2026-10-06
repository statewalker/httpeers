# httpeers — domain model

The ubiquitous language of the httpeers mesh. Terms here are load-bearing: several
are overloaded in ordinary usage and the distinctions below are the ones the code
enforces. Where a term has a *false friend*, it is named.

Status: living document, started 2026-08-20 during the API-definition grill.
Decisions are in [`adr/`](./adr/).

---

## Structure

**Layer** — what sits on what: L0 transport, L1 fetch-over-stream, L2 router,
L3 access, L4 edges, L5 apps. Describes the stack. *Not* a unit of work.

**Block** — a set of code that changes together and can be replaced wholesale
without touching the others. Six of them: **T** transport & wire, **R** router,
**A** access & trust, **E** edges, **M** mesh services, **P** products. Blocks
deliberately do not coincide with layers — L0+L1 merge into T because they change
for the same reasons; L5 splits into E/M/P because a hub, an SDK and a demo have
unrelated change drivers. *False friend: "block" is not "layer".* See ADR-0001.

**Seam** — a boundary an implementation may be swapped across. The Duplex is one
(ADR-0004 in `webrun-wire`); the handler contract is another.

---

## Identity and trust

**Peer** — a participant, addressed by its **peerId** (an Ed25519 public key
identity). A peer is a *process with a key*, not a device and not a person.

**Proven peer** — the peerId the Noise handshake cryptographically established for
the connection a request arrived on. The only thing the transport can prove. It
proves *possession of a key*, never membership. Reaches a handler by closure, not
by contract (ADR-0002).

**Anonymous** — the absence of a proven peer: a locally-originated request that
crossed no network. A distinct value, not `null`, so "nobody proved anything" can
never be confused with "the lookup failed".

**Claims / subject (`sub`)** — the verified contents of a membership token. `sub`
is the identity application code reads. *False friend: `sub` is not the proven
peer.* The proven peer exists only as an equality guard inside the binding
middleware; exactly two handlers in the system (hub `/invite`, presence check-in)
may read it as a source.

**Binding rule** — a token is valid only when presented over a connection whose
proven peer matches the token's `sub`. Both checks, always. Possession without
membership is anonymous; membership without possession is a stolen token.

**Mesh** — a trust domain, named by the peerId of the hub that mints its tokens.
The mesh *is* its hub's identity, which is why a compromised hub cannot be revoked
from inside.

**Hub** — the role of minting membership tokens and holding the mesh registries.
*False friend: the hub is not infrastructure and not a device.* Every peer carries
the machinery; becoming a hub is an active act. It has exactly two pieces of real
machinery a plain peer lacks: a timer (a peer going down is not an event — it is
produced by a TTL sweep) and two stores with different consistency needs.

**Relay** — a peer that forwards on a third party's behalf. Deny by default: a
request that arrived from the network may be forwarded only when the peer is
explicitly a relay. *False friend: the libp2p **circuit relay** is a transport
component and a different thing entirely.*

**Circuit relay** — the transport component, and the thing actually deployed at
`relay.httpeers.net`. A stock libp2p Circuit Relay v2 server with **no application
code**: it serves no requests, holds no directory, and is a member of nothing. It
gives every peer dialability; it does not tell peers about each other.

Since ADR-0023 it publishes one **self-description** — its own dialable address and
peerId, written to a file that the ingress serves at a well-known path — so a client
can carry a bare URL instead of a compiled-in identity. That document names **only the
relay**. *Dialability is not enumeration:* a peer still needs the peerId of whoever it
wants to reach, and supplying those is the hub's job, not the relay's.

**Role** — a coarse, namespaced label describing a person or peer
(`std:editor`, `H/photo-curator`). Additive across a union; an unknown role grants
nothing, never a fallback. `std:` is reserved for the mesh protocol.

**Capability** — what code actually checks. Policy names capabilities, never roles,
so renaming or splitting a role touches no `.access` entry. `implies` is
transitive.

**Vocabulary** — a node's own role→capability mapping. Local, and currently
unsigned — a tampered vocabulary expands roles in the *permissive* direction.

**Revocation** — a pulled, cached deny list. Tokens carry `iat` so re-admission
works. An entry names a subject **or** a confirmation key: revoking a subject
withdraws all of its devices, revoking a confirmation key withdraws exactly one.
Removal is bounded by the cache interval rather than immediate, and that bound is what
buys offline verification. It answers *"is that device still allowed?"*; `cnf` answers
*"was this token issued to the device presenting it?"* — neither replaces the other.
The hub itself is irrevocable.

---

## Routing and resources

**Mount** — a path prefix bound to a handler via `provide(prefix, handler)`.
Longest prefix wins; registration order is irrelevant; matching respects segment
boundaries, so `/files` does not match `/filesystem`.

**Handler** — `(Request) => Promise<Response>`. The one contract. A Hono app
already is one.

**Rule set** — a node's own Datalog rules and policies. **Rules** derive capabilities
from roles (the vocabulary, expressed as rules — transitivity is simply what a rule
does). **Policies** allow or deny, naming capabilities and never roles. Deny by
default: a resource no policy allows is denied, and an unknown role derives nothing
because no rule fires for it — falling out of evaluation rather than asserted beside
it. A denial names the checks that failed; an allow names the policy that matched.

*Superseded: the `.access` tree — a root→leaf walk with inheritance, widen-and-narrow,
per-method sub-entries and a separate vocabulary with transitive `implies`. Five
mechanisms where one suffices. Its properties survive as requirements; its evidence
(protos 07 and 09) no longer describes what ships.*

**Edge** — a per-runtime adapter that turns a local `fetch()` into a mesh request:
ServiceWorker + page, Hono/Node, and the in-process double. The third is not a
testing convenience — it is what makes the isomorphism claim falsifiable.

**Advertisement / presence / membership** — the hub's three registries, with three
lifetimes. Membership tolerates eventual consistency; presence (15 s TTL) and
single-use invitation IDs need compare-and-set.


---

## Identifier kinds

Three distinct identifiers, mutually unassignable at the type level so that passing
one where another is expected is a compile error rather than a security bug.

**`PeerKeyId`** — a transport-proven key identity. What the handshake establishes and
what a confirmation claim names.

**`SubjectId`** — the identity a token speaks for. Opaque to core, and may outlive any
particular key.

**`MeshId`** — a trust domain. Opaque; resolved to verifying keys through a directory.

## Provenance labels

Used throughout the specification and never blurred, because the cost of mistaking
one for the other is a plan built on a prediction.

**DERIVED** — generalized from code that runs, with the prototype cited.

**DESIGNED** — no implementation exists. Its acceptance criteria are predictions.


## Prior art

**SAM (Sovereign Agent Mesh)** — `google/sam`, Apache-2.0, explicitly *not* an official
Google product. A zero-config zero-trust libp2p mesh for AI agents sharing MCP tools.
Independently reached this design's binding rule, issuer-key pinning, rotation with a
grace period and deny-by-default, which is external evidence for those four. Supplied
three mechanisms adopted here: Biscuit and Datalog, destination-enforced audience, and
credential injection at the intermediary. One choice deliberately not adopted — it
revokes at token refresh, leaving a revoked node working for hours.

**Biscuit** — the token specification adopted here: public-key verified, offline
attenuation, Datalog authorization. Apache-2.0. Its JavaScript path is
`@biscuit-auth/biscuit-wasm`, whose maturity is a recorded and accepted risk.

# ADR-0014: The unit of transfer is a serialized HTTP message, passed through unjudged

**Date:** 2026-08-20
**Status:** Accepted
**Refines:** ADR-0013

## Context

The question was posed as: what should happen to `fetch` options that have no meaning
over a mesh — `credentials`, `mode`, `cache`, `referrer`, `keepalive`? The options
offered ranged from rejecting them to inventing mesh meanings for them.

The question was malformed. Those options are fetch-layer concerns that influence
what a browser puts *into* a request; none of them appears on the wire. A serialized
HTTP message has headers and a body, and nothing else.

`webrun-wire`'s ADR-0006 already made HTTP/1.1 the wire format. This ADR states the
consequence the API must honour.

## Decision

The peer-to-peer layer is a transport for serialized HTTP messages and nothing more.

A request is serialized to an HTTP message, carried, and deserialized. The identical
serialized form is what a peer hands to a real HTTP client to make an outbound call,
or what a peer accepts as a real inbound HTTP request. The transport does not
classify headers as useful or useless, does not filter, and holds no allow-list or
deny-list.

There is consequently no list of unsupported options in this API, because the API
does not receive options — it receives a message.

## Consequences

The reverse proxy stops being an adapter and becomes a pass-through, which is what
makes "an unmodified third-party service sits behind the mesh with zero changes to
that service" true rather than aspirational.

Conformance can be stated against RFC 9110 message equivalence: what went in comes
out. That is a far stronger and more testable claim than any enumeration of supported
headers.

Header *hygiene* now has to live somewhere else, because the transport has declined
it. Hop-by-hop headers are not forwardable by an HTTP intermediary, and a peer that
re-issues a received message as a real HTTP call is an intermediary. Where that
obligation sits is settled separately.

Header values remain latin1 by HTTP specification, so any Unicode display name, role
label or advertisement description belongs in a body. That is an HTTP constraint the
transport inherits rather than imposes.

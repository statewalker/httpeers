# ADR-0006: `provide()` refuses ambiguity at registration

**Date:** 2026-08-20
**Status:** Accepted

## Context

Mount resolution is settled: longest prefix wins, registration order is irrelevant,
matching respects segment boundaries (`/files` does not match `/filesystem`), and no
match returns null, which the router turns into a 404. Prototype 05 proves the
boundary rule.

Two cases were left open.

**Trailing slash.** `provide('/api/')` and `provide('/api')` differ at exactly one
path: the slashed form matches `/api/x` and `/api/` but not `/api`. Nothing warns.
The record states the constraint on any fix as *"normalise in `provide()`, or
document. Not both, not neither."*

**Equal-depth overlap.** Two mounts that could match the same path at the same
depth are not disambiguated, and the design did not say what should happen.

The project has twice reached the same conclusion about this class of defect. A-3
made the vocabulary throw on a typo, and made the error list every problem rather
than the first. Note 39's `register()` finding is the sharper case: mismatch the
dispatcher key and the adapter prefix and every step reports success — constructed,
started, registered, correct `baseUrl` — while the handler is never called and
requests fall through to the origin server. The remedy recorded there is *refuse to
start*.

## Decision

`provide()` refuses ambiguity rather than resolving it.

- A prefix with a trailing slash throws. There is one canonical spelling, so the two
  forms cannot both exist and no rule about their difference is needed.
- Two mounts that could match the same path at the same depth throw.
- Errors list every conflict found, not the first.
- Nothing is silently rewritten. What was written is what matches, or the author was
  told why not.

## Consequences

Mount tables are validated as whole values, which is what makes ADR-0007's atomic
swap safe: a table either validates completely or is never installed.

A mount table cannot be built incrementally from untrusted or generated prefixes
without catching. That is the intended trade: a generated prefix that collides is a
bug, and it now surfaces where it was generated rather than as a request that
mysteriously reaches the wrong handler.

The strictness is at registration only. Request matching stays a pure longest-prefix
walk with no ambiguity left to resolve at runtime.

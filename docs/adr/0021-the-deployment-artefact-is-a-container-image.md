# ADR-0021: The deployment artefact is a container image, published by CI

**Date:** 2026-09-07
**Status:** Accepted
**Amends:** `docs/superpowers/specs/2026-08-18-httpeers-stack-design.md` §3, §13

## Context

The httpeers-stack design rejected Docker explicitly — "pnpm scripts, no Docker",
with compose-as-the-artefact and an npx CLI named as the alternatives it turned
down. That was the right call for what it was designing: an **installable reference
deployment**, whose value is that a reader can run `pnpm start` and watch the mesh
come up, and whose parity with a server was achieved by the two paths differing only
in whether TLS environment variables were set.

Putting the relay on the public internet is a different problem. It needs an artefact
that CI can publish and a server can pull without a checkout, a toolchain, or a
matching Node version; that is byte-identical between what was tested and what runs;
and that can be rolled back to an exact prior state.

## Decision

Every deployable service in `statewalker/httpeers` ships as a container image
published to GHCR, tagged `latest` and `sha-<commit>`. Deployment is `docker compose
pull && up -d`, driven by CI over SSH.

The `pnpm start` path is **retained, not replaced**. Deleting it would make the local
and server paths diverge in a second way, which is the thing the original decision was
protecting.

## Consequences

Rollback becomes exact rather than approximate: every commit that built has a tag.

The images carry no secrets. The relay's signing key arrives on a volume and the
object store's credentials arrive as environment variables, because the repository
and therefore the images are public.

A second toolchain now exists — Dockerfiles, a registry, workflows — that the
reference deployment does not need and does not use. That cost is accepted; it is
paid once per deployable rather than per developer.

CI gained the ability to change production. That is mitigated by ADR-0023's
assertions, not by trusting the pipeline.

/**
 * `createPeerRouter`: local dispatch, and the `allowForward` gate (R-2).
 *
 * The mount truth table and the peer-prefix stripping/forwarding mechanics
 * are pinned in `mounts.test.ts`; this file covers what that one does not:
 * 404 on an unmounted local path, the `access` wrapper applying to local
 * traffic only, and — the property that matters for R-2 — that a denied
 * forward never reaches `remote` at all.
 *
 * That last point is deliberately not just "the response is 403": the
 * vulnerability this router closes was invisible precisely because a
 * disallowed forward still *did the work* (dialled a stranger, pumped a
 * stream) while returning a response that looked fine. A test that only
 * checks the status code would pass against that broken router too. These
 * tests assert on the stub itself: it must never be called.
 */
import { describe, expect, it, vi } from "vitest";
import { createMounts, createPeerRouter } from "../src/router.js";

const SELF = "12D3KooWSelfaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "12D3KooWOtherbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function build() {
  const mounts = createMounts();
  mounts.provide("/test", async (req) => new Response(new URL(req.url).pathname));
  const remote = vi.fn(async (_peer: string, _req: Request) => new Response("remote"));
  return { mounts, remote };
}

describe("createPeerRouter: local dispatch", () => {
  it("serves an unprefixed path locally", async () => {
    const { mounts, remote } = build();
    const route = createPeerRouter({ selfPeerId: SELF, mounts, remote });
    const res = await route(new Request("http://p/test/x"));
    expect(await res.text()).toBe("/test/x");
    expect(remote).not.toHaveBeenCalled();
  });

  it("404s an unmounted local path", async () => {
    const { mounts, remote } = build();
    const route = createPeerRouter({ selfPeerId: SELF, mounts, remote });
    const res = await route(new Request("http://p/nope"));
    expect(res.status).toBe(404);
  });

  it("applies the access wrapper to local traffic only", async () => {
    const mounts = createMounts();
    mounts.provide("/test", async () => new Response("ok"));
    const remote = vi.fn(async () => new Response("remote"));
    const route = createPeerRouter({
      selfPeerId: SELF,
      mounts,
      remote,
      access: () => async () => new Response("denied", { status: 403 }),
      allowForward: async () => true,
    });
    expect((await route(new Request("http://p/test/x"))).status).toBe(403);
    expect((await route(new Request(`http://p/${OTHER}/test/x`))).status).toBe(200);
    expect(remote).toHaveBeenCalledOnce();
  });
});

describe("createPeerRouter: allowForward — deny by default (R-2)", () => {
  it("with no allowForward supplied, a foreign prefix is refused and remote() is never called", async () => {
    const { mounts, remote } = build();
    const route = createPeerRouter({ selfPeerId: SELF, mounts, remote });

    const res = await route(new Request(`http://p/${OTHER}/test/x`));

    expect(res.status).toBe(403);
    expect(remote).not.toHaveBeenCalled();
  });

  it("when allowForward denies, remote() is never called — the damage is the work done, not the answer given", async () => {
    const { mounts, remote } = build();
    const allowForward = vi.fn(async (_req: Request, _target: string) => false);
    const route = createPeerRouter({ selfPeerId: SELF, mounts, remote, allowForward });

    const res = await route(new Request(`http://p/${OTHER}/test/x`));

    expect(res.status).toBe(403);
    expect(remote).not.toHaveBeenCalled();
    expect(allowForward).toHaveBeenCalledOnce();
    expect(allowForward.mock.calls[0]?.[1]).toBe(OTHER);
  });

  it("when allowForward permits, remote() is called with the target and the stripped request", async () => {
    const { mounts, remote } = build();
    const route = createPeerRouter({
      selfPeerId: SELF,
      mounts,
      remote,
      allowForward: async () => true,
    });

    const res = await route(new Request(`http://p/${OTHER}/test/x?a=1`));

    expect(await res.text()).toBe("remote");
    expect(remote).toHaveBeenCalledOnce();
    expect(remote.mock.calls[0]?.[0]).toBe(OTHER);
    const forwarded = remote.mock.calls[0]?.[1] as Request;
    expect(new URL(forwarded.url).pathname).toBe("/test/x");
    expect(new URL(forwarded.url).search).toBe("?a=1");
  });

  it("a denied forward never dials out even when the local mount table would have matched the remainder", async () => {
    // Guards against a router that only checks allowForward for the RESPONSE
    // shape but still constructs/dispatches the outbound request first.
    const mounts = createMounts();
    mounts.provide("/", async () => new Response("local"));
    const remote = vi.fn(async () => new Response("should never happen"));
    const route = createPeerRouter({
      selfPeerId: SELF,
      mounts,
      remote,
      allowForward: async () => false,
    });

    await route(new Request(`http://p/${OTHER}/`));

    expect(remote).not.toHaveBeenCalled();
  });
});

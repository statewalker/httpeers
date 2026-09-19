/**
 * The proxy page re-issues a mesh request to an outside origin. What leaves
 * must carry none of the mesh's own headers -- neither the membership token
 * nor the proven peer -- while the application's `Authorization` and the
 * route's typed credential go through.
 *
 * `urlUpstream` no longer drops `authorization` on its own (it belongs to the
 * application), so the mesh token staying home now depends entirely on this
 * page naming `MESH_CREDENTIAL_HEADERS`. A missing name would hand every
 * visitor's membership token to whatever origin a route points at.
 */

import { MESH_TOKEN_HEADER, PEER_ID_HEADER } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { proxyUpstream } from "../src/shared/proxy-upstream.js";

function echo(): { fetchImpl: typeof fetch; seen: Headers[] } {
  const seen: Headers[] = [];
  return {
    seen,
    fetchImpl: (async (input: RequestInfo | URL) => {
      seen.push(new Headers((input as Request).headers));
      return new Response("ok");
    }) as typeof fetch,
  };
}

describe("the proxy page's upstream", () => {
  it("sends neither the membership token nor the proven peer to the outside origin", async () => {
    const { fetchImpl, seen } = echo();
    const upstream = proxyUpstream(
      { prefix: "/api", upstream: "https://api.example", describe: "", secretHeader: null },
      undefined,
      fetchImpl,
    );

    await upstream(
      new Request("http://mesh.local/v1/x", {
        headers: { [MESH_TOKEN_HEADER]: "MESH", [PEER_ID_HEADER]: "12D3KooWPeer" },
      }),
    );

    expect(seen[0]?.has(MESH_TOKEN_HEADER)).toBe(false);
    expect(seen[0]?.has(PEER_ID_HEADER)).toBe(false);
  });

  it("forwards the caller's Authorization, and the typed credential wins over it", async () => {
    const plain = echo();
    await proxyUpstream(
      { prefix: "/api", upstream: "https://api.example", describe: "", secretHeader: null },
      undefined,
      plain.fetchImpl,
    )(new Request("http://mesh.local/x", { headers: { authorization: "Bearer app-key" } }));
    expect(plain.seen[0]?.get("authorization")).toBe("Bearer app-key");

    const typed = echo();
    await proxyUpstream(
      {
        prefix: "/api",
        upstream: "https://api.example",
        describe: "",
        secretHeader: "authorization",
      },
      { name: "authorization", value: "Bearer operator-key" },
      typed.fetchImpl,
    )(new Request("http://mesh.local/x", { headers: { authorization: "Bearer app-key" } }));
    expect(typed.seen[0]?.get("authorization")).toBe("Bearer operator-key");
  });
});

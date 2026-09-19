/**
 * Every member-side writer puts the membership token in `MESH_TOKEN_HEADER`,
 * and none of them touches `Authorization`.
 *
 * THE DEFECT THIS PINS, measured live: LiteLLM's Playground, reached through a
 * page's ServiceWorker edge, sends its own key as `Authorization: Bearer
 * sk-...` (the OpenAI SDK always does). The edge would not overwrite a page's
 * `Authorization`, so the mesh token was never attached, and the hub tried to
 * verify the LiteLLM key as a mesh token: `401 "malformed token"`. With the
 * mesh in its own header the two credentials cannot meet.
 */

import { MESH_TOKEN_HEADER } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { createEdgeDispatch } from "../src/edge-dispatch.js";
import { peerRequest } from "../src/peer-request.js";

const BOB = "12D3KooWBobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function capturingEdge(token = "REAL-TOKEN") {
  const seen: Request[] = [];
  const edge = createEdgeDispatch({
    key: "peers",
    dispatch: async (req) => {
      seen.push(req);
      return new Response("ok");
    },
    token: () => token,
  });
  return { edge, seen };
}

describe("peerRequest", () => {
  it("puts the token in MESH_TOKEN_HEADER, not Authorization", () => {
    const req = peerRequest("/x", { token: "T" });
    expect(req.headers.get(MESH_TOKEN_HEADER)).toBe("T");
    expect(req.headers.has("authorization")).toBe(false);
  });

  it("keeps the caller's own Authorization beside the token", () => {
    const req = peerRequest("/x", { token: "T", headers: { authorization: "Bearer sk-app" } });
    expect(req.headers.get(MESH_TOKEN_HEADER)).toBe("T");
    expect(req.headers.get("authorization")).toBe("Bearer sk-app");
  });
});

describe("the ServiceWorker edge", () => {
  it("attaches the membership token in MESH_TOKEN_HEADER", async () => {
    const { edge, seen } = capturingEdge();
    await edge(new Request(`http://local/peers/${BOB}/llm/v1/models`));
    expect(seen[0]?.headers.get(MESH_TOKEN_HEADER)).toBe("REAL-TOKEN");
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  it("attaches the token even when the page set its own Authorization", async () => {
    const { edge, seen } = capturingEdge();
    await edge(
      new Request(`http://local/peers/${BOB}/llm/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer sk-litellm-key" },
        body: "{}",
      }),
    );
    expect(seen[0]?.headers.get(MESH_TOKEN_HEADER)).toBe("REAL-TOKEN");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-litellm-key");
  });

  it("never overwrites a membership token the page set itself", async () => {
    // A page calling a peer with a token it was handed out of band meant it --
    // the rule the edge always had, now on the mesh's own header.
    const { edge, seen } = capturingEdge();
    await edge(
      new Request(`http://local/peers/${BOB}/x`, { headers: { [MESH_TOKEN_HEADER]: "OTHER" } }),
    );
    expect(seen[0]?.headers.get(MESH_TOKEN_HEADER)).toBe("OTHER");
  });
});

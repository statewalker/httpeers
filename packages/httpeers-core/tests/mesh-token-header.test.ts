/**
 * The membership token travels in the mesh's OWN header, never `Authorization`.
 *
 * `Authorization` belongs to the application a request is addressed to. A page
 * calling LiteLLM through the mesh puts LiteLLM's key there, and while the mesh
 * read its token from the same header the two collided: the edge would not
 * overwrite the page's value, so the hub tried to verify an `sk-...` key as a
 * mesh token and answered `401 "malformed token"`. One namespaced header,
 * spelled once here, is what every writer and the one reader share.
 */

import { describe, expect, it } from "vitest";
import {
  MESH_CREDENTIAL_HEADERS,
  MESH_TOKEN_HEADER,
  PEER_ID_HEADER,
  readMeshToken,
  setMeshToken,
} from "../src/index.js";

describe("the membership-token header", () => {
  it("is namespaced like the proven-peer header, not Authorization", () => {
    expect(MESH_TOKEN_HEADER).toBe("x-httpeers-token");
  });

  it("carries the bare token, with no auth scheme", () => {
    const headers = new Headers();
    setMeshToken(headers, "EnQKCgoIbWVzaA");
    expect(headers.get(MESH_TOKEN_HEADER)).toBe("EnQKCgoIbWVzaA");
    expect(headers.has("authorization")).toBe(false);
  });

  it("reads the token back from a request", () => {
    const req = new Request("http://peer.local/x", {
      headers: { [MESH_TOKEN_HEADER]: "EnQKCgoIbWVzaA" },
    });
    expect(readMeshToken(req)).toBe("EnQKCgoIbWVzaA");
  });

  it("reads an absent or empty header as no token", () => {
    expect(readMeshToken(new Request("http://peer.local/x"))).toBeNull();
    const empty = new Request("http://peer.local/x", { headers: { [MESH_TOKEN_HEADER]: "" } });
    expect(readMeshToken(empty)).toBeNull();
  });

  it("never reads Authorization, whatever it carries", () => {
    const req = new Request("http://peer.local/x", {
      headers: { authorization: "Bearer EnQKCgoIbWVzaA" },
    });
    expect(readMeshToken(req)).toBeNull();
  });

  it("is listed, with the proven-peer header, as what must not leave the mesh", () => {
    // What a proxy re-issuing a request to a third party strips -- one list,
    // so no caller can forget one of the two, and Authorization is not on it.
    expect([...MESH_CREDENTIAL_HEADERS].sort()).toEqual([MESH_TOKEN_HEADER, PEER_ID_HEADER].sort());
    expect(MESH_CREDENTIAL_HEADERS).not.toContain("authorization");
  });
});

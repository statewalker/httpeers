/**
 * The Sharer's half of the cookie jars: name the Guest on every request to
 * `/s`, from the peer id the mesh proved, never from what the Guest sent.
 */

import { ANONYMOUS, type FetchHandler, lookupPeer } from "@statewalker/httpeers-core";
import { BRIDGE_GUEST_HEADER } from "./upstreams.js";

export function stampGuest(handler: FetchHandler): FetchHandler {
  return (request) => {
    const peer = lookupPeer(request) ?? ANONYMOUS;
    const headers = new Headers(request.headers);
    // Overwritten, not merged: a Guest's own value would let it pick a jar.
    headers.delete(BRIDGE_GUEST_HEADER);
    if (peer !== ANONYMOUS) headers.set(BRIDGE_GUEST_HEADER, peer);
    return handler(new Request(request, { headers }));
  };
}

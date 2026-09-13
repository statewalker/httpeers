/**
 * A remote peer's app, rendered as a page that can reach ONLY that peer.
 *
 * TWO MECHANISMS, and both are needed. `pinnedPeer` is the pin: a handler that
 * cannot express a request to any peer but its own, because the peer is
 * supplied once at mount time and the path is data. `contain` closes the hole
 * the pin cannot — a root-absolute URL from inside the rendered page resolves
 * against the VIEWER's origin, silently, and `<base href>` does not fix it.
 */

export {
  type Containment,
  contain,
  type ContainOptions,
  frameSandbox,
  policyFor,
} from "./contain.js";
export { type Landing, PIN_REFUSED, pinnedPeer, type PinnedPeerInit } from "./pin.js";

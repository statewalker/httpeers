/**
 * The Node profile. Everything here is why the root export is not this.
 *
 * `tcp()` cannot run in a browser, and the prototype hard-coded it inside its
 * node factory — so importing the transport module at all dragged a Node-only
 * transport into a browser bundle, in a package whose whole claim is that one
 * implementation runs on both. Separating the profiles is the fix, and the
 * root's boundary test asserts `@libp2p/tcp` never appears there.
 */

import { tcp } from "@libp2p/tcp";
import type { TransportFactory } from "./transport.js";

/**
 * Transports for a server: TCP, and nothing a page could not also do.
 *
 * Listed as a function rather than a constant so a caller gets fresh factory
 * instances — libp2p's are not reusable across nodes.
 */
export function nodeTransports(): TransportFactory[] {
  return [tcp() as unknown as TransportFactory];
}

/**
 * Make something reachable to mesh members.
 *
 * The reverse proxy and "expose a local app" are ONE MECHANISM — twelve
 * scenarios, written once and run in Node and Chromium, established that. Only
 * the last step differs: a local handler is *called*, a URL upstream is
 * *re-issued*. Matching, rewriting, the listing, the marker header and
 * streaming are shared.
 */

export {
  MARKER,
  type Route,
  routeTable,
  type RouteTableInit,
  type Upstream,
  urlUpstream,
  type UrlUpstreamInit,
} from "./expose.js";
export { matchRoute, type ProxyRoute, upstreamUrl } from "./routes.js";
export {
  assertNoSecrets,
  rehydrate,
  type RehydrateInit,
  type RouteStore,
  SecretNotPersistableError,
  type StoredRoute,
  toStoredRoute,
} from "./store.js";

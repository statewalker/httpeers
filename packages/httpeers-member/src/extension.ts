/**
 * The browser half of a member WITHOUT the ServiceWorker edge: for a runtime
 * that has WebRTC and IndexedDB but cannot (or need not) mount an edge, such
 * as a Chrome MV3 extension's offscreen document, or a worker.
 *
 * Everything `./browser` offers except `mountEdge` and `createSession` (whose
 * default platform mounts one). Nothing reachable from here imports
 * `@statewalker/webrun-http-browser`, so a bundle of it builds without that
 * package installed (`tests/boundary.test.ts`, `tests/extension-bundle.test.ts`).
 */

export {
  type CreateBrowserNodeInit,
  createBrowserNode,
  dialNeedsPermissiveGater,
} from "./browser-profile.js";
export {
  type ExtensionPlatformInit,
  extensionPlatform,
  type RuntimeMessages,
  runtimeMessageWake,
  WAKE_MESSAGE_TYPE,
} from "./extension-platform.js";
export { idbBackend, idbBytesBackend } from "./idb-backends.js";
export {
  type WakeDocument,
  type WakeWindow,
  type WatchPageWakeInit,
  watchPageWake,
} from "./page-wake.js";
export { type ResetResult, resetBrowserState } from "./reset.js";

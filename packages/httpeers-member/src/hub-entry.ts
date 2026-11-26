/**
 * `@statewalker/httpeers-member/browser-hub`: a hub assembled in a browser
 * runtime with no edge (`startBrowserHub`). Edge-free like `./extension`.
 */

export {
  type BrowserHubHandle,
  type BrowserHubState,
  type StartBrowserHubInit,
  startBrowserHub,
} from "./browser-hub.js";

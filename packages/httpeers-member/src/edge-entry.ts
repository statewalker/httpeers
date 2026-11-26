/**
 * The ServiceWorker edge alone (`@statewalker/httpeers-member/edge`): a page
 * that builds its member with `./extension` and still wants a same-origin URL
 * imports `mountEdge` from here. `./browser` re-exports the same symbols.
 */

export {
  DEFAULT_CONTROL_TIMEOUT_MS,
  DEFAULT_SERVICE_WORKER_URL,
  type MountEdgeInit,
  mountEdge,
  UncontrolledPageError,
} from "./edge.js";

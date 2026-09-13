/**
 * Arm biscuit-wasm, once, before anything touches a token.
 *
 * Every page calls this first. It is app code rather than library code
 * deliberately: `httpeers-access/engine` cannot reach into biscuit-wasm itself
 * (its `exports` map blocks the deep paths) so it takes the already-loaded
 * binding from whoever can satisfy their own bundler. That is us — see
 * `../../vite.shared.ts` for the two aliases that make these imports resolve
 * and why leaving them out kills the page rather than throwing.
 */

import { initBiscuit } from "@statewalker/httpeers-access/engine";
// Aliased to `module/biscuit_bg.js`: the real entry would arm the binding with
// a URL string on import and there would be nothing left to fix.
import * as binding from "@biscuit-auth/biscuit-wasm";
import * as snippet from "#biscuit-snippet";

/** Where the wasm is served from. A static asset beside the bundle, copied into `public/`. */
export const BISCUIT_WASM_URL = "/biscuit_bg.wasm";

/** The one module the binary imports besides the binding — measured, not assumed. */
const SNIPPET_IMPORT = "./snippets/biscuit-auth-314ca57174ae0e6d/inline0.js";

let armed: Promise<void> | undefined;

/** Idempotent: pages call it at start-up and anything else may call it again. */
export async function ensureBiscuit(): Promise<void> {
  armed ??= initBiscuit(BISCUIT_WASM_URL, binding as never, { [SNIPPET_IMPORT]: snippet });
  return armed;
}

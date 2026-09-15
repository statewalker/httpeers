/**
 * The former WASM loader seam — now a no-op, kept only so existing imports of
 * `@statewalker/httpeers-access/engine` keep compiling.
 *
 * It existed because `@biscuit-auth/biscuit-wasm` could not arm itself under a
 * bundler or in a module ServiceWorker. Biscuit is pure TypeScript here
 * (`@statewalker/webrun-biscuit`): there is nothing to instantiate, no `.wasm`
 * to serve, and no bundler alias to maintain. Callers should delete their call;
 * this entry point goes away in the next breaking release.
 *
 * @deprecated Nothing needs initialising.
 */
export async function initBiscuit(
  _source?: unknown,
  _binding?: unknown,
  _imports?: Record<string, unknown>,
): Promise<void> {}

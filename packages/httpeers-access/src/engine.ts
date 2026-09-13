/**
 * The WASM loader seam — optional, and most callers should not import this.
 *
 * WHY IT EXISTS. `@biscuit-auth/biscuit-wasm`'s published entry instantiates
 * its module behind a TOP-LEVEL AWAIT, which a module ServiceWorker forbids.
 * A worker that imports it registers, activates, and then fails to verify
 * anything. `biscuit_bg.js` exports `__wbg_set_wasm`, so instantiating from
 * bytes by hand and arming the shim afterwards does work — measured in a real
 * Chromium (extraction prototype 02).
 *
 * WHEN YOU NEED IT. Under Node the ordinary import works: `.wasm` resolves to
 * an instantiated module. **Under a bundler it does not.** Vite resolves a
 * `.wasm` import to a URL STRING, so biscuit-wasm's own entry runs
 * `__wbg_set_wasm("<url>")` and the first call into the binding reads
 * `.memory` off a string. A PAGE therefore needs this seam, not only a worker
 * -- measured in Chromium, in `httpeers-browser-conformance`.
 *
 * A bundled caller needs three things, and each was found by a failure:
 *   1. ALIAS `@biscuit-auth/biscuit-wasm` to `module/biscuit_bg.js`, or its
 *      entry loads anyway and overwrites what this armed. (Symptom: the page
 *      dies outright rather than throwing.)
 *   2. Keep it out of the dependency pre-bundler, or an optimized copy becomes
 *      a second module instance and the armed one is not the one called.
 *      (Symptom: `undefined` reading `biscuitbuilder_new`.)
 *   3. Import the binding through that same specifier, for the same reason.
 *
 * TWO COSTS, BOTH REAL AND BOTH INHERITED, measured rather than assumed:
 *
 *  1. The deep import the seam needs is NOT RESOLVABLE through biscuit-wasm's
 *     own `exports` map — it is `{ "import": "./module/biscuit.js" }` with no
 *     wildcard, so `@biscuit-auth/biscuit-wasm/module/biscuit_bg.js` cannot be
 *     imported by any strict resolver. Using it means a documented bundler
 *     alias, a vendored copy, or an upstream change.
 *  2. The wasm imports snippet modules whose directory names are content
 *     hashes. Seven directories ship; `WebAssembly.Module.imports` reports the
 *     binary referencing exactly ONE of them
 *     (`biscuit-auth-314ca57174ae0e6d/inline0.js`, a `performance.now()`
 *     wrapper) at 0.6.0 -- measured, where this comment previously said seven.
 *     One import can be named by hand; a future version referencing more would
 *     want `import.meta.glob` or the equivalent.
 *
 * Because of (1) and (2) this module deliberately does NOT reach into
 * biscuit-wasm itself. It takes the already-loaded binding module from the
 * caller, who is the only one positioned to satisfy their own bundler.
 */

/**
 * `WebAssembly` and `BufferSource` are declared by the DOM and WebWorker libs,
 * neither of which this package includes — including the DOM lib is how a
 * DOM-only global slips in unnoticed. These declarations are MODULE-LOCAL, so
 * they describe what is used here without colliding with the real ones in any
 * consumer that has them. Only the two members actually called are described:
 * a fuller copy would be a second source of truth to drift.
 */
type Bytes = ArrayBuffer | ArrayBufferView;

declare const WebAssembly: {
  instantiate(
    bytes: Bytes,
    imports: Record<string, unknown>,
  ): Promise<{ instance: { exports: unknown } }>;
};

/** The shape `biscuit_bg.js` exposes. Structural, so no deep import is needed here. */
export interface BiscuitBinding {
  __wbg_set_wasm(exports: unknown): void;
}

/**
 * Instantiate biscuit-wasm from bytes and arm the binding module.
 *
 * `source` is the wasm itself — a `BufferSource`, or a URL to fetch it from.
 * `binding` is biscuit-wasm's `biscuit_bg.js`, which the caller imports (see
 * the note above on why this module cannot).
 *
 * `__wbindgen_start()` is NOT called here, and does not need to be: checked by
 * deliberately omitting it in a browser, because `biscuit.js` does call it and
 * assuming it were required would have been the easy mistake.
 *
 * @example A Vite page, with the alias and `optimizeDeps.exclude` above in place
 * ```ts
 * import * as binding from "@biscuit-auth/biscuit-wasm";
 * import * as snippet from "…/snippets/biscuit-auth-314ca57174ae0e6d/inline0.js";
 * await initBiscuit("/biscuit_bg.wasm", binding, {
 *   "./snippets/biscuit-auth-314ca57174ae0e6d/inline0.js": snippet,
 * });
 * ```
 */
export async function initBiscuit(
  source: Bytes | string | URL,
  binding: BiscuitBinding,
  imports: Record<string, unknown> = {},
): Promise<void> {
  const bytes =
    typeof source === "string" || source instanceof URL
      ? await (await fetch(source)).arrayBuffer()
      : source;

  const { instance } = await WebAssembly.instantiate(bytes, {
    "./biscuit_bg.js": binding,
    ...imports,
  });

  binding.__wbg_set_wasm(instance.exports);
}

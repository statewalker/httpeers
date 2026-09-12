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
 * WHY YOU PROBABLY DO NOT NEED IT. The architecture puts access checks in the
 * PAGE, not the worker: the ServiceWorker is one side-effecting import of a
 * dispatcher and holds no application code, so the ordinary import works and
 * this seam is an option rather than a requirement.
 *
 * TWO COSTS, BOTH REAL AND BOTH INHERITED, measured rather than assumed:
 *
 *  1. The deep import the seam needs is NOT RESOLVABLE through biscuit-wasm's
 *     own `exports` map — it is `{ "import": "./module/biscuit.js" }` with no
 *     wildcard, so `@biscuit-auth/biscuit-wasm/module/biscuit_bg.js` cannot be
 *     imported by any strict resolver. Using it means a documented bundler
 *     alias, a vendored copy, or an upstream change.
 *  2. The wasm imports SEVEN generated snippet modules beyond the binding
 *     module, and their directory names are content hashes. Supplying only
 *     `biscuit_bg.js` fails with `Import #17 "./snippets/…": module is not an
 *     object or function`. They have to be gathered by a bundler feature such
 *     as `import.meta.glob`, which ties the seam to a bundler that has one.
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
 * @example
 * ```ts
 * import * as binding from "@biscuit-auth/biscuit-wasm/module/biscuit_bg.js";
 * const snippets = import.meta.glob("…/snippets/** /*.js", { eager: true });
 * await initBiscuit(new URL("./biscuit_bg.wasm", import.meta.url), binding, snippets);
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

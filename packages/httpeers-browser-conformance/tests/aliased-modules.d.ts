/**
 * Two specifiers that only a BUNDLER can resolve, declared so the typecheck
 * stops trying.
 *
 * Neither exists on disk at the name it is imported by. `vitest.browser.config.ts`
 * aliases both into biscuit-wasm's `module/` directory inside the pnpm store --
 * the entry to `biscuit_bg.js` (skipping the `.wasm` import that a strict
 * resolver rejects), and `#biscuit-snippet` to the inline glue file that the
 * wasm binding asks for by that exact path at init time.
 *
 * That aliasing IS the thing `biscuit-seam.test.ts` exists to prove: a page
 * bundling httpeers-access needs these same lines in its own Vite config, and
 * the test fails loudly if they stop working. So resolving them here with a
 * node-visible path would defeat the test -- an untyped declaration is the
 * honest shape. The test passes the binding as `never` anyway; it never reads
 * a type off either module.
 */

declare module "@biscuit-auth/biscuit-wasm";
declare module "#biscuit-snippet";

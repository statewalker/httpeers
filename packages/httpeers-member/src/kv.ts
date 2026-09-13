/**
 * The key-value seams a member stores things behind — the SHAPES only.
 *
 * The IndexedDB implementations moved to `./browser.js`. They import
 * `idb-keyval`, which needs a real IndexedDB, and a Node member reading its
 * own identity has no business pulling a browser database into its bundle to
 * do it. What is left here is what both platforms genuinely share: two
 * interfaces, and nothing that can run.
 */

export interface AsyncKeyValueBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AsyncBytesBackend {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

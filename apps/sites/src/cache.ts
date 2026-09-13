/**
 * A bounded, time-expiring map. Holds resolutions -- never file contents.
 *
 * WHAT IT IS FOR: classic resolution probes up to three candidates before it
 * finds a file, and each probe is a `stats()` call. Caching the *answer*
 * removes that cost on repeat requests while keeping entries tiny, so memory
 * stays predictable and a re-published file is picked up as soon as the TTL
 * lapses rather than being pinned by a cached body.
 *
 * INVALIDATION IS TIME AND NOTHING ELSE. There is no publish hook to hang it
 * on, so a re-published site can take up to one TTL to appear. That is the
 * accepted trade; `ttlMs: 0` disables the cache entirely while iterating.
 */

export interface TtlCacheOptions {
  /** Zero or less disables the cache completely. */
  ttlMs: number;
  /** Maximum entries; the oldest is evicted first. */
  max: number;
}

interface Entry<V> {
  value: V;
  expires: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(private readonly options: TtlCacheOptions) {}

  get(key: string): V | undefined {
    if (this.options.ttlMs <= 0) return undefined;
    const entry = this.entries.get(key);
    if (entry == null) return undefined;
    if (Date.now() >= entry.expires) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.options.ttlMs <= 0) return;
    if (!this.entries.has(key) && this.entries.size >= this.options.max) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expires: Date.now() + this.options.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

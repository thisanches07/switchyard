export interface AuthCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Validated keys by hash, with a TTL and LRU eviction (spec 004, AC-6). A Map keeps insertion
 * order, so re-inserting on read makes the first entry the least recently used.
 */
export class AuthCache<V extends { id: string }> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: AuthCacheOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(hash: string): V | undefined {
    const entry = this.#entries.get(hash);
    if (!entry) return undefined;
    this.#entries.delete(hash);
    if (entry.expiresAt <= this.#now()) return undefined;
    this.#entries.set(hash, entry);
    return entry.value;
  }

  set(hash: string, value: V): void {
    this.#entries.delete(hash);
    this.#entries.set(hash, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Drops every cached entry for a key id (used right after a revoke). */
  invalidateKey(keyId: string): void {
    for (const [hash, entry] of this.#entries) {
      if (entry.value.id === keyId) this.#entries.delete(hash);
    }
  }
}

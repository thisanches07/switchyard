import type { ExactCacheStore } from "../../core/cache.js";

interface Stored {
  value: string;
  expireAt: number;
}

/**
 * In-process exact cache with Redis-like TTLs (spec 009). The `buildApp` default when no store is
 * injected, and the store of unit and contract tests. Bounded: the oldest entry goes first.
 */
export class MemoryExactCache implements ExactCacheStore {
  readonly #entries = new Map<string, Stored>();
  readonly #now: () => number;
  readonly #maxEntries: number;
  /** When true every call rejects, like an unreachable Redis. */
  failing = false;

  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  get size(): number {
    return this.#entries.size;
  }

  async getMany(keys: readonly string[]): Promise<(string | null)[]> {
    if (this.failing) throw new Error("exact cache unavailable");
    const now = this.#now();
    return keys.map((key) => {
      const stored = this.#entries.get(key);
      if (!stored) return null;
      if (stored.expireAt <= now) {
        this.#entries.delete(key);
        return null;
      }
      return stored.value;
    });
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.failing) throw new Error("exact cache unavailable");
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, expireAt: this.#now() + ttlSeconds * 1_000 });
  }
}

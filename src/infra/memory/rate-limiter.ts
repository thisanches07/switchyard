import type {
  BucketAdjustment,
  BucketSpec,
  BucketState,
  RateLimiter,
  TakeResult,
} from "../../core/ratelimit.js";

interface Stored {
  tokens: number;
  ts: number;
}

const MINUTE_MS = 60_000;

/**
 * In-process token buckets with exactly the arithmetic of `take.lua` / `adjust.lua`
 * (spec 005). Used by unit tests and as the reference for the Redis parity tests.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Stored>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #refill(key: string, capacity: number, now: number): number {
    const stored = this.#buckets.get(key);
    if (!stored) return capacity;
    const elapsed = Math.max(0, now - stored.ts);
    return Math.min(capacity, stored.tokens + (elapsed * capacity) / MINUTE_MS);
  }

  async take(buckets: BucketSpec[]): Promise<TakeResult> {
    const now = this.#now();
    const levels = buckets.map((b) => this.#refill(b.key, b.capacity, now));
    const allowed = buckets.every((b, i) => (levels[i] ?? 0) >= b.cost);

    let retryAfterMs = 0;
    const states: BucketState[] = buckets.map((b, i) => {
      const level = levels[i] ?? 0;
      const remaining = allowed ? level - b.cost : level;
      this.#buckets.set(b.key, { tokens: remaining, ts: now });
      const rate = b.capacity / MINUTE_MS;
      if (!allowed && level < b.cost) {
        retryAfterMs = Math.max(retryAfterMs, (b.cost - level) / rate);
      }
      return {
        key: b.key,
        capacity: b.capacity,
        remaining,
        resetMs: Math.max(0, (b.capacity - remaining) / rate),
      };
    });
    return { allowed, buckets: states, retryAfterMs };
  }

  async adjust(adjustments: BucketAdjustment[]): Promise<void> {
    const now = this.#now();
    for (const a of adjustments) {
      const level = this.#refill(a.key, a.capacity, now);
      this.#buckets.set(a.key, { tokens: Math.min(a.capacity, level + a.delta), ts: now });
    }
  }

  async peek(key: string, capacity: number): Promise<number> {
    return this.#refill(key, capacity, this.#now());
  }
}

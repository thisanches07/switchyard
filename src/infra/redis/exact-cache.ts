import type { Redis } from "ioredis";
import type { ExactCacheStore } from "../../core/cache.js";

/**
 * Exact response cache in Redis (spec 009, ADR-0006): one `MGET` per lookup (every candidate of
 * an alias in one round trip) and `SET … EX` per write. The client fails fast while Redis is down
 * (no offline queue), and the cache stage then skips the layer.
 */
export class RedisExactCache implements ExactCacheStore {
  constructor(private readonly redis: Redis) {}

  async getMany(keys: readonly string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    return this.redis.mget(...keys);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }
}

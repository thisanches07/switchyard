import { Redis } from "ioredis";
import type { DependencyCheck } from "../../core/health.js";

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    // Fail fast instead of queueing commands forever while Redis is down.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
}

export function redisCheck(redis: Redis): DependencyCheck {
  return {
    name: "redis",
    async check(signal) {
      signal.throwIfAborted();
      if (redis.status === "wait") await redis.connect();
      await redis.ping();
    },
  };
}

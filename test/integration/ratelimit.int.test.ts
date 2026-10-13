import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BucketSpec, RateLimiter } from "../../src/core/ratelimit.js";
import { MemoryRateLimiter } from "../../src/infra/memory/rate-limiter.js";
import { RedisRateLimiter } from "../../src/infra/redis/rate-limiter.js";

describe("RedisRateLimiter (Lua token buckets on real Redis)", () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let limiter: RedisRateLimiter;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7.4.11-alpine").start();
    redis = new Redis(container.getConnectionUrl());
    limiter = new RedisRateLimiter(redis, { timeoutMs: 2_000 });
  });

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const req = (capacity: number, cost = 1, key = "sy:rl:key:k:req"): BucketSpec => ({
    key,
    capacity,
    cost,
  });

  it("starts full, debits until empty and reports a retry delay", async () => {
    for (let i = 0; i < 3; i += 1) expect((await limiter.take([req(3)])).allowed).toBe(true);
    const rejected = await limiter.take([req(3)]);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(15_000);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it("is all-or-nothing across buckets", async () => {
    await limiter.take([req(100, 90, "t")]);
    const result = await limiter.take([req(10, 1, "r"), req(100, 20, "t")]);
    expect(result.allowed).toBe(false);
    expect(await limiter.peek("r", 10)).toBe(10);
  });

  // Redis refills with its own clock, so upper bounds use the time this test actually took:
  // a slow CI runner must not turn a correct refill into a failure.
  it("refills continuously", async () => {
    const started = performance.now();
    await limiter.take([req(600, 600)]); // 10 per second
    await new Promise((r) => setTimeout(r, 350));
    const level = await limiter.peek("sy:rl:key:k:req", 600);
    const elapsedS = (performance.now() - started) / 1_000;
    expect(level).toBeGreaterThanOrEqual(3);
    expect(level).toBeLessThanOrEqual(10 * elapsedS + 0.5);
  });

  it("keeps fractional balances (floats survive the Lua boundary)", async () => {
    const started = performance.now();
    await limiter.take([req(60, 59.5)]);
    const level = await limiter.peek("sy:rl:key:k:req", 60);
    const elapsedS = (performance.now() - started) / 1_000;
    // 0.5 left, plus at most one unit per second of refill while the test ran.
    expect(level).toBeGreaterThanOrEqual(0.5);
    expect(level).toBeLessThanOrEqual(0.5 + elapsedS + 0.01);
    expect(Number.isInteger(level)).toBe(false);
  });

  it("adjust refunds up to capacity and charges below zero", async () => {
    const key = "sy:rl:key:k:tok";
    await limiter.take([req(1_000, 600, key)]);
    await limiter.adjust([{ key, capacity: 1_000, delta: 900 }]);
    expect(await limiter.peek(key, 1_000)).toBe(1_000);
    const charged = performance.now();
    await limiter.adjust([{ key, capacity: 1_000, delta: -1_500 }]);
    const level = await limiter.peek(key, 1_000);
    const elapsedS = (performance.now() - charged) / 1_000;
    expect(level).toBeLessThan(0);
    expect(level).toBeLessThanOrEqual(-500 + (1_000 / 60) * elapsedS + 0.5);
    expect((await limiter.take([req(1_000, 1, key)])).allowed).toBe(false);
  });

  it("expires idle buckets once they would be full again", async () => {
    await limiter.take([req(60, 1)]);
    const ttl = await redis.pttl("sy:rl:key:k:req");
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(61_000 + 1_000);
  });

  it("admits exactly the capacity under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.take([req(10)])));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("matches the in-memory reference for the same sequence", async () => {
    const memory: RateLimiter = new MemoryRateLimiter();
    const sequence: BucketSpec[][] = [
      [req(5, 2, "a"), req(100, 40, "b")],
      [req(5, 2, "a"), req(100, 40, "b")],
      [req(5, 2, "a"), req(100, 40, "b")],
      [req(5, 1, "a")],
      [req(5, 1, "a")],
    ];
    for (const step of sequence) {
      const [fromRedis, fromMemory] = [await limiter.take(step), await memory.take(step)];
      expect(fromRedis.allowed).toBe(fromMemory.allowed);
    }
  });

  it("rejects when Redis does not answer in time", async () => {
    const slow = new RedisRateLimiter(redis, { timeoutMs: 1 });
    await redis.call("CLIENT", "PAUSE", "200", "ALL");
    await expect(slow.take([req(10)])).rejects.toThrow(/timed out/);
  });
});

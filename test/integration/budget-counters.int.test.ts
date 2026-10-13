import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BudgetRef } from "../../src/core/budget.js";
import { MemoryBudgetCounters } from "../../src/infra/memory/budget-counters.js";
import { RedisBudgetCounters } from "../../src/infra/redis/budget-counters.js";

const key: BudgetRef = { scope: "key", id: "0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d" };
const team: BudgetRef = { scope: "team", id: "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f" };

describe("RedisBudgetCounters (spec 007, AC-10, ADR-0006)", () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let counters: RedisBudgetCounters;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7.4.11-alpine").start();
    redis = new Redis(container.getConnectionUrl());
    counters = new RedisBudgetCounters(redis, { timeoutMs: 2_000 });
  });

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const expireAt = () => Date.now() + 3_600_000;

  it("reads 0 for missing counters", async () => {
    expect(await counters.read("2026-10", [key, team])).toEqual(["0", "0"]);
    expect(await counters.read("2026-10", [])).toEqual([]);
  });

  it("charges key and team atomically, per period, with an expiry", async () => {
    const at = expireAt();
    expect(await counters.charge("2026-10", [key, team], "0.0000140000", at)).toEqual([
      "0.000014",
      "0.000014",
    ]);
    const totals = await counters.charge("2026-10", [key, team], "0.5", at);
    expect(totals.map(Number)).toEqual([0.500014, 0.500014]);
    expect(await counters.read("2026-11", [key])).toEqual(["0"]);
    const ttl = await redis.pttl(`sy:budget:2026-10:key:${key.id}`);
    expect(ttl).toBeGreaterThan(3_500_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
  });

  it("raises lower counters, never lowers higher ones", async () => {
    const at = expireAt();
    await counters.charge("2026-10", [key], "5", at);
    const raised = await counters.raise(
      "2026-10",
      [
        { ref: key, spentUsd: "3" },
        { ref: team, spentUsd: "7.25" },
      ],
      at,
    );
    expect(raised).toBe(1);
    expect(await counters.read("2026-10", [key, team])).toEqual(["5", "7.25"]);
    expect(await redis.pttl(`sy:budget:2026-10:team:${team.id}`)).toBeGreaterThan(3_500_000);
  });

  it("raises many counters in batches", async () => {
    const entries = Array.from({ length: 1_203 }, (_, i) => ({
      ref: { scope: "key", id: `k${i}` } as BudgetRef,
      spentUsd: String(i + 1),
    }));
    expect(await counters.raise("2026-10", entries, expireAt())).toBe(1_203);
    expect(await counters.read("2026-10", [{ scope: "key", id: "k1202" }])).toEqual(["1203"]);
  });

  it("matches the in-memory reference for the same sequence", async () => {
    const memory = new MemoryBudgetCounters();
    const at = expireAt();
    const steps: [string, BudgetRef[]][] = [
      ["0.0000140000", [key, team]],
      ["0.25", [key]],
      ["1.75", [team, key]],
    ];
    for (const [amount, refs] of steps) {
      const [fromRedis, fromMemory] = [
        await counters.charge("2026-10", refs, amount, at),
        await memory.charge("2026-10", refs, amount, at),
      ];
      expect(fromRedis.map(Number)).toEqual(fromMemory.map(Number));
    }
  });

  it("rejects when Redis does not answer in time", async () => {
    const slow = new RedisBudgetCounters(redis, { timeoutMs: 1 });
    await redis.call("CLIENT", "PAUSE", "200", "ALL");
    await expect(slow.read("2026-10", [key])).rejects.toThrow(/timed out/);
  });
});

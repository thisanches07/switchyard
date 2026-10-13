import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { BudgetRef } from "../../src/core/budget.js";
import type { UsageEvent } from "../../src/core/usage.js";
import { DrizzleBudgetStore } from "../../src/infra/db/budget-store.js";
import { createDatabase, type Database } from "../../src/infra/db/client.js";
import { DrizzleKeyStore } from "../../src/infra/db/key-store.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";
import { DrizzleUsageStore } from "../../src/infra/db/usage-store.js";
import { createLogger } from "../../src/infra/logger.js";
import { MemoryRateLimiter } from "../../src/infra/memory/rate-limiter.js";
import { RedisBudgetCounters } from "../../src/infra/redis/budget-counters.js";
import { createRedisClient } from "../../src/infra/redis/client.js";
import { generateKey, hashKey } from "../../src/modules/auth/keys.js";
import { periodOf } from "../../src/modules/budgets/period.js";
import { reconcileOnce } from "../../src/modules/budgets/reconcile.js";
import { decimal } from "../../src/modules/pricing/decimal.js";
import { PriceTable } from "../../src/modules/pricing/table.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { testConfig } from "../helpers/config.js";
import { fakeHttp, jsonResponse } from "../helpers/http.js";
import { TEST_PEPPER } from "../helpers/memory-key-store.js";

/** Test-only prices: $1 per token, so each chat below (2 input + 6 output tokens) costs $8. */
const prices = new PriceTable([
  ["mock/*", { input: decimal("1000000"), output: decimal("1000000") }],
]);
const COST = 8;
const chat = { model: "fast", messages: [{ role: "user", content: "12345678" }] };

describe("budgets end to end on Redis and Postgres (spec 007, AC-6/AC-7/AC-10/AC-11)", () => {
  let pg: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let db: Database;
  const clients: Redis[] = [];
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    [pg, redisContainer] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start(),
      new RedisContainer("redis:7.4.11-alpine").start(),
    ]);
    pool = createPostgresPool(pg.getConnectionUri());
    db = createDatabase(pool);
    await migrateDatabase(db);
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    for (const client of clients) client.disconnect();
    await pool?.end();
    await Promise.all([pg?.stop(), redisContainer?.stop()]);
  });

  async function redisAt(url: string) {
    const redis = createRedisClient(url);
    redis.on("error", () => {});
    await redis.connect().catch(() => {});
    clients.push(redis);
    return redis;
  }

  async function gateway(options: { redisUrl?: string; onRedisError?: "open" | "closed" } = {}) {
    const redis = await redisAt(options.redisUrl ?? redisContainer.getConnectionUrl());
    const events: UsageEvent[] = [];
    const config = testConfig({ budgets: { onRedisError: options.onRedisError ?? "closed" } });
    const counters = new RedisBudgetCounters(redis, { timeoutMs: 1_000 });
    const app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config,
      providers: createProviderRegistry(
        config,
        {},
        { http: fakeHttp(() => jsonResponse(500, {})).client },
      ),
      keyStore: new DrizzleKeyStore(db),
      keyPepper: TEST_PEPPER,
      rateLimiter: new MemoryRateLimiter(),
      costEstimator: prices,
      budgetCounters: counters,
      budgetStore: new DrizzleBudgetStore(db),
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    return { app, redis, counters, events };
  }

  /** A team and a key in Postgres; returns the plaintext key and the refs. */
  async function issueKey(name: string, budgets: { key?: string; team?: string }) {
    const store = new DrizzleKeyStore(db);
    const team = await store.createTeam(name, { monthlyBudgetUsd: budgets.team ?? null });
    const plaintext = generateKey();
    const record = await store.createKey({
      teamId: team.id,
      name,
      hash: hashKey(TEST_PEPPER, plaintext),
      prefix: plaintext.slice(0, 10),
      allowedModels: null,
      expiresAt: null,
      monthlyBudgetUsd: budgets.key ?? null,
    });
    const keyRef: BudgetRef = { scope: "key", id: record.id };
    const teamRef: BudgetRef = { scope: "team", id: team.id };
    return { plaintext, keyRef, teamRef };
  }

  const send = (app: FastifyInstance, key: string) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat,
      headers: { authorization: `Bearer ${key}` },
    });

  /** Waits until the asynchronous charges have landed in Redis. */
  async function spendOf(counters: RedisBudgetCounters, ref: BudgetRef, expected: number) {
    const period = periodOf(Date.now()).id;
    const deadline = Date.now() + 5_000;
    let value = 0;
    while (Date.now() < deadline) {
      value = Number((await counters.read(period, [ref]))[0]);
      if (value === expected) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return value;
  }

  it("enforces a hard limit: admitted until spend reaches the budget, then 429", async () => {
    const { app, counters } = await gateway();
    const { plaintext, keyRef } = await issueKey("hard", { key: "10" });
    expect((await send(app, plaintext)).statusCode).toBe(200);
    expect(await spendOf(counters, keyRef, 8)).toBe(8);
    expect((await send(app, plaintext)).statusCode).toBe(200);
    expect(await spendOf(counters, keyRef, 16)).toBe(16);
    const rejected = await send(app, plaintext);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe("budget_exceeded");
    expect(rejected.headers["x-should-retry"]).toBe("false");
  });

  it("bounds the overshoot by the requests in flight when spend crossed the budget (AC-7)", async () => {
    const { app, counters } = await gateway();
    const BUDGET = 44; // 5.5 requests' worth
    const CONCURRENCY = 5;
    const { plaintext, teamRef } = await issueKey("overshoot", { team: String(BUDGET) });

    let admitted = 0;
    let crossed = false;
    for (let wave = 0; wave < 10; wave += 1) {
      const statuses = (
        await Promise.all(Array.from({ length: CONCURRENCY }, () => send(app, plaintext)))
      ).map((r) => r.statusCode);
      const ok = statuses.filter((s) => s === 200).length;
      expect(ok + statuses.filter((s) => s === 429).length).toBe(CONCURRENCY);
      if (crossed) expect(ok).toBe(0); // once spend ≥ budget, everything is rejected
      admitted += ok;
      const spent = await spendOf(counters, teamRef, admitted * COST);
      expect(spent).toBe(admitted * COST);
      if (spent >= BUDGET) crossed = true;
      if (ok === 0) break;
    }
    const finalSpend = admitted * COST;
    expect(crossed).toBe(true);
    // The final spend exceeds the budget by at most the requests admitted concurrently.
    expect(finalSpend - BUDGET).toBeGreaterThan(0);
    expect(finalSpend - BUDGET).toBeLessThanOrEqual(CONCURRENCY * COST);
  });

  it("restores enforcement within one reconciliation after Redis loses its data (AC-10)", async () => {
    const { app, redis, counters, events } = await gateway();
    const { plaintext, keyRef } = await issueKey("flushed", { key: "16" });
    expect((await send(app, plaintext)).statusCode).toBe(200);
    expect((await send(app, plaintext)).statusCode).toBe(200);
    expect((await send(app, plaintext)).statusCode).toBe(429);
    // The worker stored the events (simulated: the gateway's events go straight to Postgres).
    await new DrizzleUsageStore(db).insertEvents(events);

    await redis.flushall();
    expect(await spendOf(counters, keyRef, 0)).toBe(0); // enforcement lost

    const result = await reconcileOnce({ store: new DrizzleBudgetStore(db), counters });
    expect(result.raised).toBeGreaterThanOrEqual(2); // the key and its team
    expect(await spendOf(counters, keyRef, 16)).toBe(16);
    expect((await send(app, plaintext)).statusCode).toBe(429);
  });

  it("fails closed by default when Redis is unreachable: 503 for budgeted keys only", async () => {
    const { app } = await gateway({ redisUrl: "redis://127.0.0.1:1" });
    const budgeted = await issueKey("closed-budgeted", { key: "10" });
    const unbudgeted = await issueKey("closed-free", {});
    const res = await send(app, budgeted.plaintext);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("budget_unavailable");
    expect((await send(app, unbudgeted.plaintext)).statusCode).toBe(200);
  });

  it("fails open when configured: budgeted keys are served without budget headers", async () => {
    const { app } = await gateway({ redisUrl: "redis://127.0.0.1:1", onRedisError: "open" });
    const budgeted = await issueKey("open-budgeted", { team: "10" });
    const res = await send(app, budgeted.plaintext);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-budget-limit-usd"]).toBeUndefined();
  });
});

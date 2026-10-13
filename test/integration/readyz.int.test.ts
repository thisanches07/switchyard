import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createPostgresPool, postgresCheck } from "../../src/infra/db/postgres.js";
import { createLogger } from "../../src/infra/logger.js";
import { createRedisClient, redisCheck } from "../../src/infra/redis/client.js";
import { testConfig } from "../helpers/config.js";
import { MemoryKeyStore, TEST_PEPPER } from "../helpers/memory-key-store.js";

describe("/readyz with real dependencies", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start(),
      new RedisContainer("redis:7.4.11-alpine").start(),
    ]);
    pool = createPostgresPool(postgres.getConnectionUri());
    redis = createRedisClient(redisContainer.getConnectionUrl());
    app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [postgresCheck(pool), redisCheck(redis)],
      config: testConfig(),
      providers: new Map(),
      keyStore: new MemoryKeyStore(),
      keyPepper: TEST_PEPPER,
      readinessTimeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await pool?.end();
    await postgres?.stop();
    await redisContainer?.stop().catch(() => {});
  });

  it("ready with real Postgres and Redis", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  });

  it("503 listing redis after Redis container stops", async () => {
    await redisContainer.stop();
    const started = performance.now();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", failing: ["redis"] });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

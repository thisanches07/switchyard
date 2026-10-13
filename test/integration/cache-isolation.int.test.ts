import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExactCacheStore, SemanticCacheStore } from "../../src/core/cache.js";
import { createDatabase } from "../../src/infra/db/client.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";
import { DrizzleSemanticCache } from "../../src/infra/db/semantic-cache.js";
import { createRedisClient } from "../../src/infra/redis/client.js";
import { RedisExactCache } from "../../src/infra/redis/exact-cache.js";
import { cacheApp, cacheConfig, fakeEmbedder, vec } from "../helpers/cache.js";
import { MemoryKeyStore } from "../helpers/memory-key-store.js";

/** Wraps a store so tests can wait for the cache's background writes (no sleeping). */
function tracked<T extends object>(store: T, writes: (keyof T)[]) {
  const pending = new Set<Promise<unknown>>();
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (writes.includes(prop as keyof T) && result instanceof Promise) {
          const settled = result.catch(() => {});
          pending.add(settled);
          void settled.finally(() => pending.delete(settled));
        }
        return result;
      };
    },
  });
  return {
    store: proxy,
    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

const QUESTION = "What is the capital of France?";
const NEAR = "capital of France?";
const embedder = () => fakeEmbedder({ [QUESTION]: vec(1, 0), [NEAR]: vec(1, 0.1) });
const ask = (question: string, extra: Record<string, unknown> = {}) => ({
  model: "fast",
  temperature: 0,
  max_tokens: 50,
  messages: [
    { role: "system", content: "Answer in one word." },
    { role: "user", content: question },
  ],
  ...extra,
});

describe("response cache isolation on Redis and Postgres (spec 009, AC-10, AC-12)", () => {
  let pg: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    [pg, redisContainer] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start(),
      new RedisContainer("redis:7.4.11-alpine").start(),
    ]);
    pool = createPostgresPool(pg.getConnectionUri());
    await migrateDatabase(createDatabase(pool));
    redis = createRedisClient(redisContainer.getConnectionUrl());
    redis.on("error", () => {});
    await redis.connect();
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    redis?.disconnect();
    await pool?.end();
    await Promise.all([pg?.stop(), redisContainer?.stop()]);
  });

  async function gateway() {
    const exact = tracked<ExactCacheStore>(new RedisExactCache(redis), ["set"]);
    const semantic = tracked<SemanticCacheStore>(new DrizzleSemanticCache(createDatabase(pool)), [
      "insert",
      "recordHit",
    ]);
    const store = new MemoryKeyStore();
    const setup = await cacheApp({
      config: cacheConfig({
        exact: { enabled: true, ttlSeconds: 60 },
        semantic: { enabled: true, similarityThreshold: 0.95 },
      }),
      store,
      exactCache: exact.store,
      semanticCache: semantic.store,
      authenticated: false,
    });
    apps.push(setup.app);
    setup.registry.set("ollama", embedder().provider);
    const settled = () => Promise.all([exact.settled(), semantic.settled()]);
    const keyOf = async (team: string) => {
      const { key } = await store.issueKey({ team, semanticCache: true });
      return async (payload: Record<string, unknown>) => {
        const res = await setup.chat(payload, { authorization: `Bearer ${key}` });
        await settled();
        return res;
      };
    };
    return { ...setup, keyOf };
  }

  it("never serves team A's exact or semantic entry to team B (AC-10)", async () => {
    const { keyOf, spies } = await gateway();
    const teamA = await keyOf("team-a");
    const teamB = await keyOf("team-b");

    expect((await teamA(ask(QUESTION))).headers["x-switchyard-cache"]).toBe("miss");
    expect((await teamA(ask(QUESTION))).headers["x-switchyard-cache"]).toBe("hit");
    expect((await teamA(ask(NEAR))).headers["x-switchyard-cache"]).toBe("semantic-hit");

    // Identical prompt and parameters: team B's first request is a miss on both layers.
    expect((await teamB(ask(QUESTION))).headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(2);
    // And from then on it hits its own entries only.
    expect((await teamB(ask(QUESTION))).headers["x-switchyard-cache"]).toBe("hit");
    expect((await teamB(ask(NEAR))).headers["x-switchyard-cache"]).toBe("semantic-hit");
    expect(spies.mock?.requests).toHaveLength(2);

    const teams = await pool.query(
      "SELECT count(DISTINCT team_id)::int AS n FROM semantic_cache_entries",
    );
    expect(teams.rows[0].n).toBe(2);
    const keys = await redis.keys("sy:cache:exact:v1:*");
    expect(keys).toHaveLength(2);
  });

  it.each([
    ["max_tokens", { max_tokens: 51 }],
    ["response_format", { response_format: { type: "json_object" } }],
    [
      "system prompt",
      {
        messages: [
          { role: "system", content: "Answer in two words." },
          { role: "user", content: QUESTION },
        ],
      },
    ],
  ])("does not share entries within a team when %s differs (AC-10)", async (_name, extra) => {
    const { keyOf, spies } = await gateway();
    const team = await keyOf(`params-${_name}`);
    await team(ask(QUESTION));
    const changed = await team(ask(QUESTION, extra));
    expect(changed.headers["x-switchyard-cache"]).toBe("miss");
    const near = await team(ask(NEAR, extra));
    // The near question now has an entry in the changed scope only (its own miss above).
    expect(near.headers["x-switchyard-cache"]).toBe("semantic-hit");
    expect(spies.mock?.requests).toHaveLength(2);
  });

  it("serves requests as misses while Redis is down (AC-12)", async () => {
    const { keyOf, spies } = await gateway();
    const team = await keyOf("redis-down");
    await redisContainer.stop();
    const res = await team(ask("Is Redis there?", { temperature: 0 }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(1);
  });
});

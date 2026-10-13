import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createLogger } from "../../src/infra/logger.js";
import { createRedisClient } from "../../src/infra/redis/client.js";
import { RedisRateLimiter } from "../../src/infra/redis/rate-limiter.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { testConfig } from "../helpers/config.js";
import { fakeHttp, jsonResponse } from "../helpers/http.js";
import { MemoryKeyStore, TEST_PEPPER } from "../helpers/memory-key-store.js";

const payload = { model: "fast", messages: [{ role: "user", content: "hi" }] };

describe("rate limits over HTTP with Redis (spec 005)", () => {
  let container: StartedRedisContainer;
  const clients: Redis[] = [];
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    container = await new RedisContainer("redis:7.4.11-alpine").start();
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    for (const c of clients) c.disconnect();
    await container?.stop();
  });

  async function gateway(
    store: MemoryKeyStore,
    redisUrl: string,
    onRedisError: "open" | "closed" = "open",
  ) {
    const redis = createRedisClient(redisUrl);
    redis.on("error", () => {});
    // Like server.ts: connect eagerly so limits apply from the first request.
    await redis.connect().catch(() => {});
    clients.push(redis);
    const config = testConfig({ limits: { onRedisError } });
    const app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config,
      providers: createProviderRegistry(
        config,
        {},
        {
          http: fakeHttp(() => jsonResponse(500, {})).client,
        },
      ),
      keyStore: store,
      keyPepper: TEST_PEPPER,
      rateLimiter: new RedisRateLimiter(redis, { timeoutMs: 1_000 }),
    });
    apps.push(app);
    return app;
  }

  it("enforces one global limit across two gateway instances (AC-9)", async () => {
    const store = new MemoryKeyStore();
    const url = container.getConnectionUrl();
    const [a, b] = [await gateway(store, url), await gateway(store, url)];
    const { key } = await store.issueKey({ team: "global", limits: { rpm: 10 } });
    const headers = { authorization: `Bearer ${key}` };

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 === 0 ? a : b).inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload,
          headers,
        }),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40);
  });

  it("fails open when Redis is unreachable (default policy, AC-10)", async () => {
    const store = new MemoryKeyStore();
    const app = await gateway(store, "redis://127.0.0.1:1", "open");
    const { key } = await store.issueKey({ limits: { rpm: 1 } });
    const headers = { authorization: `Bearer ${key}` };
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit-requests"]).toBeUndefined();
    }
  });

  it("fails closed with 503 when configured (AC-10)", async () => {
    const store = new MemoryKeyStore();
    const app = await gateway(store, "redis://127.0.0.1:1", "closed");
    const { key } = await store.issueKey({ limits: { rpm: 1 } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("rate_limiter_unavailable");
  });
});

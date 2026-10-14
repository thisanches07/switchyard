import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { ConfigError, formatConfigError } from "./config/errors.js";
import { type LoadedConfig, loadConfig } from "./config/load.js";
import { DrizzleBudgetStore } from "./infra/db/budget-store.js";
import { createDatabase } from "./infra/db/client.js";
import { DrizzleKeyStore } from "./infra/db/key-store.js";
import { migrateDatabase } from "./infra/db/migrate.js";
import { createPostgresPool, postgresCheck } from "./infra/db/postgres.js";
import { DrizzleSemanticCache } from "./infra/db/semantic-cache.js";
import { DrizzleUsageStore } from "./infra/db/usage-store.js";
import { createUndiciClient } from "./infra/http/undici-client.js";
import { createKafkaProducer } from "./infra/kafka/producer.js";
import { createLogger } from "./infra/logger.js";
import { RedisBudgetCounters } from "./infra/redis/budget-counters.js";
import { createRedisClient, redisCheck } from "./infra/redis/client.js";
import { RedisExactCache } from "./infra/redis/exact-cache.js";
import { RedisRateLimiter } from "./infra/redis/rate-limiter.js";
import { shutdownTelemetry } from "./infra/telemetry/sdk.js";
import { installShutdown } from "./lifecycle/shutdown.js";
import { scheduleSemanticCleanup } from "./modules/cache/cleanup.js";
import { type ConfigRuntime, createConfigRuntime } from "./modules/config/runtime.js";
import { installReloadSignal, watchConfigFile } from "./modules/config/watch.js";
import { loadPricing } from "./modules/pricing/load.js";
import { unknownPriceCandidates } from "./modules/pricing/table.js";
import { createProviderRegistry } from "./modules/providers/registry.js";
import { createUsagePublisher } from "./modules/usage/publisher.js";

function loadSettings() {
  try {
    const env = loadEnv(process.env);
    const config = loadConfig(env.SWITCHYARD_CONFIG, process.env);
    if (config.usage.enabled && !env.KAFKA_BROKERS) {
      throw new ConfigError("environment", [
        { path: "KAFKA_BROKERS", message: "is required when usage.enabled is true" },
      ]);
    }
    // Spec 007: the price table is loaded once at boot; a missing or invalid file stops the gateway.
    const pricing = loadPricing(config.pricingFile);
    return { env, config, pricing };
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { env, config, pricing } = loadSettings();
  const logger = createLogger({ level: env.LOG_LEVEL });

  // Spec 007, AC-1: models without a verified price are counted as unknown cost, never as free.
  const unpriced = unknownPriceCandidates(config.aliases, pricing);
  if (unpriced.length > 0) {
    logger.warn(
      { models: unpriced, pricingFile: config.pricingFile },
      "unknown price for alias candidates: their cost is reported as unknown and not budgeted",
    );
  }

  // Clients connect lazily: the gateway starts even if a dependency is down,
  // and /readyz reports it (spec 001, AC-5).
  const pool = createPostgresPool(env.DATABASE_URL);
  pool.on("error", (error) => logger.warn({ err: error.message }, "postgres pool error"));
  const db = createDatabase(pool);

  if (env.MIGRATE_ON_BOOT) {
    try {
      await migrateDatabase(db);
      logger.info("database migrations applied");
    } catch (error) {
      logger.fatal({ err: error }, "database migrations failed");
      process.exit(1);
    }
  }

  // Spec 004: make insecure setups visible in the logs.
  if (!env.ADMIN_TOKEN) {
    logger.warn("ADMIN_TOKEN is not set: admin API disabled");
  }
  const devSecrets = [
    env.KEY_PEPPER.startsWith("dev-only") && "KEY_PEPPER",
    env.ADMIN_TOKEN?.startsWith("dev-only") && "ADMIN_TOKEN",
  ].filter(Boolean);
  if (devSecrets.length > 0) {
    logger.warn(
      { settings: devSecrets },
      "dev-only secrets in use: set real values before exposing the gateway",
    );
  }

  const redis = createRedisClient(env.REDIS_URL);
  let redisDown = false;
  redis.on("error", (error: Error) => {
    if (!redisDown) logger.warn({ err: error.message }, "redis connection error");
    redisDown = true;
  });
  redis.on("ready", () => {
    if (redisDown) logger.info("redis connection restored");
    redisDown = false;
  });
  // Connect before listening: rate limiting (spec 005) needs Redis from the first request.
  // If Redis is down the gateway still starts (fail-open policy); the client keeps retrying.
  await Promise.race([
    redis.connect().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
  ]);

  // Hot reload (spec 008, ADR-0018): requests read the runtime's snapshot; TTFB and total
  // timeouts are read per upstream call, so reloaded values apply too.
  let runtime: ConfigRuntime | undefined;
  const http = createUndiciClient(
    () => runtime?.current().config.server.timeouts ?? config.server.timeouts,
  );
  const buildProviders = (next: LoadedConfig) =>
    createProviderRegistry(next, process.env, { http });
  const providers = buildProviders(config);
  runtime = createConfigRuntime({
    initial: { config, providers },
    source: { path: env.SWITCHYARD_CONFIG, env: process.env },
    buildProviders,
    logger,
  });
  const live = runtime;
  const watcher = watchConfigFile({
    path: env.SWITCHYARD_CONFIG,
    enabled: () => live.current().config.routing.hotReload,
    reload: () => live.reload(),
    logger,
  });
  const removeSighup = installReloadSignal(() => live.reload(), {
    platform: process.platform,
    target: process,
  });

  // Usage events (spec 006): buffered in memory, published in the background; Kafka may be down.
  const usage = createUsagePublisher({
    config: config.usage,
    producer:
      config.usage.enabled && env.KAFKA_BROKERS
        ? createKafkaProducer({
            brokers: env.KAFKA_BROKERS,
            clientId: "switchyard-gateway",
            logger,
          })
        : undefined,
    logger,
  });
  usage.start();

  // Spec 009: semantic cache on pgvector; expired entries are deleted hourly while it is enabled.
  const semanticCache = new DrizzleSemanticCache(db);
  const cleanup = scheduleSemanticCleanup({
    store: {
      deleteExpired: (now) =>
        live.current().config.cache.semantic.enabled
          ? semanticCache.deleteExpired(now)
          : Promise.resolve(0),
    },
    clock: Date.now,
    logger,
  });

  const app = await buildApp({
    logger,
    checks: [postgresCheck(pool), redisCheck(redis)],
    config,
    providers,
    runtime,
    keyStore: new DrizzleKeyStore(db),
    rateLimiter: new RedisRateLimiter(redis),
    keyPepper: env.KEY_PEPPER,
    adminToken: env.ADMIN_TOKEN,
    usageRecorder: usage,
    usageReader: new DrizzleUsageStore(db),
    costEstimator: pricing,
    // Spec 007: hot spend counters in Redis, stored spend in Postgres.
    budgetCounters: new RedisBudgetCounters(redis),
    budgetStore: new DrizzleBudgetStore(db),
    // Spec 009: exact cache in Redis, semantic cache in pgvector.
    exactCache: new RedisExactCache(redis),
    semanticCache,
  });

  installShutdown({
    app,
    closers: [
      {
        name: "config-watch",
        close: async () => {
          watcher.stop();
          removeSighup();
          cleanup.stop();
        },
      },
      // After app.close(): in-flight requests have recorded their events. Leave 1 s for the rest.
      { name: "usage-events", close: ({ deadlineAt }) => usage.close(deadlineAt - 1_000) },
      { name: "upstream-http", close: () => http.close() },
      { name: "redis", close: async () => redis.disconnect() },
      { name: "postgres", close: () => pool.end() },
      { name: "telemetry", close: shutdownTelemetry },
    ],
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger,
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (error) {
    logger.fatal({ err: error }, "failed to start HTTP server");
    process.exit(1);
  }
}

await main();

import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { ConfigError, formatConfigError } from "./config/errors.js";
import { loadConfig } from "./config/load.js";
import { createDatabase } from "./infra/db/client.js";
import { DrizzleKeyStore } from "./infra/db/key-store.js";
import { migrateDatabase } from "./infra/db/migrate.js";
import { createPostgresPool, postgresCheck } from "./infra/db/postgres.js";
import { createUndiciClient } from "./infra/http/undici-client.js";
import { createKafkaProducer } from "./infra/kafka/producer.js";
import { createLogger } from "./infra/logger.js";
import { createRedisClient, redisCheck } from "./infra/redis/client.js";
import { RedisRateLimiter } from "./infra/redis/rate-limiter.js";
import { shutdownTelemetry } from "./infra/telemetry/sdk.js";
import { installShutdown } from "./lifecycle/shutdown.js";
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
    return { env, config };
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { env, config } = loadSettings();
  const logger = createLogger({ level: env.LOG_LEVEL });

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

  const http = createUndiciClient(config.server.timeouts);
  const providers = createProviderRegistry(config, process.env, { http });

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

  const app = await buildApp({
    logger,
    checks: [postgresCheck(pool), redisCheck(redis)],
    config,
    providers,
    keyStore: new DrizzleKeyStore(db),
    rateLimiter: new RedisRateLimiter(redis),
    keyPepper: env.KEY_PEPPER,
    adminToken: env.ADMIN_TOKEN,
    usageRecorder: usage,
  });

  installShutdown({
    app,
    closers: [
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

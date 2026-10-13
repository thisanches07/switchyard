import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { ConfigError, formatConfigError } from "./config/errors.js";
import { loadConfig } from "./config/load.js";
import { createDatabase } from "./infra/db/client.js";
import { DrizzleKeyStore } from "./infra/db/key-store.js";
import { migrateDatabase } from "./infra/db/migrate.js";
import { createPostgresPool, postgresCheck } from "./infra/db/postgres.js";
import { createUndiciClient } from "./infra/http/undici-client.js";
import { createLogger } from "./infra/logger.js";
import { createRedisClient, redisCheck } from "./infra/redis/client.js";
import { shutdownTelemetry } from "./infra/telemetry/sdk.js";
import { installShutdown } from "./lifecycle/shutdown.js";
import { createProviderRegistry } from "./modules/providers/registry.js";

function loadSettings() {
  try {
    const env = loadEnv(process.env);
    const config = loadConfig(env.SWITCHYARD_CONFIG, process.env);
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

  const http = createUndiciClient(config.server.timeouts);
  const providers = createProviderRegistry(config, process.env, { http });

  const app = await buildApp({
    logger,
    checks: [postgresCheck(pool), redisCheck(redis)],
    config,
    providers,
    keyStore: new DrizzleKeyStore(db),
    keyPepper: env.KEY_PEPPER,
    adminToken: env.ADMIN_TOKEN,
  });

  installShutdown({
    app,
    closers: [
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

// Usage worker process (spec 006): consumes usage.events.v1, stores events idempotently in
// Postgres, keeps daily aggregates and sets malformed messages aside in the DLQ. Since spec 007
// it also reconciles the Redis budget counters with the stored spend.
import { loadWorkerEnv } from "./config/env.js";
import { ConfigError, formatConfigError } from "./config/errors.js";
import { loadWorkerConfig } from "./config/load.js";
import { DrizzleBudgetStore } from "./infra/db/budget-store.js";
import { createDatabase } from "./infra/db/client.js";
import { createPostgresPool } from "./infra/db/postgres.js";
import { createLogger } from "./infra/logger.js";
import { RedisBudgetCounters } from "./infra/redis/budget-counters.js";
import { createRedisClient } from "./infra/redis/client.js";
import { shutdownTelemetry } from "./infra/telemetry/sdk.js";
import { installShutdown } from "./lifecycle/shutdown.js";
import { createRatioGauge } from "./modules/budgets/gauge.js";
import { startReconciler } from "./modules/budgets/reconcile.js";
import { startUsageWorker, type UsageWorker } from "./usage-worker.js";

function loadSettings() {
  try {
    const env = loadWorkerEnv(process.env);
    const config = loadWorkerConfig(env.SWITCHYARD_CONFIG);
    return { env, ...config };
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { env, usage, budgets } = loadSettings();
  const logger = createLogger({ level: env.LOG_LEVEL });
  const pool = createPostgresPool(env.DATABASE_URL);
  pool.on("error", (error) => logger.warn({ err: error.message }, "postgres pool error"));
  const db = createDatabase(pool);

  // Spec 007: budget reconciliation; Redis may be down at start, the client keeps retrying.
  const redis = createRedisClient(env.REDIS_URL);
  redis.on("error", (error: Error) => logger.debug({ err: error.message }, "redis error"));
  redis.connect().catch(() => {});
  const gauge = createRatioGauge();
  const reconciler = startReconciler({
    store: new DrizzleBudgetStore(db),
    counters: new RedisBudgetCounters(redis, { timeoutMs: 5_000 }),
    gauge,
    intervalMs: budgets.reconcileIntervalSeconds * 1_000,
    logger,
  });

  const starting = new AbortController();
  let worker: UsageWorker | undefined;
  installShutdown({
    app: {
      close: async () => {
        starting.abort();
        await Promise.all([worker?.stop(), reconciler.stop()]);
        gauge.close();
      },
    },
    closers: [
      { name: "redis", close: async () => redis.disconnect() },
      { name: "postgres", close: () => pool.end() },
      { name: "telemetry", close: shutdownTelemetry },
    ],
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger,
  });

  worker = await startUsageWorker({
    brokers: env.KAFKA_BROKERS,
    usage,
    db,
    logger,
    signal: starting.signal,
  });
}

await main();

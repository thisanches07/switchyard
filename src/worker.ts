// Usage worker process (spec 006): consumes usage.events.v1, stores events idempotently in
// Postgres, keeps daily aggregates and sets malformed messages aside in the DLQ.
import { loadWorkerEnv } from "./config/env.js";
import { ConfigError, formatConfigError } from "./config/errors.js";
import { loadUsageConfig } from "./config/load.js";
import { createDatabase } from "./infra/db/client.js";
import { createPostgresPool } from "./infra/db/postgres.js";
import { createLogger } from "./infra/logger.js";
import { shutdownTelemetry } from "./infra/telemetry/sdk.js";
import { installShutdown } from "./lifecycle/shutdown.js";
import { startUsageWorker, type UsageWorker } from "./usage-worker.js";

function loadSettings() {
  try {
    const env = loadWorkerEnv(process.env);
    const usage = loadUsageConfig(env.SWITCHYARD_CONFIG);
    return { env, usage };
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { env, usage } = loadSettings();
  const logger = createLogger({ level: env.LOG_LEVEL });
  const pool = createPostgresPool(env.DATABASE_URL);
  pool.on("error", (error) => logger.warn({ err: error.message }, "postgres pool error"));

  const starting = new AbortController();
  let worker: UsageWorker | undefined;
  installShutdown({
    app: {
      close: async () => {
        starting.abort();
        await worker?.stop();
      },
    },
    closers: [
      { name: "postgres", close: () => pool.end() },
      { name: "telemetry", close: shutdownTelemetry },
    ],
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger,
  });

  worker = await startUsageWorker({
    brokers: env.KAFKA_BROKERS,
    usage,
    db: createDatabase(pool),
    logger,
    signal: starting.signal,
  });
}

await main();

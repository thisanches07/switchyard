import { z } from "zod";
import { ConfigError } from "./errors.js";
import { toConfigIssues } from "./zod-issues.js";

const logLevel = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");
const databaseUrl = z
  .string({ error: "is required" })
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL");
const redisUrl = z
  .string({ error: "is required" })
  .regex(/^rediss?:\/\//, "must be a redis:// URL");
const shutdownTimeoutMs = z.coerce
  .number()
  .int()
  .positive()
  .max(9999, "must be below 10000 to exit within 10 s")
  .default(9000);

/** Comma-separated `host:port` list (spec 006), e.g. `redpanda:9092,other:9092`. */
const splitBrokers = (value: string) =>
  value
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);
const kafkaBrokers = z
  .string({ error: "is required" })
  .refine(
    (value) => {
      const brokers = splitBrokers(value);
      return brokers.length > 0 && brokers.every((b) => /^[^\s:]+:\d{1,5}$/.test(b));
    },
    { message: "must be a comma-separated host:port list" },
  )
  .transform(splitBrokers);

const envSchema = z.object({
  // 0 asks the OS for a free port (used by tests).
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: logLevel,
  SWITCHYARD_CONFIG: z.string().min(1).default("config/switchyard.yaml"),
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  /** Secret mixed into API key hashes (spec 004). Losing it invalidates every key. */
  KEY_PEPPER: z
    .string({ error: "is required" })
    .min(32, "must be at least 32 characters (generate: openssl rand -hex 32)"),
  /** Bearer token for /admin/*; the admin API is disabled when unset. */
  ADMIN_TOKEN: z.string().min(16, "must be at least 16 characters").optional(),
  MIGRATE_ON_BOOT: z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .default("false")
    .transform((value) => value === "true"),
  /** Required when `usage.enabled` is true (checked at boot, spec 006). */
  KAFKA_BROKERS: kafkaBrokers.optional(),
  /** Production (spec 013, AC-4): refuse to start with the dev defaults of docker-compose.yml. */
  SWITCHYARD_REQUIRE_SECRETS: z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .default("false")
    .transform((value) => value === "true"),
  OTEL_SERVICE_NAME: z.string().min(1).default("switchyard-gateway"),
  SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMs,
});

/** The usage worker (spec 006) needs no key pepper or provider settings; Redis since spec 007. */
const workerEnvSchema = z.object({
  LOG_LEVEL: logLevel,
  SWITCHYARD_CONFIG: z.string().min(1).default("config/switchyard.yaml"),
  DATABASE_URL: databaseUrl,
  KAFKA_BROKERS: kafkaBrokers,
  /** Budget reconciliation raises the Redis spend counters (spec 007). */
  REDIS_URL: redisUrl,
  OTEL_SERVICE_NAME: z.string().min(1).default("switchyard-usage-worker"),
  SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMs,
});

export type Env = z.infer<typeof envSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  return parseEnv(envSchema, source);
}

export function loadWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}

function parseEnv<T>(schema: z.ZodType<T>, source: Record<string, string | undefined>): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError("environment", toConfigIssues(result.error));
  }
  return result.data;
}

import { z } from "zod";
import { ConfigError } from "./errors.js";
import { toConfigIssues } from "./zod-issues.js";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  SWITCHYARD_CONFIG: z.string().min(1).default("config/switchyard.yaml"),
  DATABASE_URL: z
    .string({ error: "is required" })
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  REDIS_URL: z.string({ error: "is required" }).regex(/^rediss?:\/\//, "must be a redis:// URL"),
  OTEL_SERVICE_NAME: z.string().min(1).default("switchyard-gateway"),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(9999, "must be below 10000 to exit within 10 s")
    .default(9000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError("environment", toConfigIssues(result.error));
  }
  return result.data;
}

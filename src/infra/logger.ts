import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino";
import { getTraceContext } from "./telemetry/tracing.js";

export interface LoggerConfig {
  level: string;
  /** Defaults to stdout; tests pass an in-memory stream. */
  destination?: DestinationStream;
}

/** Header names that must never reach logs (ADR-0010). */
const REDACTED_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "headers.authorization",
  'headers["x-api-key"]',
];

export function createLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: "[Redacted]" },
    mixin: () => ({ ...getTraceContext() }),
  };
}

export function createLogger({ level, destination }: LoggerConfig): Logger {
  const options = createLoggerOptions(level);
  return destination ? pino(options, destination) : pino(options);
}

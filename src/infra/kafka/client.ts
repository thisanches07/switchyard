import kafkaJavascript, { type KafkaJS } from "@confluentinc/kafka-javascript";
import type { FastifyBaseLogger } from "fastify";

const { Kafka, logLevel } = kafkaJavascript.KafkaJS;

const WARN_INTERVAL_MS = 60_000;

/**
 * Routes librdkafka/KafkaJS-compat logs to pino. A broker outage makes the client log the same
 * connection error every second, so errors and warnings are throttled to one per minute per
 * message; the rest goes to `debug`. Only the library's message is logged, never payloads.
 */
export function kafkaLogger(
  logger: FastifyBaseLogger,
  now: () => number = Date.now,
): KafkaJS.Logger {
  const lastWarned = new Map<string, number>();
  const warn = (message: string) => {
    const key = message.slice(0, 120);
    if (now() - (lastWarned.get(key) ?? Number.NEGATIVE_INFINITY) < WARN_INTERVAL_MS) {
      logger.debug({ kafka: message }, "kafka client");
      return;
    }
    lastWarned.set(key, now());
    logger.warn({ kafka: message }, "kafka client");
  };
  const adapter: KafkaJS.Logger = {
    error: (message) => warn(message),
    warn: (message) => warn(message),
    info: (message) => logger.debug({ kafka: message }, "kafka client"),
    debug: (message) => logger.debug({ kafka: message }, "kafka client"),
    namespace: () => adapter,
    setLogLevel: () => {},
  };
  return adapter;
}

export interface KafkaClientOptions {
  brokers: string[];
  clientId: string;
  logger: FastifyBaseLogger;
}

/** A KafkaJS-compatible client backed by librdkafka (ADR-0007). */
export function createKafka(options: KafkaClientOptions): KafkaJS.Kafka {
  return new Kafka({
    kafkaJS: {
      brokers: options.brokers,
      clientId: options.clientId,
      // Fail a connection attempt quickly; callers retry on their own schedule.
      connectionTimeout: 3_000,
      retry: { retries: 2, initialRetryTime: 300, maxRetryTime: 3_000 },
      logLevel: logLevel.WARN,
      logger: kafkaLogger(options.logger),
    },
  });
}

/**
 * Composition of the usage worker (spec 006): Kafka topics, DLQ producer, batch consumer and the
 * Postgres usage store. `src/worker.ts` is the process entry point; tests start it directly.
 */
import type { FastifyBaseLogger } from "fastify";
import type { UsageConfig } from "./config/schema.js";
import type { UsageStore } from "./core/usage.js";
import type { Database } from "./infra/db/client.js";
import { DrizzleUsageStore } from "./infra/db/usage-store.js";
import { type RunningConsumer, startBatchConsumer } from "./infra/kafka/consumer.js";
import { createKafkaProducer } from "./infra/kafka/producer.js";
import { ensureTopics } from "./infra/kafka/topics.js";
import { processBatch } from "./modules/usage/consume.js";

export const USAGE_CONSUMER_GROUP = "switchyard-usage-worker";

export interface UsageWorkerOptions {
  brokers: string[];
  usage: Pick<UsageConfig, "topic" | "dlqTopic">;
  db: Database;
  logger: FastifyBaseLogger;
  groupId?: string;
  /** Overrides the Postgres store (tests). */
  store?: UsageStore;
  /** Delay between attempts to reach Kafka at startup. */
  startRetryMs?: number;
  /** Backoff after a failed batch. */
  batchRetry?: { initialMs: number; maxMs: number };
  /** Stops the startup retries (shutdown before Kafka was reachable). */
  signal?: AbortSignal;
}

export interface UsageWorker {
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startUsageWorker(options: UsageWorkerOptions): Promise<UsageWorker> {
  const { logger, usage } = options;
  const kafka = { brokers: options.brokers, clientId: "switchyard-usage-worker", logger };
  const groupId = options.groupId ?? USAGE_CONSUMER_GROUP;
  const store = options.store ?? new DrizzleUsageStore(options.db);
  const dlq = createKafkaProducer(kafka);

  // Kafka may still be starting: keep trying instead of crash-looping.
  let consumer: RunningConsumer | undefined;
  for (;;) {
    if (options.signal?.aborted) {
      await dlq.close();
      return { stop: async () => {} };
    }
    try {
      await ensureTopics(kafka, [
        { topic: usage.topic, numPartitions: 3 },
        { topic: usage.dlqTopic, numPartitions: 1 },
      ]);
      consumer = await startBatchConsumer({
        ...kafka,
        topic: usage.topic,
        groupId,
        ...(options.batchRetry ? { retry: options.batchRetry } : {}),
        handle: async (messages) => {
          await processBatch(messages, {
            store,
            producer: dlq,
            dlqTopic: usage.dlqTopic,
            logger,
          });
        },
      });
      break;
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "kafka not reachable, retrying",
      );
      await sleep(options.startRetryMs ?? 5_000);
    }
  }

  logger.info({ topic: usage.topic, dlqTopic: usage.dlqTopic, groupId }, "usage worker started");
  return {
    async stop() {
      await consumer?.stop();
      await dlq.close();
    },
  };
}

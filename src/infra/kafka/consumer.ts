import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { InboundMessage } from "../../core/usage.js";
import { createKafka, type KafkaClientOptions } from "./client.js";

export interface BatchConsumerOptions extends KafkaClientOptions {
  topic: string;
  groupId: string;
  /** Processes one batch; offsets are committed only after it resolves. */
  handle(messages: InboundMessage[]): Promise<void>;
  maxBatchSize?: number;
  /** Backoff after a failed batch: doubles from `initialMs` up to `maxMs`. */
  retry?: { initialMs: number; maxMs: number };
}

export interface RunningConsumer {
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consumes a topic in batches with manual commits (spec 006, AC-9/AC-10): the offset after the
 * last message is committed only once `handle` resolved. When `handle` throws (e.g. Postgres is
 * down), the consumer waits with exponential backoff and rethrows, so the library seeks back and
 * redelivers the same batch; nothing is committed in between.
 */
export async function startBatchConsumer(options: BatchConsumerOptions): Promise<RunningConsumer> {
  const retry = options.retry ?? { initialMs: 500, maxMs: 30_000 };
  const consumer: KafkaJS.Consumer = createKafka(options).consumer({
    "js.consumer.max.batch.size": options.maxBatchSize ?? 100,
    kafkaJS: { groupId: options.groupId, fromBeginning: true, autoCommit: false },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [options.topic] });

  let failures = 0;
  await consumer.run({
    eachBatch: async ({ batch }) => {
      const last = batch.messages.at(-1);
      if (!last) return;
      try {
        await options.handle(
          batch.messages.map((m) => ({
            topic: batch.topic,
            partition: batch.partition,
            offset: m.offset,
            key: m.key ?? null,
            value: m.value ?? null,
          })),
        );
        await consumer.commitOffsets([
          {
            topic: batch.topic,
            partition: batch.partition,
            offset: (BigInt(last.offset) + 1n).toString(),
          },
        ]);
        failures = 0;
      } catch (error) {
        failures += 1;
        const delay = Math.min(retry.maxMs, retry.initialMs * 2 ** (failures - 1));
        options.logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            partition: batch.partition,
            offset: batch.messages[0]?.offset,
            retryInMs: delay,
          },
          "usage batch failed, will retry",
        );
        await sleep(delay);
        throw error;
      }
    },
  });

  return {
    async stop() {
      await consumer.disconnect();
    },
  };
}

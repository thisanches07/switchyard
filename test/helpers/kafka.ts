import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import { RedpandaContainer, type StartedRedpandaContainer } from "@testcontainers/redpanda";
import { createKafka } from "../../src/infra/kafka/client.js";
import { createLogger } from "../../src/infra/logger.js";

/** Same image as docker-compose.yml. */
export const REDPANDA_IMAGE = "redpandadata/redpanda:v26.2.4";

export function startRedpanda(): Promise<StartedRedpandaContainer> {
  return new RedpandaContainer(REDPANDA_IMAGE).start();
}

/** Freezes / resumes a container (simulates a broker that stops answering). */
export function dockerPause(containerId: string, pause: boolean): void {
  const result = spawnSync("docker", [pause ? "pause" : "unpause", containerId], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`docker pause failed: ${result.stderr}`);
}

export interface ConsumedMessage {
  key: string | null;
  value: Buffer | null;
  headers: Record<string, string>;
  partition: number;
  offset: string;
}

/** Reads a topic from the beginning with a throwaway group until `count` messages arrived. */
export async function readTopic(
  brokers: string,
  topic: string,
  count: number,
  timeoutMs = 30_000,
): Promise<ConsumedMessage[]> {
  const kafka = createKafka({
    brokers: [brokers],
    clientId: "test-reader",
    logger: createLogger({ level: "silent" }),
  });
  const consumer: KafkaJS.Consumer = kafka.consumer({
    kafkaJS: { groupId: `test-reader-${randomUUID()}`, fromBeginning: true },
  });
  const messages: ConsumedMessage[] = [];
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [topic] });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.headers ?? {})) {
          if (value !== undefined) headers[name] = String(value);
        }
        messages.push({
          key: message.key ? message.key.toString() : null,
          value: message.value,
          headers,
          partition,
          offset: message.offset,
        });
      },
    });
    const deadline = Date.now() + timeoutMs;
    while (messages.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return messages;
  } finally {
    await consumer.disconnect();
  }
}
